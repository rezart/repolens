import { describe, it, expect } from 'vitest';
import { OpenAIEmbeddings, createEmbeddings } from '../src/embeddings/index.js';
import { createProvider } from '../src/llm/index.js';
import { ProviderError } from '../src/llm/types.js';
import type { Config } from '../src/config.js';
import type { UsageRecord } from '../src/usage/types.js';

interface Call {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Responds with one vector per input, echoing the input's position. */
function embeddingFetch(
  opts: { dim?: number; failures?: Response[]; shuffle?: boolean; tokensPerText?: number } = {},
) {
  const calls: Call[] = [];
  const failures = opts.failures ?? [];
  const dim = opts.dim ?? 3;
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const failure = failures.shift();
    if (failure) return failure;
    const body = JSON.parse((init?.body as string) ?? '{}');
    const input: string[] = body.input;
    const data = input.map((text, index) => ({
      index,
      embedding: [Number(text.replace(/\D/g, '')) || 0, ...Array.from({ length: dim - 1 }, () => 0.5)],
    }));
    if (opts.shuffle) data.reverse();
    const usage = opts.tokensPerText === undefined ? undefined : { prompt_tokens: input.length * opts.tokensPerText };
    return jsonResponse({ object: 'list', data, model: body.model, usage });
  };
  return { calls, fetch: fn as unknown as typeof fetch };
}

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    dataDir: './data',
    apiToken: '',
    pollIntervalSeconds: 0,
    chatProvider: '',
    chatModel: '',
    review: { statusContext: 'repolens/review', failOn: 'critical' },
    port: 3000,
    publicUrl: '',
    llm: {
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.5',
      timeoutMs: 1000,
      openrouterApiKey: 'k',
      openrouterBaseUrl: 'https://openrouter.ai/api/v1',
      claudeBin: 'claude',
      codexBin: 'codex',
      reasoningEffort: '',
    },
    embedding: null,
    github: { token: '', apiUrl: 'https://api.github.com', webhookSecret: '', botHandle: '@repolens' },
    ...overrides,
  };
}

