import { describe, it, expect } from 'vitest';
import { OpenRouterProvider } from '../../src/llm/openrouter.js';
import { IncompleteResponseError, ProviderError } from '../../src/llm/types.js';
import type { UsageRecord } from '../../src/usage/types.js';
import { reviewCostUpperBound, REVIEW_MAX_USD, REVIEW_MAX_OUTPUT } from '../../src/review/budget.js';

interface Call {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fakeFetch(responses: Response[]) {
  const calls: Call[] = [];
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra fetch call');
    return next;
  };
  return { calls, fetch: fn as unknown as typeof fetch };
}

const ok = () => jsonResponse({ choices: [{ message: { role: 'assistant', content: 'hello there' } }] });

describe('OpenRouter review budget', () => {
  const req = { messages: [{ role: 'user' as const, content: 'review this' }], reviewBudget: true, maxTokens: REVIEW_MAX_OUTPUT };

  it.each(['qwen/qwen3-coder', 'qwen/qwen3-coder-next', 'other/coder'])('enforces routing prices and UTF-8 budget bounds for %s', async (model) => {
    const f = fakeFetch([jsonResponse({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] })]);
    const p = new OpenRouterProvider({ apiKey: 'k', model, fetch: f.fetch, reasoningEffort: 'high' });
    const larger = { ...req, messages: [{ role: 'user' as const, content: '💸'.repeat(20000) }] };
    expect(REVIEW_MAX_USD).toBe(0.245);
    expect(reviewCostUpperBound(larger)).toBeGreaterThan(0.045);
    await p.complete(larger);
    const body = JSON.parse(String(f.calls[0]!.init.body));
    expect(body.provider).toEqual({ sort: 'price', require_parameters: true, allow_fallbacks: false, max_price: { prompt: 0.4, completion: 2, request: 0 } });
    expect(body.reasoning).toBeUndefined();
    const huge = { ...req, messages: [{ role: 'user' as const, content: '💸'.repeat(150000) }] };
    expect(reviewCostUpperBound(huge)).toBeGreaterThan(REVIEW_MAX_USD);
    await expect(p.complete(huge)).rejects.toThrow('$0.25');
    expect(f.calls).toHaveLength(1);
  });

  it('does not retry an ambiguous network failure or server failure', async () => {
    for (const failure of [new Error('timeout'), jsonResponse({}, 503)]) {
      let calls = 0;
      const p = new OpenRouterProvider({ apiKey: 'k', model: 'qwen/qwen3-coder', fetch: (async () => {
        calls++;
        if (failure instanceof Error) throw failure;
        return failure;
      }) as typeof fetch, sleep: async () => {} });
      await expect(p.complete(req)).rejects.toThrow();
      expect(calls).toBe(1);
    }
  });

  it.each([401, 429, 503])('preserves an in-band error code %s even with HTTP 200', async (code) => {
    const f = fakeFetch([jsonResponse({ error: { code, message: 'backend error' } })]);
    const p = new OpenRouterProvider({ apiKey: 'k', model: 'other/coder', fetch: f.fetch });
    const error = await p.complete(req).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ status: code });
    expect(error).not.toBeInstanceOf(IncompleteResponseError);
  });

  it('records billed usage but rejects a truncated response', async () => {
    const seen: UsageRecord[] = [];
    const f = fakeFetch([jsonResponse({ choices: [{ message: { content: '{}' }, finish_reason: 'length' }], usage: { prompt_tokens: 100, completion_tokens: 8000, cost: 0.01604 } })]);
    const p = new OpenRouterProvider({ apiKey: 'k', model: 'qwen/qwen3-coder', fetch: f.fetch, onUsage: (r) => seen.push(r) });
    await expect(p.complete(req)).rejects.toThrow('incomplete review');
    expect(seen[0]?.costUsd).toBe(0.01604);
  });
});

