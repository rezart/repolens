import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db.js';
import { OpenRouterPricing, candidateIds } from '../../src/usage/pricing.js';
import type { PriceList } from '../../src/usage/pricing.js';

interface Call {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A fetch that hands out canned outcomes in order; a thrown Error simulates a network failure. */
function fakeFetch(outcomes: Array<Response | Error>) {
  const calls: Call[] = [];
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = outcomes.shift();
    if (!next) throw new Error('unexpected extra fetch call');
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, fetch: fn as unknown as typeof fetch };
}

const modelsBody = {
  data: [
    {
      id: 'anthropic/claude-sonnet-4.5',
      pricing: {
        prompt: '0.000003',
        completion: '0.000015',
        input_cache_read: '0.0000003',
        input_cache_write: '0.00000375',
        image: '0.0048', // an extra key we ignore
      },
    },
    // No cache prices: both fall back to prompt.
    { id: 'openai/gpt-5', pricing: { prompt: '0.00000125', completion: '0.00001' } },
    // Non-numeric cache prices: same fallback.
    {
      id: 'openai/text-embedding-3-small',
      pricing: { prompt: '0.00000002', completion: '0', input_cache_read: '', input_cache_write: 'n/a' },
    },
    { id: 'broken/no-completion', pricing: { prompt: '0.000001' } },
    { id: 'broken/bad-prompt', pricing: { prompt: 'free', completion: '0.000002' } },
    { id: 42, pricing: { prompt: '0.000001', completion: '0.000002' } },
    { pricing: { prompt: '0.000001', completion: '0.000002' } },
    { id: 'broken/no-pricing' },
    // Should the API ever send bare numbers instead of decimal strings.
    { id: 'numeric/prices', pricing: { prompt: 4e-6, completion: 8e-6 } },
  ],
};

const HOUR = 3_600_000;

