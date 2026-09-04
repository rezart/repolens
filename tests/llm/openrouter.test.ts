import { describe, it, expect } from 'vitest';
import { OpenRouterProvider } from '../../src/llm/openrouter.js';
import { ProviderError } from '../../src/llm/types.js';

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
