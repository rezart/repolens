import { describe, it, expect } from 'vitest';
import { runProcess, Semaphore, childEnv, lineSplitter } from '../../src/llm/spawn.js';

describe('runProcess', () => {
  it('resolves when the child exits before reading a large stdin (EPIPE)', async () => {
    const big = 'x'.repeat(200 * 1024);
    const res = await runProcess(process.execPath, ['-e', 'process.exit(1)'], { stdin: big });
    expect(res.code).toBe(1);
    expect(res.timedOut).toBe(false);
  });

  it('forwards stdout chunks to onStdout while still buffering them', async () => {
    const chunks: string[] = [];
    const res = await runProcess(
      process.execPath,
      ['-e', 'process.stdout.write("one\\n");setTimeout(()=>process.stdout.write("two\\n"),10)'],
      { onStdout: (c) => chunks.push(c) },
    );
    expect(chunks.join('')).toBe('one\ntwo\n');
    expect(res.stdout).toBe('one\ntwo\n');
  });

  it('survives a throwing onStdout consumer', async () => {
    const res = await runProcess(process.execPath, ['-e', 'process.stdout.write("x")'], {
      onStdout: () => {
        throw new Error('consumer blew up');
      },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('x');
  });

  it('captures stdout and stderr', async () => {
    const res = await runProcess(process.execPath, ['-e', 'process.stdout.write("out");process.stderr.write("err")']);
    expect(res.stdout).toBe('out');
    expect(res.stderr).toBe('err');
    expect(res.code).toBe(0);
  });
});

describe('Semaphore', () => {
  it('never exceeds the limit even when releases and acquires interleave', async () => {
    const sem = new Semaphore(1);
    let concurrent = 0;
    let max = 0;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        sem.run(async () => {
          concurrent++;
          max = Math.max(max, concurrent);
          await new Promise((r) => setTimeout(r, 0));
          await new Promise((r) => setTimeout(r, 0));
          concurrent--;
        }),
      ),
    );
    expect(max).toBe(1);
  });

  it('hands a released slot to the queued waiter, not to a later acquirer', async () => {
    const sem = new Semaphore(1);
    const order: string[] = [];
    const held = await sem.acquire();
    const queued = sem.acquire().then((r) => {
      order.push('queued');
      return r;
    });
    held(); // releases; the slot must go to `queued`
    const later = sem.acquire().then((r) => {
      order.push('later');
      return r;
    });
    const releaseQueued = await queued;
    expect(order).toEqual(['queued']);
    releaseQueued();
    (await later)();
    expect(order).toEqual(['queued', 'later']);
  });

  it('allows up to `limit` in parallel', async () => {
    const sem = new Semaphore(3);
    let concurrent = 0;
    let max = 0;
    await Promise.all(
      Array.from({ length: 12 }, () =>
        sem.run(async () => {
          concurrent++;
          max = Math.max(max, concurrent);
          await new Promise((r) => setTimeout(r, 1));
          concurrent--;
        }),
      ),
    );
    expect(max).toBe(3);
  });

  it('releases the slot when the task throws', async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await sem.run(async () => 'ok')).toBe('ok');
  });
});

describe('childEnv', () => {
  it('strips nested-session markers', () => {
    const env = childEnv({ PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_X: '1', CLAUDE_PID: '2', CLAUDE_EFFORT: 'high' });
    expect(env).toEqual({ PATH: '/bin' });
  });
});

describe('lineSplitter', () => {
  it('reassembles lines split across chunk boundaries', () => {
    const lines: string[] = [];
    const s = lineSplitter((l) => lines.push(l));
    s.push('{"a":1}\n{"b":');
    expect(lines).toEqual(['{"a":1}']);
    s.push('2}\n{"c":3}');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    s.flush();
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it('skips blank lines and flushes nothing when the buffer is empty', () => {
    const lines: string[] = [];
    const s = lineSplitter((l) => lines.push(l));
    s.push('\n\n  \n');
    s.flush();
    expect(lines).toEqual([]);
  });
});