describe('OpenRouterProvider', () => {
  it('exposes name, model and concurrency', () => {
    const p = new OpenRouterProvider({ apiKey: 'k', model: 'anthropic/claude-sonnet-4.5' });
    expect(p.name).toBe('openrouter');
    expect(p.model).toBe('anthropic/claude-sonnet-4.5');
    expect(p.concurrency).toBe(4);
  });

  it('posts the expected request shape and returns the message content', async () => {
    const f = fakeFetch([ok()]);
    const p = new OpenRouterProvider({ apiKey: 'secret-key', model: 'm1', fetch: f.fetch });
    const out = await p.complete({
      system: 'you are terse',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'yo' },
        { role: 'user', content: 'again' },
      ],
      maxTokens: 123,
      temperature: 0.2,
    });
    expect(out).toBe('hello there');
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0]!;
    expect(call.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(call.init.method).toBe('POST');
    const headers = call.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer secret-key');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['HTTP-Referer']).toBe('https://github.com/repolens');
    expect(headers['X-Title']).toBe('RepoLens');
    const body = JSON.parse(call.init.body as string);
    expect(body.model).toBe('m1');
    expect(body.max_tokens).toBe(123);
    expect(body.temperature).toBe(0.2);
    expect(body.response_format).toBeUndefined();
    expect(body.messages).toEqual([
      { role: 'system', content: 'you are terse' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
      { role: 'user', content: 'again' },
    ]);
  });

  it('omits the system message when none is given', async () => {
    const f = fakeFetch([ok()]);
    const p = new OpenRouterProvider({ apiKey: 'k', model: 'm1', fetch: f.fetch });
    await p.complete({ messages: [{ role: 'user', content: 'hi' }] });
    const body = JSON.parse(f.calls[0]!.init.body as string);
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body.max_tokens).toBeUndefined();
  });

  it('requests a json object when json is set', async () => {
    const f = fakeFetch([ok()]);
    const p = new OpenRouterProvider({ apiKey: 'k', model: 'm1', fetch: f.fetch });
    await p.complete({ messages: [{ role: 'user', content: 'hi' }], json: true });
    const body = JSON.parse(f.calls[0]!.init.body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
    // json mode must not cost us the usage block every call is billed from.
    expect(body.usage).toEqual({ include: true });
  });

  it('honours a custom base url without a trailing slash problem', async () => {
    const f = fakeFetch([ok()]);
    const p = new OpenRouterProvider({ apiKey: 'k', model: 'm1', baseUrl: 'http://local/v1/', fetch: f.fetch });
    await p.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(f.calls[0]!.url).toBe('http://local/v1/chat/completions');
  });

  it('retries a 429 then succeeds', async () => {
    const f = fakeFetch([jsonResponse({ error: 'slow down' }, 429), ok()]);
    const slept: number[] = [];
    const p = new OpenRouterProvider({
      apiKey: 'k',
      model: 'm1',
      fetch: f.fetch,
      sleep: async (ms: number) => {
        slept.push(ms);
      },
    });
    const out = await p.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(out).toBe('hello there');
    expect(f.calls).toHaveLength(2);
    expect(slept).toHaveLength(1);
  });

  it('retries 5xx up to 3 attempts then throws', async () => {
    const f = fakeFetch([
      jsonResponse({ e: 1 }, 500),
      jsonResponse({ e: 2 }, 502),
      jsonResponse({ e: 3 }, 503),
    ]);
    const p = new OpenRouterProvider({ apiKey: 'k', model: 'm1', fetch: f.fetch, sleep: async () => {} });
    await expect(p.complete({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({
      name: 'ProviderError',
      status: 503,
    });
    expect(f.calls).toHaveLength(3);
  });

  it('throws a ProviderError with the status on a 400', async () => {
    const f = fakeFetch([new Response('bad model', { status: 400 })]);
    const p = new OpenRouterProvider({ apiKey: 'k', model: 'm1', fetch: f.fetch, sleep: async () => {} });
    const err = await p.complete({ messages: [{ role: 'user', content: 'hi' }] }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProviderError);
    const pe = err as ProviderError;
    expect(pe.provider).toBe('openrouter');
    expect(pe.status).toBe(400);
    expect(pe.message).toContain('HTTP 400');
    expect(pe.detail).toContain('bad model');
    expect(f.calls).toHaveLength(1);
  });

  it('retries a network-layer failure then succeeds', async () => {
    const outcomes: Array<Response | Error> = [new Error('fetch failed'), ok()];
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      const next = outcomes.shift()!;
      if (next instanceof Error) throw next;
      return next;
    }) as unknown as typeof fetch;
    const p = new OpenRouterProvider({ apiKey: 'k', model: 'm1', fetch: fetchImpl, sleep: async () => {} });
    expect(await p.complete({ messages: [{ role: 'user', content: 'hi' }] })).toBe('hello there');
    expect(calls).toBe(2);
  });

  it('wraps a persistent network failure in a ProviderError', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const p = new OpenRouterProvider({ apiKey: 'k', model: 'm1', fetch: fetchImpl, sleep: async () => {} });
    const err = await p.complete({ messages: [{ role: 'user', content: 'hi' }] }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).provider).toBe('openrouter');
    expect((err as ProviderError).message).toContain('request failed: ECONNREFUSED');
    expect(calls).toBe(3);
  });

  it('throws when the response has no content', async () => {
    const f = fakeFetch([jsonResponse({ choices: [] })]);
    const p = new OpenRouterProvider({ apiKey: 'k', model: 'm1', fetch: f.fetch });
    await expect(p.complete({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toBeInstanceOf(ProviderError);
  });
});

/** An SSE response body delivered in chunks that split frames arbitrarily. */
function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function dataFrame(content: string): string {
  return 'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n';
}

describe('OpenRouterProvider.stream', () => {
  it('parses SSE deltas and resolves with the joined text', async () => {
    const body = dataFrame('Hello ') + dataFrame('world') + 'data: [DONE]\n\n';
    // Split mid-frame to prove the buffer survives chunk boundaries.
    const f = fakeFetch([sseResponse([body.slice(0, 20), body.slice(20, 55), body.slice(55)])]);
    const p = new OpenRouterProvider({ apiKey: 'k', model: 'm1', fetch: f.fetch });
    const deltas: string[] = [];
    const out = await p.stream({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }, (t) => deltas.push(t));

    expect(deltas).toEqual(['Hello ', 'world']);
    expect(out).toBe('Hello world');
    const sent = JSON.parse(String(f.calls[0]!.init.body));
    expect(sent.stream).toBe(true);
    expect(sent.max_tokens).toBe(100);
  });

  it('does not drop a multi-byte character split across the final chunks', async () => {
    // Last frame carries "é" (2 bytes) with no trailing newline after the [DONE]-less finish_reason frame.
    const last = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'caf\u00e9' }, finish_reason: 'stop' }] });
    const bytes = new TextEncoder().encode(dataFrame('ok ') + last);
    const cut = bytes.length - 3; // split inside the 2-byte "é" near the end
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, cut));
        c.enqueue(bytes.slice(cut));
        c.close();
      },
    });
    const res = new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    const f = fakeFetch([res]);
    const p = new OpenRouterProvider({ apiKey: 'k', model: 'm1', fetch: f.fetch });
    const out = await p.stream({ messages: [{ role: 'user', content: 'hi' }] }, () => {});
    expect(out).toBe('ok caf\u00e9');
  });

  it('ignores keep-alive comments and blank lines', async () => {
    const body = ': ping\n\n' + '\n' + dataFrame('ok') + 'data: [DONE]\n\n';
    const f = fakeFetch([sseResponse([body])]);
    const p = new OpenRouterProvider({ apiKey: 'k', model: 'm1', fetch: f.fetch });
    const deltas: string[] = [];
    expect(await p.stream({ messages: [{ role: 'user', content: 'hi' }] }, (t) => deltas.push(t))).toBe('ok');
    expect(deltas).toEqual(['ok']);
  });

  it('throws on a malformed data frame instead of truncating the answer', async () => {
    const body = dataFrame('ok') + 'data: {not json}\n\n' + 'data: [DONE]\n\n';
    const f = fakeFetch([sseResponse([body])]);
    const p = new OpenRouterProvider({ apiKey: 'k', model: 'm1', fetch: f.fetch });
    const err = await p.stream({ messages: [{ role: 'user', content: 'hi' }] }, () => {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).toContain('malformed stream frame: {not json}');
  });

  it('bounds the malformed frame it reports to 200 characters', async () => {
    const f = fakeFetch([sseResponse(['data: {' + 'x'.repeat(500) + '\n\n'])]);
    const p = new OpenRouterProvider({ apiKey: 'k', model: 'm1', fetch: f.fetch });
    const err = await p.stream({ messages: [{ role: 'user', content: 'hi' }] }, () => {}).then(
      () => null,
      (e: unknown) => e as ProviderError,
    );
    expect(err!.message.length).toBeLessThan(260);
  });

  it('throws when the body ends before [DONE]', async () => {
    const f = fakeFetch([sseResponse([dataFrame('half an ans')])]);
    const p = new OpenRouterProvider({ apiKey: 'k', model: 'm1', fetch: f.fetch });
    await expect(p.stream({ messages: [{ role: 'user', content: 'hi' }] }, () => {})).rejects.toThrow(
      /stream ended before \[DONE\]/,
    );
  });

  it('accepts a stream that ends after a finish_reason but without [DONE]', async () => {
    const finish = 'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n';
    const f = fakeFetch([sseResponse([dataFrame('all of it'), finish])]);
    const p = new OpenRouterProvider({ apiKey: 'k', model: 'm1', fetch: f.fetch });
    expect(await p.stream({ messages: [{ role: 'user', content: 'hi' }] }, () => {})).toBe('all of it');
  });

  it('retries a 429 before the stream starts', async () => {
    const f = fakeFetch([jsonResponse({ error: 'slow down' }, 429), sseResponse([dataFrame('hi'), 'data: [DONE]\n\n'])]);
    const p = new OpenRouterProvider({ apiKey: 'k', model: 'm1', fetch: f.fetch, sleep: async () => {} });
    expect(await p.stream({ messages: [{ role: 'user', content: 'hi' }] }, () => {})).toBe('hi');
    expect(f.calls).toHaveLength(2);
  });

  it('throws a ProviderError on a non-retryable status', async () => {
    const f = fakeFetch([jsonResponse({ error: 'nope' }, 401)]);
    const p = new OpenRouterProvider({ apiKey: 'k', model: 'm1', fetch: f.fetch });
    await expect(p.stream({ messages: [{ role: 'user', content: 'hi' }] }, () => {})).rejects.toBeInstanceOf(ProviderError);
  });

  it('does not send stream:true for a plain complete()', async () => {
    const f = fakeFetch([ok()]);
    const p = new OpenRouterProvider({ apiKey: 'k', model: 'm1', fetch: f.fetch });
    await p.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(JSON.parse(String(f.calls[0]!.init.body)).stream).toBeUndefined();
  });
});