describe('OpenAIEmbeddings', () => {
  it('returns [] for empty input without calling fetch', async () => {
    const f = embeddingFetch();
    const e = new OpenAIEmbeddings({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', fetch: f.fetch });
    expect(await e.embed([])).toEqual([]);
    expect(f.calls).toHaveLength(0);
    expect(e.dimension).toBeNull();
  });

  it('posts the expected request shape', async () => {
    const f = embeddingFetch();
    const e = new OpenAIEmbeddings({ baseUrl: 'http://x/v1', apiKey: 'sk-1', model: 'text-embed', fetch: f.fetch });
    await e.embed(['a', 'b']);
    const call = f.calls[0]!;
    expect(call.url).toBe('http://x/v1/embeddings');
    expect(call.init.method).toBe('POST');
    const headers = call.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-1');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['HTTP-Referer']).toBe('https://github.com/repolens');
    expect(headers['X-Title']).toBe('RepoLens');
    expect(JSON.parse(call.init.body as string)).toEqual({ model: 'text-embed', input: ['a', 'b'] });
  });

  it('splits 150 texts into batches of 64/64/22 and concatenates in order', async () => {
    const f = embeddingFetch();
    const e = new OpenAIEmbeddings({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', fetch: f.fetch });
    const texts = Array.from({ length: 150 }, (_, i) => `t${i}`);
    const vectors = await e.embed(texts);
    expect(f.calls).toHaveLength(3);
    const sizes = f.calls.map((c) => JSON.parse(c.init.body as string).input.length);
    expect(sizes).toEqual([64, 64, 22]);
    expect(vectors).toHaveLength(150);
    // first component encodes the original index
    expect(vectors.map((v) => v[0])).toEqual(texts.map((_, i) => i));
  });

  it('honours a custom batch size', async () => {
    const f = embeddingFetch();
    const e = new OpenAIEmbeddings({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', fetch: f.fetch, batchSize: 10 });
    await e.embed(Array.from({ length: 25 }, (_, i) => `t${i}`));
    expect(f.calls.map((c) => JSON.parse(c.init.body as string).input.length)).toEqual([10, 10, 5]);
  });

  it('sets dimension from the first vector', async () => {
    const f = embeddingFetch({ dim: 8 });
    const e = new OpenAIEmbeddings({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', fetch: f.fetch });
    expect(e.dimension).toBeNull();
    const v = await e.embed(['a']);
    expect(v[0]).toHaveLength(8);
    expect(e.dimension).toBe(8);
  });

  it('reorders results by the returned index', async () => {
    const f = embeddingFetch({ shuffle: true });
    const e = new OpenAIEmbeddings({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', fetch: f.fetch });
    const v = await e.embed(['t0', 't1', 't2']);
    expect(v.map((x) => x[0])).toEqual([0, 1, 2]);
  });

  it('retries once on a 429 and then succeeds', async () => {
    const f = embeddingFetch({ failures: [jsonResponse({ error: 'rate' }, 429)] });
    const slept: number[] = [];
    const e = new OpenAIEmbeddings({
      baseUrl: 'http://x/v1',
      apiKey: 'k',
      model: 'm',
      fetch: f.fetch,
      sleep: async (ms: number) => {
        slept.push(ms);
      },
    });
    const v = await e.embed(['t7']);
    expect(v[0]![0]).toBe(7);
    expect(f.calls).toHaveLength(2);
    expect(slept).toHaveLength(1);
  });

  it('throws a ProviderError after the retry when the server keeps failing', async () => {
    const f = embeddingFetch({ failures: [new Response('down', { status: 500 }), new Response('down', { status: 500 })] });
    const e = new OpenAIEmbeddings({
      baseUrl: 'http://x/v1',
      apiKey: 'k',
      model: 'm',
      fetch: f.fetch,
      sleep: async () => {},
    });
    const err = await e.embed(['a']).then(
      () => null,
      (x: unknown) => x,
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).provider).toBe('embeddings');
    expect((err as ProviderError).status).toBe(500);
    expect(f.calls).toHaveLength(2);
  });

  it('does not retry a 400', async () => {
    const f = embeddingFetch({ failures: [new Response('bad', { status: 400 })] });
    const e = new OpenAIEmbeddings({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', fetch: f.fetch, sleep: async () => {} });
    await expect(e.embed(['a'])).rejects.toBeInstanceOf(ProviderError);
    expect(f.calls).toHaveLength(1);
  });

  it('retries a network-layer failure then succeeds', async () => {
    const f = embeddingFetch();
    let calls = 0;
    const flaky = (async (url: string | URL | Request, init?: RequestInit) => {
      if (++calls === 1) throw new Error('fetch failed');
      return f.fetch(url as string, init);
    }) as unknown as typeof fetch;
    const e = new OpenAIEmbeddings({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', fetch: flaky, sleep: async () => {} });
    const v = await e.embed(['t7']);
    expect(v[0]![0]).toBe(7);
    expect(calls).toBe(2);
  });

  it('wraps a persistent network failure in a ProviderError', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const e = new OpenAIEmbeddings({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', fetch: fetchImpl, sleep: async () => {} });
    const err = await e.embed(['a']).then(
      () => null,
      (x: unknown) => x,
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).provider).toBe('embeddings');
    expect((err as ProviderError).message).toContain('request failed: ECONNREFUSED');
    expect(calls).toBe(2);
  });

  it('reports one usage record per batch, carrying that batch prompt tokens', async () => {
    const f = embeddingFetch({ tokensPerText: 10 });
    const seen: UsageRecord[] = [];
    const e = new OpenAIEmbeddings({
      baseUrl: 'http://x/v1',
      apiKey: 'k',
      model: 'text-embed',
      fetch: f.fetch,
      onUsage: (r) => seen.push(r),
    });
    await e.embed(Array.from({ length: 130 }, (_, i) => `t${i}`));
    expect(f.calls).toHaveLength(3);
    expect(seen).toEqual([640, 640, 20].map((prompt) => ({
      provider: 'embeddings',
      model: 'text-embed',
      inputTokens: prompt,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      costUsd: null,
    })));
  });

  it('reports nothing when the response carries no usage', async () => {
    const f = embeddingFetch();
    const seen: UsageRecord[] = [];
    const e = new OpenAIEmbeddings({
      baseUrl: 'http://x/v1',
      apiKey: 'k',
      model: 'm',
      fetch: f.fetch,
      onUsage: (r) => seen.push(r),
    });
    await e.embed(['a', 'b']);
    expect(seen).toEqual([]);
  });

  it('still returns vectors when the sink throws', async () => {
    const f = embeddingFetch({ tokensPerText: 3 });
    const e = new OpenAIEmbeddings({
      baseUrl: 'http://x/v1',
      apiKey: 'k',
      model: 'm',
      fetch: f.fetch,
      onUsage: () => {
        throw new Error('sink is broken');
      },
    });
    const v = await e.embed(['t7']);
    expect(v[0]![0]).toBe(7);
  });

  it('throws when the batch returns the wrong number of vectors', async () => {
    const f = embeddingFetch({ failures: [jsonResponse({ data: [] })] });
    const e = new OpenAIEmbeddings({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', fetch: f.fetch });
    await expect(e.embed(['a'])).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('createEmbeddings', () => {
  it('returns null when embeddings are not configured', () => {
    expect(createEmbeddings(baseConfig())).toBeNull();
  });

  it('builds an OpenAIEmbeddings from config', () => {
    const e = createEmbeddings(baseConfig({ embedding: { baseUrl: 'http://x/v1', apiKey: 'k', model: 'm1' } }));
    expect(e).toBeInstanceOf(OpenAIEmbeddings);
    expect(e!.model).toBe('m1');
  });

  it('forwards the configured llm timeout', () => {
    const cfg = baseConfig({ embedding: { baseUrl: 'http://x/v1', apiKey: 'k', model: 'm1' } });
    cfg.llm.timeoutMs = 4321;
    const e = createEmbeddings(cfg)!;
    expect((e as unknown as { timeoutMs: number }).timeoutMs).toBe(4321);
  });

  it('forwards the usage sink so embedding batches are accounted for', () => {
    const onUsage = () => {};
    const e = createEmbeddings(baseConfig({ embedding: { baseUrl: 'http://x/v1', apiKey: 'k', model: 'm1' } }), { onUsage })!;
    expect((e as unknown as { onUsage?: unknown }).onUsage).toBe(onUsage);
  });
});

describe('createProvider', () => {
  it('builds the openrouter provider', () => {
    const p = createProvider(baseConfig());
    expect(p.name).toBe('openrouter');
    expect(p.model).toBe('anthropic/claude-sonnet-4.5');
    expect(p.concurrency).toBe(4);
  });

  it('builds the claude-cli provider', () => {
    const cfg = baseConfig();
    cfg.llm.provider = 'claude-cli';
    cfg.llm.model = 'sonnet';
    const p = createProvider(cfg);
    expect(p.name).toBe('claude-cli');
    expect(p.model).toBe('sonnet');
    expect(p.concurrency).toBe(1);
  });

  it('treats an empty model as unset for the cli providers', () => {
    const cfg = baseConfig();
    cfg.llm.provider = 'codex-cli';
    cfg.llm.model = '';
    const p = createProvider(cfg);
    expect(p.name).toBe('codex-cli');
    expect(p.model).toBe('default');
  });
});
