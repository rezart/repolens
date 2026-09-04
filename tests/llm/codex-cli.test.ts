import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { CodexCliProvider } from '../../src/llm/codex-cli.js';
import { ProviderError } from '../../src/llm/types.js';
import type { RunOptions, RunResult } from '../../src/llm/spawn.js';
import type { UsageRecord } from '../../src/usage/types.js';

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
    const res = { stdout: '', stderr: '', code: 0, timedOut: false, ...opts.result };
    if (runOpts.onStdout && res.stdout) {
      for (let i = 0; i < res.stdout.length; i += 11) runOpts.onStdout(res.stdout.slice(i, i + 11));
    }
    return res;
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
    // `--json` makes codex emit the NDJSON event stream that carries token usage.
    expect(args.indexOf('--json')).toBe(args.indexOf('--color') + 2);
    expect(args.indexOf('--json')).toBeLessThan(args.indexOf('-C'));
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

describe('CodexCliProvider.stream', () => {
  it('emits the final answer as a single delta', async () => {
    const f = fakeRun({ output: 'the answer\n' });
    const p = new CodexCliProvider({ run: f.run });
    const deltas: string[] = [];
    const out = await p.stream({ messages: [{ role: 'user', content: 'hi' }] }, (t) => deltas.push(t));

    expect(deltas).toEqual(['the answer']);
    expect(out).toBe('the answer');
  });

  it('never forwards intermediate agent messages from the NDJSON', async () => {
    // Codex reports whole assistant turns, and the intermediate ones are absent
    // from the final `-o` file: forwarding them would show text that is not part
    // of the answer.
    const ndjson = [
      JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'let me look…' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'the answer' } }),
    ].join('\n') + '\n';
    const f = fakeRun({ output: 'the answer', result: { stdout: ndjson } });
    const p = new CodexCliProvider({ run: f.run });
    const deltas: string[] = [];
    await p.stream({ messages: [{ role: 'user', content: 'hi' }] }, (t) => deltas.push(t));
    expect(deltas).toEqual(['the answer']);
  });

});

describe('CodexCliProvider reasoning effort', () => {
  it('passes model_reasoning_effort as a quoted TOML string', async () => {
    const f = fakeRun({ output: 'x' });
    const p = new CodexCliProvider({ run: f.run, reasoningEffort: 'medium' });
    await p.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(f.calls[0]!.args).toContain('-c');
    expect(f.calls[0]!.args).toContain('model_reasoning_effort="medium"');
  });

  it('omits the config override when blank', async () => {
    const f = fakeRun({ output: 'x' });
    const p = new CodexCliProvider({ run: f.run, reasoningEffort: '' });
    await p.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(f.calls[0]!.args.some((a) => a.startsWith('model_reasoning_effort'))).toBe(false);
  });
});

describe('CodexCliProvider usage', () => {
  /** The shape of a real `codex exec --json` run captured on 2026-09-04. */
  const ndjson =
    [
      JSON.stringify({ type: 'thread.started', thread_id: '01a06d3a-0000-0000-0000-000000000000' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'turn.completed',
        usage: {
          input_tokens: 18114,
          cached_input_tokens: 15104,
          output_tokens: 97,
          reasoning_output_tokens: 90,
        },
      }),
    ].join('\n') + '\n';

  it('reports normalised usage from the turn.completed event', async () => {
    const f = fakeRun({ output: 'the answer', result: { stdout: ndjson } });
    const seen: UsageRecord[] = [];
    const p = new CodexCliProvider({ model: 'gpt-5', run: f.run, onUsage: (r) => seen.push(r) });
    await p.complete({ messages: [{ role: 'user', content: 'hi' }] });

    // input_tokens includes the cached ones, so the fresh input is the difference.
    expect(seen).toEqual([
      {
        provider: 'codex-cli',
        model: 'gpt-5',
        inputTokens: 3010,
        cachedInputTokens: 15104,
        cacheWriteTokens: 0,
        outputTokens: 97,
        costUsd: null,
      },
    ]);
  });

  it('reports usage for a streaming call too', async () => {
    const f = fakeRun({ output: 'the answer', result: { stdout: ndjson } });
    const seen: UsageRecord[] = [];
    const p = new CodexCliProvider({ model: 'gpt-5', run: f.run, onUsage: (r) => seen.push(r) });
    await p.stream({ messages: [{ role: 'user', content: 'hi' }] }, () => {});
    expect(seen).toHaveLength(1);
    expect(seen[0]!.outputTokens).toBe(97);
  });

  it('uses the last turn.completed when the run reports several', async () => {
    const stdout =
      [
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 1 } }),
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 40, cached_input_tokens: 10, output_tokens: 5 } }),
      ].join('\n') + '\n';
    const f = fakeRun({ output: 'x', result: { stdout } });
    const seen: UsageRecord[] = [];
    const p = new CodexCliProvider({ run: f.run, onUsage: (r) => seen.push(r) });
    await p.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(seen).toEqual([
      {
        provider: 'codex-cli',
        model: 'default',
        inputTokens: 30,
        cachedInputTokens: 10,
        cacheWriteTokens: 0,
        outputTokens: 5,
        costUsd: null,
      },
    ]);
  });

  it('reports nothing when stdout carries no turn.completed event', async () => {
    const stdout =
      [
        '[2026-09-04T12:00:00] loading config…',
        JSON.stringify({ type: 'thread.started', thread_id: 'abc' }),
        JSON.stringify({ type: 'turn.started' }),
      ].join('\n') + '\n';
    const f = fakeRun({ output: 'the answer', result: { stdout } });
    const seen: UsageRecord[] = [];
    const p = new CodexCliProvider({ run: f.run, onUsage: (r) => seen.push(r) });
    await p.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(seen).toEqual([]);
  });

  it('reports nothing when the usage counts are not numbers', async () => {
    const stdout = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: '12', output_tokens: 3 } }) + '\n';
    const f = fakeRun({ output: 'x', result: { stdout } });
    const seen: UsageRecord[] = [];
    const p = new CodexCliProvider({ run: f.run, onUsage: (r) => seen.push(r) });
    await p.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(seen).toEqual([]);
  });

  it('reports nothing when the run failed', async () => {
    const f = fakeRun({ output: 'ignored', result: { code: 1, stderr: 'kaboom', stdout: ndjson } });
    const seen: UsageRecord[] = [];
    const p = new CodexCliProvider({ run: f.run, onUsage: (r) => seen.push(r) });
    await expect(p.complete({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toBeInstanceOf(ProviderError);
    expect(seen).toEqual([]);
  });

  it('survives a sink that throws', async () => {
    const f = fakeRun({ output: 'the answer', result: { stdout: ndjson } });
    const p = new CodexCliProvider({
      run: f.run,
      onUsage: () => {
        throw new Error('sink exploded');
      },
    });
    await expect(p.complete({ messages: [{ role: 'user', content: 'hi' }] })).resolves.toBe('the answer');
  });
});