describe('OpenRouterPricing.ensure', () => {
  it('fetches the public model list and parses prices with cache fallbacks', async () => {
    const db = openDb(':memory:');
    const f = fakeFetch([jsonResponse(modelsBody)]);
    const p = new OpenRouterPricing({
      db,
      baseUrl: 'https://openrouter.ai/api/v1/',
      fetch: f.fetch,
      now: () => Date.parse('2026-01-01T00:00:00.000Z'),
    });

    const { list, error } = await p.ensure();
    expect(error).toBeNull();
    expect(list).not.toBeNull();
    expect(list!.fetchedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(list!.models['anthropic/claude-sonnet-4.5']).toEqual({
      prompt: 3e-6,
      completion: 15e-6,
      inputCacheRead: 3e-7,
      inputCacheWrite: 3.75e-6,
    });
    // Missing cache prices fall back to the prompt price.
    expect(list!.models['openai/gpt-5']).toEqual({
      prompt: 1.25e-6,
      completion: 1e-5,
      inputCacheRead: 1.25e-6,
      inputCacheWrite: 1.25e-6,
    });
    // Non-numeric cache prices fall back too.
    expect(list!.models['openai/text-embedding-3-small']).toEqual({
      prompt: 2e-8,
      completion: 0,
      inputCacheRead: 2e-8,
      inputCacheWrite: 2e-8,
    });
    expect(list!.models['numeric/prices']).toEqual({
      prompt: 4e-6,
      completion: 8e-6,
      inputCacheRead: 4e-6,
      inputCacheWrite: 4e-6,
    });
    // Malformed entries are skipped, not stored as NaN.
    expect(Object.keys(list!.models).sort()).toEqual([
      'anthropic/claude-sonnet-4.5',
      'numeric/prices',
      'openai/gpt-5',
      'openai/text-embedding-3-small',
    ]);

    expect(f.calls).toHaveLength(1);
    const call = f.calls[0]!;
    expect(call.url).toBe('https://openrouter.ai/api/v1/models');
    expect(call.init.method).toBe('GET');
    expect(call.init.body).toBeUndefined();
    const headers = call.init.headers as Record<string, string>;
    expect(headers['HTTP-Referer']).toBe('https://github.com/repolens');
    expect(headers['X-Title']).toBe('RepoLens');
    expect(headers['Authorization']).toBeUndefined();
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    db.close();
  });

  it('persists the list and reuses it from meta without fetching while fresh', async () => {
    const db = openDb(':memory:');
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    const first = fakeFetch([jsonResponse(modelsBody)]);
    await new OpenRouterPricing({
      db,
      baseUrl: 'https://openrouter.ai/api/v1',
      fetch: first.fetch,
      now: () => base,
    }).ensure();

    const stored = db.getMeta('openrouter_pricing');
    expect(stored).toBeTruthy();
    expect((JSON.parse(stored!) as PriceList).models['openai/gpt-5']!.prompt).toBe(1.25e-6);

    // A new instance over the same db loads the stored list and does not fetch.
    const second = fakeFetch([]);
    const p2 = new OpenRouterPricing({
      db,
      baseUrl: 'https://openrouter.ai/api/v1',
      fetch: second.fetch,
      now: () => base + 23 * HOUR,
    });
    const fresh = await p2.ensure();
    expect(second.calls).toHaveLength(0);
    expect(fresh.error).toBeNull();
    expect(fresh.list!.models['openai/gpt-5']!.completion).toBe(1e-5);
    db.close();
  });

  it('refetches once the list is older than the ttl', async () => {
    const db = openDb(':memory:');
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    let now = base;
    const f = fakeFetch([
      jsonResponse(modelsBody),
      jsonResponse({ data: [{ id: 'new/model', pricing: { prompt: '0.000001', completion: '0.000002' } }] }),
    ]);
    const p = new OpenRouterPricing({ db, baseUrl: 'http://local/v1', fetch: f.fetch, now: () => now });

    await p.ensure();
    now = base + 23 * HOUR;
    await p.ensure();
    expect(f.calls).toHaveLength(1); // still fresh

    now = base + 25 * HOUR;
    const after = await p.ensure();
    expect(f.calls).toHaveLength(2);
    expect(Object.keys(after.list!.models)).toEqual(['new/model']);
    expect(after.list!.fetchedAt).toBe(new Date(base + 25 * HOUR).toISOString());
    db.close();
  });

  it('honours a custom ttl', async () => {
    const db = openDb(':memory:');
    let now = 1_000_000;
    const f = fakeFetch([jsonResponse(modelsBody), jsonResponse(modelsBody)]);
    const p = new OpenRouterPricing({ db, baseUrl: 'http://local/v1', fetch: f.fetch, ttlMs: 1000, now: () => now });
    await p.ensure();
    now += 999;
    await p.ensure();
    expect(f.calls).toHaveLength(1);
    now += 2;
    await p.ensure();
    expect(f.calls).toHaveLength(2);
    db.close();
  });

  it('keeps the previous list and reports the error when a refresh fails', async () => {
    const db = openDb(':memory:');
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    let now = base;
    const f = fakeFetch([
      jsonResponse(modelsBody),
      jsonResponse({ error: 'unavailable' }, 503),
      new Error('ECONNREFUSED'),
      jsonResponse({ data: [{ id: 'back/again', pricing: { prompt: '0.000001', completion: '0.000002' } }] }),
    ]);
    const p = new OpenRouterPricing({ db, baseUrl: 'http://local/v1', fetch: f.fetch, now: () => now });
    await p.ensure();

    now = base + 25 * HOUR;
    const failed = await p.ensure();
    expect(failed.error).toContain('HTTP 503');
    expect(failed.list!.models['openai/gpt-5']).toBeDefined();

    now = base + 50 * HOUR;
    const failedAgain = await p.ensure();
    expect(failedAgain.error).toContain('ECONNREFUSED');
    expect(failedAgain.list!.models['openai/gpt-5']).toBeDefined();

    // A later success clears the error.
    now = base + 75 * HOUR;
    const recovered = await p.ensure();
    expect(recovered.error).toBeNull();
    expect(Object.keys(recovered.list!.models)).toEqual(['back/again']);
    db.close();
  });

  it('returns a null list with the error when the first fetch ever fails', async () => {
    const db = openDb(':memory:');
    const f = fakeFetch([new Error('dns lookup failed')]);
    const p = new OpenRouterPricing({ db, baseUrl: 'http://local/v1', fetch: f.fetch });
    const { list, error } = await p.ensure();
    expect(list).toBeNull();
    expect(error).toContain('dns lookup failed');
    expect(db.getMeta('openrouter_pricing')).toBeUndefined();
    db.close();
  });

  it('reports an error for a body that is not JSON or has no data array', async () => {
    const db = openDb(':memory:');
    const notJson = new OpenRouterPricing({
      db,
      baseUrl: 'http://local/v1',
      fetch: fakeFetch([new Response('<html>nope</html>', { status: 200 })]).fetch,
    });
    expect((await notJson.ensure()).error).toBeTruthy();

    const noData = new OpenRouterPricing({
      db,
      baseUrl: 'http://local/v1',
      fetch: fakeFetch([jsonResponse({ models: [] })]).fetch,
    });
    const res = await noData.ensure();
    expect(res.list).toBeNull();
    expect(res.error).toBeTruthy();
    db.close();
  });

  it('ignores a corrupt stored value instead of throwing', async () => {
    const db = openDb(':memory:');
    db.setMeta('openrouter_pricing', 'not json at all');
    const f = fakeFetch([jsonResponse(modelsBody)]);
    const p = new OpenRouterPricing({ db, baseUrl: 'http://local/v1', fetch: f.fetch });
    const { list, error } = await p.ensure();
    expect(error).toBeNull();
    expect(list!.models['openai/gpt-5']).toBeDefined();
    expect(f.calls).toHaveLength(1);
    db.close();
  });

  it('shares one in-flight fetch between concurrent callers', async () => {
    const db = openDb(':memory:');
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const fetchImpl = (async () => {
      calls++;
      await gate;
      return jsonResponse(modelsBody);
    }) as unknown as typeof fetch;
    const p = new OpenRouterPricing({ db, baseUrl: 'http://local/v1', fetch: fetchImpl });

    const all = Promise.all([p.ensure(), p.ensure(), p.ensure()]);
    release!();
    const results = await all;
    expect(calls).toBe(1);
    for (const r of results) expect(r.list!.models['openai/gpt-5']).toBeDefined();
    db.close();
  });
});

describe('candidateIds', () => {
  it('returns nothing for an empty or placeholder model', () => {
    expect(candidateIds('claude-cli', '')).toEqual([]);
    expect(candidateIds('claude-cli', 'default')).toEqual([]);
    expect(candidateIds('openrouter', 'default')).toEqual([]);
  });

  it('strips an openrouter route suffix as a fallback', () => {
    expect(candidateIds('openrouter', 'anthropic/claude-sonnet-4.5:nitro')).toEqual([
      'anthropic/claude-sonnet-4.5:nitro',
      'anthropic/claude-sonnet-4.5',
    ]);
    expect(candidateIds('openrouter', 'anthropic/claude-sonnet-4.5')).toEqual(['anthropic/claude-sonnet-4.5']);
  });

  it('maps claude cli aliases to the latest anthropic ids', () => {
    expect(candidateIds('claude-cli', 'haiku')).toEqual(['~anthropic/claude-haiku-latest']);
    expect(candidateIds('claude-cli', 'sonnet')).toEqual(['~anthropic/claude-sonnet-latest']);
    expect(candidateIds('claude-cli', 'opus')).toEqual(['~anthropic/claude-opus-latest']);
  });

  it('rewrites a trailing claude cli version into dotted form, keeping the literal id as a fallback', () => {
    expect(candidateIds('claude-cli', 'claude-haiku-4-5')).toEqual([
      'anthropic/claude-haiku-4.5',
      'anthropic/claude-haiku-4-5',
    ]);
    expect(candidateIds('claude-cli', 'claude-opus-5')).toEqual(['anthropic/claude-opus-5']);
  });

  it('prefixes codex cli and embedding models with their vendor', () => {
    expect(candidateIds('codex-cli', 'gpt-5.6-sol')).toEqual(['openai/gpt-5.6-sol']);
    expect(candidateIds('embeddings', 'text-embedding-3-small')).toEqual([
      'text-embedding-3-small',
      'openai/text-embedding-3-small',
    ]);
  });

  it('deduplicates identical candidates', () => {
    // "openai/x" prefixed again is a harmless miss, but an id must never repeat.
    const ids = candidateIds('embeddings', 'openai/text-embedding-3-small');
    expect(ids[0]).toBe('openai/text-embedding-3-small');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('passes an unknown provider’s model through unchanged', () => {
    expect(candidateIds('something-else', 'weird/model')).toEqual(['weird/model']);
  });
});

describe('OpenRouterPricing.resolve', () => {
  const list: PriceList = {
    fetchedAt: '2026-01-01T00:00:00.000Z',
    models: {
      'anthropic/claude-haiku-4.5': { prompt: 1e-6, completion: 5e-6, inputCacheRead: 1e-7, inputCacheWrite: 1.25e-6 },
      'anthropic/claude-haiku-4-5': { prompt: 9e-9, completion: 9e-9, inputCacheRead: 9e-9, inputCacheWrite: 9e-9 },
    },
  };

  it('picks the first candidate present in the list', () => {
    expect(OpenRouterPricing.resolve(list, 'claude-cli', 'claude-haiku-4-5')).toEqual(
      list.models['anthropic/claude-haiku-4.5'],
    );
  });

  it('falls through to a later candidate when the first is absent', () => {
    const onlyLiteral: PriceList = {
      fetchedAt: list.fetchedAt,
      models: { 'anthropic/claude-haiku-4-5': list.models['anthropic/claude-haiku-4-5']! },
    };
    expect(OpenRouterPricing.resolve(onlyLiteral, 'claude-cli', 'claude-haiku-4-5')).toEqual(
      onlyLiteral.models['anthropic/claude-haiku-4-5'],
    );
  });

  it('returns null when nothing matches', () => {
    expect(OpenRouterPricing.resolve(list, 'codex-cli', 'gpt-5.6-sol')).toBeNull();
    expect(OpenRouterPricing.resolve(list, 'claude-cli', 'default')).toBeNull();
  });
});

describe('OpenRouterPricing.estimate', () => {
  const price = { prompt: 1e-6, completion: 5e-6, inputCacheRead: 1e-7, inputCacheWrite: 1.25e-6 };

  it('adds up the four token classes at list price', () => {
    const cost = OpenRouterPricing.estimate(price, {
      inputTokens: 10,
      cachedInputTokens: 0,
      cacheWriteTokens: 7508,
      outputTokens: 258,
    });
    expect(cost).toBeCloseTo(0.010685, 9);
  });

  it('prices cache reads at the cheaper read rate', () => {
    expect(
      OpenRouterPricing.estimate(price, {
        inputTokens: 0,
        cachedInputTokens: 1000,
        cacheWriteTokens: 0,
        outputTokens: 0,
      }),
    ).toBeCloseTo(1e-4, 12);
  });

  it('is zero for no tokens', () => {
    expect(
      OpenRouterPricing.estimate(price, { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }),
    ).toBe(0);
  });
});
