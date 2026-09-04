import { describe, it, expect, vi } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { JobQueue } from '../src/jobs.js';

describe('JobQueue', () => {
  it('runs jobs of one kind sequentially and records status', async () => {
    const db = openDb(':memory:');
    const q = new JobQueue(db);
    const order: string[] = [];
    const a = q.enqueue('index', null, async (ctx) => {
      ctx.progress('half');
      await new Promise((r) => setTimeout(r, 30));
      order.push('a');
      return { n: 1 };
    });
    const b = q.enqueue('index', null, async () => {
      order.push('b');
    });
    expect(db.getJob(a.id)?.status).toBe('running');
    await q.idle();
    expect(order).toEqual(['a', 'b']);
    expect(db.getJob(a.id)?.status).toBe('done');
    expect(db.getJob(a.id)?.result_json).toBe('{"n":1}');
    expect(db.getJob(b.id)?.status).toBe('done');
  });

  it('logs rather than crashing when the queue bookkeeping itself fails', async () => {
    const db = openDb(':memory:');
    const logs: string[] = [];
    const broken = new Proxy(db, {
      get(target, prop, recv) {
        if (prop === 'updateJob') {
          return () => {
            throw new Error('db gone');
          };
        }
        return Reflect.get(target, prop, recv);
      },
    }) as unknown as Db;
    const q = new JobQueue(broken, (m) => logs.push(m));
    q.enqueue('index', null, async () => 'never');
    await q.idle();
    expect(logs.some((l) => l.includes('db gone'))).toBe(true);
  });

  it('marks failures without stopping the queue', async () => {
    const db = openDb(':memory:');
    const q = new JobQueue(db);
    const a = q.enqueue('review', null, async () => {
      throw new Error('boom');
    });
    const b = q.enqueue('review', null, async () => 'ok');
    await q.idle();
    expect(db.getJob(a.id)?.status).toBe('error');
    expect(db.getJob(a.id)?.error).toBe('boom');
    expect(db.getJob(b.id)?.status).toBe('done');
  });
});

describe('JobQueue.schedule', () => {
  it('debounces: the callback runs once, a delay after the last call', () => {
    vi.useFakeTimers();
    try {
      const q = new JobQueue(openDb(':memory:'));
      let runs = 0;
      q.schedule('k', 1000, () => runs++);
      vi.advanceTimersByTime(500);
      q.schedule('k', 1000, () => runs++);
      expect(q.scheduled('k')).toBe(true);
      vi.advanceTimersByTime(900);
      expect(runs).toBe(0);
      vi.advanceTimersByTime(200);
      expect(runs).toBe(1);
      expect(q.scheduled('k')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
