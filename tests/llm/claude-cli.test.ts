import { describe, it, expect } from 'vitest';
import { ClaudeCliProvider, flattenMessages } from '../../src/llm/claude-cli.js';
import { ProviderError } from '../../src/llm/types.js';
import type { RunOptions, RunResult } from '../../src/llm/spawn.js';

interface Recorded {
  cmd: string;
  args: string[];
  opts: RunOptions;
}

function fakeRun(result: Partial<RunResult>) {
  const calls: Recorded[] = [];
  const run = async (cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> => {
    calls.push({ cmd, args, opts });
    return { stdout: '', stderr: '', code: 0, timedOut: false, ...result };
  };
  return { calls, run };
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const okStdout = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'the answer' });

describe('flattenMessages', () => {
  it('returns a lone user message verbatim', () => {
    expect(flattenMessages([{ role: 'user', content: 'just this' }])).toBe('just this');
  });

  it('renders a transcript when there is more than one turn', () => {
    const out = flattenMessages([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ]);
    expect(out).toBe('### User:\nfirst\n\n### Assistant:\nreply\n\n### User:\nsecond\n\n### Assistant:');
  });

  it('renders a transcript for two user messages', () => {
    const out = flattenMessages([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ]);
    expect(out).toBe('### User:\na\n\n### User:\nb\n\n### Assistant:');
  });
});

describe('ClaudeCliProvider', () => {
  it('exposes name, model and concurrency', () => {
    const p = new ClaudeCliProvider({ model: 'sonnet', run: fakeRun({}).run });
    expect(p.name).toBe('claude-cli');
    expect(p.model).toBe('sonnet');
    expect(p.concurrency).toBe(1);
    expect(new ClaudeCliProvider({ run: fakeRun({}).run }).model).toBe('default');
  });

  it('builds the expected argv and sends the prompt on stdin', async () => {
    const f = fakeRun({ stdout: okStdout });
    const p = new ClaudeCliProvider({ model: 'sonnet', run: f.run, timeoutMs: 1234 });
    const out = await p.complete({ system: 'be terse', messages: [{ role: 'user', content: 'why?' }] });
    expect(out).toBe('the answer');
    expect(f.calls).toHaveLength(1);
    const { cmd, args, opts } = f.calls[0]!;
    expect(cmd).toBe('claude');
    expect(args).toContain('-p');
    expect(argValue(args, '--output-format')).toBe('json');
    expect(argValue(args, '--tools')).toBe('');
    expect(args).not.toContain('--bare');
    expect(args).toContain('--no-session-persistence');
    expect(argValue(args, '--permission-mode')).toBe('dontAsk');
    expect(argValue(args, '--model')).toBe('sonnet');
    expect(argValue(args, '--system-prompt')).toBe('be terse');
    expect(opts.stdin).toBe('why?');
    expect(opts.timeoutMs).toBe(1234);
    expect(opts.cwd).toBeTruthy();
  });

  it('uses a custom bin and cwd, and omits --model when unset', async () => {
    const f = fakeRun({ stdout: okStdout });
    const p = new ClaudeCliProvider({ bin: '/usr/local/bin/claude', cwd: '/tmp/x', run: f.run });
    await p.complete({ messages: [{ role: 'user', content: 'hi' }] });
    const { cmd, args, opts } = f.calls[0]!;
    expect(cmd).toBe('/usr/local/bin/claude');
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--system-prompt');
    expect(opts.cwd).toBe('/tmp/x');
  });

  it('adds the json instruction to the system prompt in json mode', async () => {
    const f = fakeRun({ stdout: okStdout });
    const p = new ClaudeCliProvider({ run: f.run });
    await p.complete({ system: 'be terse', messages: [{ role: 'user', content: 'hi' }], json: true });
    expect(argValue(f.calls[0]!.args, '--system-prompt')).toBe(
      'be terse\n\nRespond with a single JSON object and nothing else.',
    );
  });

  it('creates a system prompt in json mode when none was given', async () => {
    const f = fakeRun({ stdout: okStdout });
    const p = new ClaudeCliProvider({ run: f.run });
    await p.complete({ messages: [{ role: 'user', content: 'hi' }], json: true });
    expect(argValue(f.calls[0]!.args, '--system-prompt')).toBe('Respond with a single JSON object and nothing else.');
  });

  it('throws on a non-zero exit code', async () => {
    const f = fakeRun({ code: 2, stderr: 'boom' });
    const p = new ClaudeCliProvider({ run: f.run });
    const err = await p.complete({ messages: [{ role: 'user', content: 'hi' }] }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).provider).toBe('claude-cli');
    expect((err as ProviderError).detail).toContain('boom');
  });

  it('throws when the process timed out', async () => {
    const f = fakeRun({ code: null, timedOut: true });
    const p = new ClaudeCliProvider({ run: f.run });
    await expect(p.complete({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/timed out/i);
  });

  it('throws when the CLI reports is_error', async () => {
    const f = fakeRun({ stdout: JSON.stringify({ is_error: true, subtype: 'error_max_turns', result: 'nope' }) });
    const p = new ClaudeCliProvider({ run: f.run });
    await expect(p.complete({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toBeInstanceOf(ProviderError);
  });

  it('throws when stdout is not json', async () => {
    const f = fakeRun({ stdout: 'command not found: claude' });
    const p = new ClaudeCliProvider({ run: f.run });
    await expect(p.complete({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/command not found/);
  });

  it('runs calls one at a time', async () => {
    let active = 0;
    let maxActive = 0;
    const run = async (): Promise<RunResult> => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { stdout: okStdout, stderr: '', code: 0, timedOut: false };
    };
    const p = new ClaudeCliProvider({ run });
    await Promise.all([
      p.complete({ messages: [{ role: 'user', content: 'a' }] }),
      p.complete({ messages: [{ role: 'user', content: 'b' }] }),
      p.complete({ messages: [{ role: 'user', content: 'c' }] }),
    ]);
    expect(maxActive).toBe(1);
  });
});
