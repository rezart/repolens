import { describe, it, expect } from 'vitest';
import { openDb, type Db, type UsageInsert } from '../../src/db.js';
import { OpenRouterPricing } from '../../src/usage/pricing.js';
import { UsageTracker } from '../../src/usage/tracker.js';
import { reviewCallCost } from '../../src/usage/review-cost.js';

const DAY = 86_400_000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A /models body with just the model the codex-cli rows below are billed as. */
const modelsBody = {
  data: [
    {
      id: 'openai/gpt-5.6-terra',
      pricing: { prompt: '0.000002', completion: '0.000012', input_cache_read: '0.0000002' },
    },
  ],
};

describe('UsageTracker.sinkFor', () => {
  it('records one row per call under the role it was built for', () => {
    const db = openDb(':memory:');
    const tracker = new UsageTracker({ db, pricing: null });

    tracker.sinkFor('review')({
      provider: 'claude-cli',
      model: 'claude-haiku-4-5',
      inputTokens: 10,
      cachedInputTokens: 200,
      cacheWriteTokens: 30,
      outputTokens: 4,
      costUsd: null,
    });

    const rows = db.usageByDay('1970-01-01');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: 'review',
      provider: 'claude-cli',
      model: 'claude-haiku-4-5',
      calls: 1,
      input_tokens: 10,
      cached_input_tokens: 200,
      cache_write_tokens: 30,
      output_tokens: 4,
      reported_cost_usd: 0,
      unpriced_calls: 1,
    });
    db.close();
  });

  it('logs and swallows a storage failure rather than breaking the call being billed', () => {
    const db = openDb(':memory:');
    db.insertUsage = () => {
      throw new Error('disk full');
    };
    const logs: string[] = [];
    const tracker = new UsageTracker({ db, pricing: null, log: (m) => logs.push(m) });

    expect(() =>
      tracker.sinkFor('embed')({
        provider: 'embeddings',
        model: 'text-embedding-3-small',
        inputTokens: 5,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        costUsd: null,
      }),
    ).not.toThrow();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('embed');
    expect(logs[0]).toContain('disk full');
    db.close();
  });
});

describe('UsageTracker.sinkFor durable review usage', () => {
  const record = { provider: 'openrouter', model: 'qwen/qwen3-coder', inputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 2, costUsd: 0.01 };
  const attempt = (attemptId?: string, usageSeq?: number) => ({ reported: false, costUsd: 0 as number | null, stage: 'initial', pass: 'normal', ...(attemptId ? { attemptId } : {}), ...(usageSeq !== undefined ? { usageSeq } : {}) });

  /** Minimal test double over the real Db: swap in a durable sink and observe it. */
  function dbWithDurable(handle: (attemptId: string, seq: number, row: UsageInsert) => void): Db {
    const db = openDb(':memory:');
    db.recordReviewCallUsage = handle;
    return db;
  }

  it('persists each event durably with its own sequence when an attempt is active', () => {
    const durable: Array<{ attemptId: string; seq: number; row: UsageInsert }> = [];
    const db = dbWithDurable((attemptId, seq, row) => { durable.push({ attemptId, seq, row }); });
    const tracker = new UsageTracker({ db, pricing: null });

    reviewCallCost.run(attempt('attempt-1'), () => {
      const sink = tracker.sinkFor('review');
      sink({ ...record });
      sink({ ...record, costUsd: 0.02 });
    });

    expect(durable.map((row) => row.seq)).toEqual([0, 1]);
    expect(new Set(durable.map((row) => row.attemptId))).toEqual(new Set(['attempt-1']));
    expect(durable[0]!.row).toMatchObject({ role: 'review', provider: record.provider, model: record.model, cost_usd: 0.01 });
    // Ordinary rows must not be written alongside the durable ones.
    expect(db.usageByDay('1970-01-01')).toHaveLength(0);
    db.close();
  });

  it('consumes the sequence of a failed write and keeps billing, so resume cannot double-count', () => {
    const durable: Array<{ seq: number }> = [];
    let writes = 0;
    const db = dbWithDurable((_attemptId, seq) => {
      writes++;
      if (writes === 2) throw new Error('disk full');
      durable.push({ seq });
    });
    const logs: string[] = [];
    const tracker = new UsageTracker({ db, pricing: null, log: (m) => logs.push(m) });

    const failure = reviewCallCost.run(attempt('attempt-2'), () => {
      const sink = tracker.sinkFor('review');
      sink({ ...record });
      sink({ ...record });
      sink({ ...record });
    });
    expect(failure).toBeUndefined(); // billing never breaks the call itself
    expect(logs.some((m) => m.includes('disk full'))).toBe(true);
    // seq 1 was consumed by the failed write; the third event took seq 2.
    expect(durable.map((row) => row.seq)).toEqual([0, 2]);
    db.close();
  });

  it('keeps the ordinary path when no attempt is active, even inside a stale attempt context', () => {
    let durable = 0;
    const db = dbWithDurable(() => { durable++; });
    const tracker = new UsageTracker({ db, pricing: null });

    // No attemptId in the store: durable path must not trigger.
    reviewCallCost.run({ reported: false, costUsd: 0, stage: 'initial', pass: 'normal' }, () => {
      tracker.sinkFor('review')({ ...record });
    });
    // Chat never uses the durable path even with an attempt present.
    reviewCallCost.run(attempt('attempt-3'), () => {
      tracker.sinkFor('chat')({ ...record });
    });

    expect(durable).toBe(0);
    expect(db.usageByDay('1970-01-01').map((row) => row.role).sort()).toEqual(['chat', 'review']);
    db.close();
  });
});

