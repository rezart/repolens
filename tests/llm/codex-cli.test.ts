import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { CodexCliProvider } from '../../src/llm/codex-cli.js';
import { ProviderError } from '../../src/llm/types.js';
import type { RunOptions, RunResult } from '../../src/llm/spawn.js';

interface Recorded {
  cmd: string;
  args: string[];
  opts: RunOptions;
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Fake run that behaves like codex: writes `output` to the -o path. */
function fakeRun(opts: { output?: string; result?: Partial<RunResult> } = {}) {
  const calls: Recorded[] = [];
  const run = async (cmd: string, args: string[], runOpts: RunOptions = {}): Promise<RunResult> => {
    calls.push({ cmd, args, opts: runOpts });
    const out = argValue(args, '-o');
    if (opts.output !== undefined && out) fs.writeFileSync(out, opts.output);
    return { stdout: '', stderr: '', code: 0, timedOut: false, ...opts.result };
  };
  return { calls, run };
}

describe('CodexCliProvider', () => {
  it('exposes name, model and concurrency', () => {
    const p = new CodexCliProvider({ model: 'gpt-5', run: fakeRun().run });
    expect(p.name).toBe('codex-cli');
    expect(p.model).toBe('gpt-5');
    expect(p.concurrency).toBe(1);
    expect(new CodexCliProvider({ run: fakeRun().run }).model).toBe('default');
  });

  it('builds the expected argv and returns the output file contents', async () => {
    const f = fakeRun({ output: '  the answer\n' });
    const p = new CodexCliProvider({ model: 'gpt-5', run: f.run, timeoutMs: 4321 });
    const out = await p.complete({ messages: [{ role: 'user', content: 'why?' }] });
    expect(out).toBe('the answer');
    const { cmd, args, opts } = f.calls[0]!;
    expect(cmd).toBe('codex');
    expect(args[0]).toBe('exec');
    expect(args).toContain('--ephemeral');
    expect(args).toContain('--skip-git-repo-check');
    expect(argValue(args, '-s')).toBe('read-only');
    expect(argValue(args, '--color')).toBe('never');
    expect(argValue(args, '-m')).toBe('gpt-5');
    expect(argValue(args, '-C')).toBeTruthy();
    expect(argValue(args, '-o')).toMatch(/out-[a-z0-9]+\.md$/);
    expect(args[args.length - 1]).toBe('-');
    expect(opts.stdin).toBe('why?');
    expect(opts.timeoutMs).toBe(4321);
  });

  it('deletes the output file after reading it', async () => {
    const f = fakeRun({ output: 'x' });
    const p = new CodexCliProvider({ run: f.run });
    await p.complete({ messages: [{ role: 'user', content: 'hi' }] });
    const outFile = argValue(f.calls[0]!.args, '-o')!;
    expect(fs.existsSync(outFile)).toBe(false);
  });

  it('puts the system prompt in stdin ahead of the task', async () => {
    const f = fakeRun({ output: 'ok' });
    const p = new CodexCliProvider({ run: f.run });
    await p.complete({ system: 'be terse', messages: [{ role: 'user', content: 'why?' }] });
    expect(f.calls[0]!.opts.stdin).toBe('# System instructions\nbe terse\n\n# Task\nwhy?');
  });

  it('adds the json instruction in json mode', async () => {
    const f = fakeRun({ output: 'ok' });
    const p = new CodexCliProvider({ run: f.run });
    await p.complete({ messages: [{ role: 'user', content: 'why?' }], json: true });
    expect(f.calls[0]!.opts.stdin).toBe(
      '# System instructions\nRespond with a single JSON object and nothing else.\n\n# Task\nwhy?',
    );
  });

  it('flattens a multi-turn conversation into the task section', async () => {
    const f = fakeRun({ output: 'ok' });
    const p = new CodexCliProvider({ run: f.run });
    await p.complete({
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ],
    });
    expect(f.calls[0]!.opts.stdin).toBe('### User:\na\n\n### Assistant:\nb\n\n### User:\nc\n\n### Assistant:');
  });

  it('omits -m when no model is set and honours a custom bin/cwd', async () => {
    const f = fakeRun({ output: 'ok' });
    const p = new CodexCliProvider({ bin: '/opt/codex', cwd: process.cwd(), run: f.run });
    await p.complete({ messages: [{ role: 'user', content: 'hi' }] });
    const { cmd, args } = f.calls[0]!;
    expect(cmd).toBe('/opt/codex');
    expect(args).not.toContain('-m');
    expect(argValue(args, '-C')).toBe(process.cwd());
  });

  it('throws on a non-zero exit code', async () => {
    const f = fakeRun({ output: 'ignored', result: { code: 1, stderr: 'kaboom' } });
    const p = new CodexCliProvider({ run: f.run });
    const err = await p.complete({ messages: [{ role: 'user', content: 'hi' }] }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).provider).toBe('codex-cli');
    expect((err as ProviderError).detail).toContain('kaboom');
  });

  it('throws when the output file was never written', async () => {
    const f = fakeRun({});
    const p = new CodexCliProvider({ run: f.run });
    await expect(p.complete({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toBeInstanceOf(ProviderError);
  });

  it('throws when the output file is empty', async () => {
    const f = fakeRun({ output: '   \n' });
    const p = new CodexCliProvider({ run: f.run });
    await expect(p.complete({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toBeInstanceOf(ProviderError);
  });

  it('throws when the process timed out', async () => {
    const f = fakeRun({ output: 'ok', result: { code: null, timedOut: true } });
    const p = new CodexCliProvider({ run: f.run });
    await expect(p.complete({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/timed out/i);
  });

  it('runs calls one at a time', async () => {
    let active = 0;
    let maxActive = 0;
    const run = async (_cmd: string, args: string[]): Promise<RunResult> => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      fs.writeFileSync(argValue(args, '-o')!, 'ok');
      return { stdout: '', stderr: '', code: 0, timedOut: false };
    };
    const p = new CodexCliProvider({ run });
    const outs = await Promise.all([
      p.complete({ messages: [{ role: 'user', content: 'a' }] }),
      p.complete({ messages: [{ role: 'user', content: 'b' }] }),
    ]);
    expect(outs).toEqual(['ok', 'ok']);
    expect(maxActive).toBe(1);
  });
});
