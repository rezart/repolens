import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
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