describe('UsageTracker.report', () => {
  it('leaves unpriced rows unpriced when there is no price list, and passes reported costs through', async () => {
    const db = openDb(':memory:');
    const tracker = new UsageTracker({ db, pricing: null });
    tracker.sinkFor('review')({
      provider: 'claude-cli',
      model: 'claude-haiku-4-5',
      inputTokens: 100,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 10,
      costUsd: null,
    });
    tracker.sinkFor('chat')({
      provider: 'openrouter',
      model: 'anthropic/claude-haiku-4.5',
      inputTokens: 40,
      cachedInputTokens: 8,
      cacheWriteTokens: 0,
      outputTokens: 6,
      costUsd: 0.0125,
    });

    const report = await tracker.report(7);
    expect(report.days).toBe(7);
    expect(report.since).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(report.pricing).toEqual({ fetchedAt: null, error: 'pricing disabled' });

    const byRole = new Map(report.rows.map((r) => [r.role, r]));
    expect(byRole.get('review')).toMatchObject({
      provider: 'claude-cli',
      model: 'claude-haiku-4-5',
      calls: 1,
      inputTokens: 100,
      outputTokens: 10,
      reportedCostUsd: 0,
      estimatedCostUsd: null,
      costUsd: null,
      priced: false,
    });
    expect(byRole.get('chat')).toMatchObject({
      provider: 'openrouter',
      calls: 1,
      inputTokens: 40,
      cachedInputTokens: 8,
      reportedCostUsd: 0.0125,
      estimatedCostUsd: 0,
      costUsd: 0.0125,
      priced: true,
    });
    db.close();
  });

  it('estimates unpriced tokens at list price and adds them to the reported cost in the same row', async () => {
    const db = openDb(':memory:');
    const pricing = new OpenRouterPricing({
      db,
      baseUrl: 'http://local/v1',
      fetch: (async () => jsonResponse(modelsBody)) as unknown as typeof fetch,
      now: () => Date.parse('2026-01-01T00:00:00.000Z'),
    });
    const tracker = new UsageTracker({ db, pricing });
    const sink = tracker.sinkFor('review');
    // Same day/role/provider/model, so both calls land in one row.
    sink({
      provider: 'codex-cli',
      model: 'gpt-5.6-terra',
      inputTokens: 1000,
      cachedInputTokens: 500,
      cacheWriteTokens: 0,
      outputTokens: 100,
      costUsd: null,
    });
    sink({
      provider: 'codex-cli',
      model: 'gpt-5.6-terra',
      inputTokens: 10,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1,
      costUsd: 0.5,
    });

    const report = await tracker.report(30);
    expect(report.pricing).toEqual({ fetchedAt: '2026-01-01T00:00:00.000Z', error: null });
    expect(report.rows).toHaveLength(1);
    const row = report.rows[0]!;
    // 1000 * 2e-6 + 500 * 2e-7 + 100 * 12e-6
    const estimate = 0.002 + 0.0001 + 0.0012;
    expect(row.calls).toBe(2);
    expect(row.reportedCostUsd).toBeCloseTo(0.5, 12);
    expect(row.estimatedCostUsd).toBeCloseTo(estimate, 12);
    expect(row.costUsd).toBeCloseTo(0.5 + estimate, 12);
    expect(row.priced).toBe(true);
    db.close();
  });

  it('leaves a row unpriced when the model is absent from the list', async () => {
    const db = openDb(':memory:');
    const pricing = new OpenRouterPricing({
      db,
      baseUrl: 'http://local/v1',
      fetch: (async () => jsonResponse(modelsBody)) as unknown as typeof fetch,
    });
    const tracker = new UsageTracker({ db, pricing });
    tracker.sinkFor('chat')({
      provider: 'codex-cli',
      model: 'gpt-5.6-nowhere',
      inputTokens: 100,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 10,
      costUsd: null,
    });

    const report = await tracker.report(30);
    expect(report.rows[0]).toMatchObject({ estimatedCostUsd: null, costUsd: null, priced: false });
    db.close();
  });

  it('still reports rows when the price list cannot be fetched at all', async () => {
    const db = openDb(':memory:');
    const pricing = new OpenRouterPricing({
      db,
      baseUrl: 'http://local/v1',
      fetch: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    const tracker = new UsageTracker({ db, pricing });
    tracker.sinkFor('review')({
      provider: 'codex-cli',
      model: 'gpt-5.6-terra',
      inputTokens: 100,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 10,
      costUsd: null,
    });

    const report = await tracker.report(30);
    expect(report.pricing.fetchedAt).toBeNull();
    expect(report.pricing.error).toContain('ECONNREFUSED');
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      provider: 'codex-cli',
      calls: 1,
      inputTokens: 100,
      outputTokens: 10,
      estimatedCostUsd: null,
      costUsd: null,
      priced: false,
    });
    db.close();
  });

  it('keeps a free reported call visible as $0 next to an unpriceable one', async () => {
    const db = openDb(':memory:');
    const tracker = new UsageTracker({ db, pricing: null });
    const sink = tracker.sinkFor('chat');
    sink({ provider: 'openrouter', model: 'free/model', inputTokens: 5, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 5, costUsd: 0 });
    sink({ provider: 'openrouter', model: 'free/model', inputTokens: 5, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 5, costUsd: null });
    const [row] = (await tracker.report(1)).rows;
    // One call was priced (at zero) by its backend, so the row has a cost; the
    // other could not be priced, so that cost is a floor.
    expect(row).toMatchObject({ calls: 2, reportedCostUsd: 0, costUsd: 0, estimatedCostUsd: null, priced: false });
    db.close();
  });

  it('windows rows by the injected clock', async () => {
    const db = openDb(':memory:');
    const now = Date.parse('2026-03-10T12:00:00.000Z');
    const tracker = new UsageTracker({ db, pricing: null, now: () => now });
    const sink = tracker.sinkFor('review');
    sink({ provider: 'claude-cli', model: 'sonnet', inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1, costUsd: null });
    sink({ provider: 'claude-cli', model: 'opus', inputTokens: 2, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 2, costUsd: null });

    // Backdate the second call to well before the window.
    const ids = db.raw.prepare('select id, model from llm_usage order by id').all() as Array<{ id: number; model: string }>;
    const old = ids.find((r) => r.model === 'opus')!;
    db.raw.prepare('update llm_usage set ts=? where id=?').run('2026-01-01T00:00:00.000Z', old.id);
    // The kept call is dated inside the window.
    const recent = ids.find((r) => r.model === 'sonnet')!;
    db.raw.prepare('update llm_usage set ts=? where id=?').run('2026-03-09T00:00:00.000Z', recent.id);

    const report = await tracker.report(7);
    expect(report.since).toBe('2026-03-04T00:00:00.000Z');
    expect(report.rows.map((r) => r.model)).toEqual(['sonnet']);
    expect(report.rows[0]!.day).toBe('2026-03-09');
    db.close();
  });

  it('covers `days` whole UTC days ending today, so the oldest day is never partial', async () => {
    const db = openDb(':memory:');
    const now = Date.parse('2026-03-10T12:00:00.000Z');
    const tracker = new UsageTracker({ db, pricing: null, now: () => now });
    const sink = tracker.sinkFor('review');
    sink({ provider: 'claude-cli', model: 'inside', inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1, costUsd: null });
    sink({ provider: 'claude-cli', model: 'outside', inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1, costUsd: null });

    const ids = db.raw.prepare('select id, model from llm_usage order by id').all() as Array<{ id: number; model: string }>;
    const at = (model: string, ts: string) =>
      db.raw.prepare('update llm_usage set ts=? where id=?').run(ts, ids.find((r) => r.model === model)!.id);
    // A 7-day window at 2026-03-10T12:00Z opens at 2026-03-04T00:00Z: the first
    // moment of that day is in, the last moment of the day before is out.
    at('inside', '2026-03-04T00:00:00.000Z');
    at('outside', '2026-03-03T23:59:59.999Z');

    const report = await tracker.report(7);
    expect(report.rows.map((r) => r.model)).toEqual(['inside']);
    db.close();
  });
});