describe('OpenRouterProvider usage reporting', () => {
  const withUsage = (usage: unknown) =>
    jsonResponse({ choices: [{ message: { role: 'assistant', content: 'hello there' } }], usage });

  it('reports normalised usage with cost and cached tokens, and asks for cost in the payload', async () => {
    const f = fakeFetch([
      withUsage({
        prompt_tokens: 120,
        completion_tokens: 30,
        prompt_tokens_details: { cached_tokens: 20 },
        cost: 0.0042,
      }),
    ]);
    const seen: UsageRecord[] = [];
    const p = new OpenRouterProvider({ apiKey: 'k', model: 'm1', fetch: f.fetch, onUsage: (r) => seen.push(r) });
    expect(await p.complete({ messages: [{ role: 'user', content: 'hi' }] })).toBe('hello there');
    expect(seen).toEqual([
      {
        provider: 'openrouter',
        model: 'm1',
        inputTokens: 100,
        cachedInputTokens: 20,
        cacheWriteTokens: 0,
        outputTokens: 30,
        costUsd: 0.0042,
      },
    ]);
    expect(JSON.parse(String(f.calls[0]!.init.body)).usage).toEqual({ include: true });
  });

  it('reports a null cost and no cached tokens when the body omits them', async () => {
    const f = fakeFetch([withUsage({ prompt_tokens: 10, completion_tokens: 4 })]);
    const seen: UsageRecord[] = [];
    const p = new OpenRouterProvider({ apiKey: 'k', model: 'm1', fetch: f.fetch, onUsage: (r) => seen.push(r) });
    await p.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(seen).toEqual([
      {
        provider: 'openrouter',
        model: 'm1',
        inputTokens: 10,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 4,
        costUsd: null,
      },
    ]);
  });

  it('reports nothing when the response carries no usage', async () => {
    const f = fakeFetch([ok()]);
    const seen: UsageRecord[] = [];
    const p = new OpenRouterProvider({ apiKey: 'k', model: 'm1', fetch: f.fetch, onUsage: (r) => seen.push(r) });
    await p.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(seen).toEqual([]);
  });

  it('reports nothing when the usage fields are not numbers', async () => {
    const f = fakeFetch([withUsage({ prompt_tokens: 'lots', completion_tokens: null })]);
    const seen: UsageRecord[] = [];
    const p = new OpenRouterProvider({ apiKey: 'k', model: 'm1', fetch: f.fetch, onUsage: (r) => seen.push(r) });
    await p.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(seen).toEqual([]);
  });

  it('still returns the completion when the sink throws', async () => {
    const f = fakeFetch([withUsage({ prompt_tokens: 5, completion_tokens: 1 })]);
    const p = new OpenRouterProvider({
      apiKey: 'k',
      model: 'm1',
      fetch: f.fetch,
      onUsage: () => {
        throw new Error('sink is broken');
      },
    });
    expect(await p.complete({ messages: [{ role: 'user', content: 'hi' }] })).toBe('hello there');
  });

  it('reports the usage carried on the last stream frame, once', async () => {
    const usageFrame =
      'data: ' +
      JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 80, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 30 }, cost: 0.5 },
      }) +
      '\n\n';
    const f = fakeFetch([sseResponse([dataFrame('hi'), usageFrame, 'data: [DONE]\n\n'])]);
    const seen: UsageRecord[] = [];
    const p = new OpenRouterProvider({ apiKey: 'k', model: 'm1', fetch: f.fetch, onUsage: (r) => seen.push(r) });
    expect(await p.stream({ messages: [{ role: 'user', content: 'hi' }] }, () => {})).toBe('hi');
    expect(seen).toEqual([
      {
        provider: 'openrouter',
        model: 'm1',
        inputTokens: 50,
        cachedInputTokens: 30,
        cacheWriteTokens: 0,
        outputTokens: 12,
        costUsd: 0.5,
      },
    ]);
    expect(JSON.parse(String(f.calls[0]!.init.body)).usage).toEqual({ include: true });
  });

  it('reports nothing when the stream ends before [DONE]', async () => {
    const usageFrame =
      'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 1 } }) + '\n\n';
    const f = fakeFetch([sseResponse([dataFrame('half an ans'), usageFrame])]);
    const seen: UsageRecord[] = [];
    const p = new OpenRouterProvider({ apiKey: 'k', model: 'm1', fetch: f.fetch, onUsage: (r) => seen.push(r) });
    await expect(p.stream({ messages: [{ role: 'user', content: 'hi' }] }, () => {})).rejects.toThrow(
      /stream ended before \[DONE\]/,
    );
    expect(seen).toEqual([]);
  });
});

describe('OpenRouterProvider reasoning effort', () => {
  it('sends reasoning.effort when configured', async () => {
    const f = fakeFetch([ok()]);
    const p = new OpenRouterProvider({ apiKey: 'k', model: 'm1', fetch: f.fetch, reasoningEffort: 'medium' });
    await p.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(JSON.parse(String(f.calls[0]!.init.body)).reasoning).toEqual({ effort: 'medium' });
  });

  it('omits reasoning when blank', async () => {
    const f = fakeFetch([ok()]);
    const p = new OpenRouterProvider({ apiKey: 'k', model: 'm1', fetch: f.fetch, reasoningEffort: '' });
    await p.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(JSON.parse(String(f.calls[0]!.init.body)).reasoning).toBeUndefined();
  });
});

it.each(['not-a-url', 'ftp://example.com', 'https://user:pass@example.com'])('rejects invalid direct provider base URL %s before any retry', (baseUrl) => {
  expect(() => new OpenRouterProvider({ apiKey: 'k', model: 'm', baseUrl })).toThrow();
});
