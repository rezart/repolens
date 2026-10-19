import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { Socket } from 'node:net';
import { SubscriptionProvider } from '../../src/llm/subscription.js';
import { createProvider } from '../../src/llm/index.js';
import { loadConfig } from '../../src/config.js';

const valid = { text: 'review complete', thread_id: 'thread', turn_id: 'turn', input_tokens: 9, output_tokens: 3, cached_input_tokens: 2 };
const cleanups: (() => Promise<void>)[] = [];

async function broker(handler: http.RequestListener) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'subscription-test-'));
  const socketPath = path.join(directory, 'complete.sock');
  const server = http.createServer(handler);
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(socketPath);
  await once(server, 'listening');
  await fs.chmod(socketPath, 0o660);
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return socketPath;
}

async function requestBody(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString());
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  vi.restoreAllMocks();
});

describe('SubscriptionProvider', () => {
  it('is available through validated config and never enables the disabled CLI', () => {
    const config = loadConfig({ LLM_PROVIDER: 'subscription', LLM_MODEL: 'gpt-6.1-sol',
      SUBSCRIPTION_SOCKET_PATH: '/run/private/completion.sock' });
    expect(createProvider(config).name).toBe('subscription');
    expect(() => loadConfig({ LLM_PROVIDER: 'subscription', LLM_MODEL: 'gpt-6.1-sol',
      SUBSCRIPTION_SOCKET_PATH: 'relative.sock' })).toThrow();
    expect(() => createProvider(config, { fallbackModels: ['paid/model'] })).toThrow();
    expect(() => loadConfig({ LLM_PROVIDER: 'codex-cli' })).toThrow(/disabled/);
  });
  it('uses a real private Unix socket and preserves every message role', async () => {
    let payload: Record<string, unknown> | undefined;
    const socketPath = await broker(async (req, res) => {
      expect(req.url).toBe('/complete');
      payload = await requestBody(req);
      res.end(JSON.stringify(valid));
    });
    const onUsage = vi.fn();
    const provider = new SubscriptionProvider({ socketPath, model: 'gpt-6.1-sol', timeoutMs: 1000, onUsage });
    const text = await provider.complete({ system: 'review instructions', messages: [
      { role: 'system', content: 'additional instructions' },
      { role: 'user', content: 'untrusted diff' }, { role: 'assistant', content: 'earlier review' },
    ] });
    expect(text).toBe('review complete');
    expect(Object.keys(payload!).sort()).toEqual(['effort', 'input', 'model']);
    expect(payload!.model).toBe('gpt-6.1-sol');
    const transcript = JSON.parse(payload!.input as string);
    expect(transcript.system).toBe('review instructions');
    expect(transcript.messages.map((message: { role: string }) => message.role)).toEqual(['system', 'user', 'assistant']);
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'subscription', model: 'gpt-6.1-sol', inputTokens: 7, outputTokens: 3, costUsd: null,
    }));
  });

  it.each([
    { ...valid, text: '' },
    { text: 'partial' },
    { ...valid, status: 'interrupted' },
    { ...valid, tools: [{ name: 'shell' }] },
    { ...valid, account: { type: 'apiKey' } },
    { ...valid, input_tokens: -1 },
  ])('rejects incomplete or tool-bearing broker results', async (response) => {
    const socketPath = await broker((_req, res) => res.end(JSON.stringify(response)));
    const provider = new SubscriptionProvider({ socketPath, model: 'gpt-6.1-sol', timeoutMs: 1000 });
    await expect(provider.complete({ messages: [{ role: 'user', content: 'review' }] })).rejects.toThrow();
  });

  it.each(['authentication_required', 'subscription_exhausted', 'model_unavailable', 'unsafe_tool_surface'])
  ('returns safe broker blockers without a fetch fallback: %s', async (error) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('TCP fallback forbidden'));
    const socketPath = await broker((_req, res) => { res.writeHead(503); res.end(JSON.stringify({ error })); });
    const provider = new SubscriptionProvider({ socketPath, model: 'gpt-6.1-sol', timeoutMs: 1000 });
    await expect(provider.complete({ messages: [] })).rejects.toThrow(error);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('validates strict structured output before returning it', async () => {
    let response = '{"approve":true}';
    const socketPath = await broker((_req, res) => res.end(JSON.stringify({ ...valid, text: response })));
    const provider = new SubscriptionProvider({ socketPath, model: 'gpt-6.1-sol', timeoutMs: 1000 });
    const request = { messages: [], json: true, jsonSchema: {
      type: 'object', properties: { approve: { type: 'boolean' } }, required: ['approve'], additionalProperties: false,
    } };
    expect(await provider.complete(request)).toBe('{"approve":true}');
    response = '{"approve":"yes"}';
    await expect(provider.complete(request)).rejects.toThrow(/structured output/);
    response = '{"approve":true,"tools":[]}';
    await expect(provider.complete(request)).rejects.toThrow(/structured output/);
  });

  it('rejects external schemas and unsupported sampling/budget controls before dispatch', async () => {
    let requests = 0;
    const socketPath = await broker((_req, res) => { requests++; res.end(JSON.stringify(valid)); });
    const provider = new SubscriptionProvider({ socketPath, model: 'gpt-6.1-sol', timeoutMs: 1000 });
    for (const extra of [{ jsonSchema: { $ref: 'https://example.invalid/schema' } },
                         { maxTokens: 100 }, { temperature: 0 }, { reviewBudget: true }]) {
      await expect(provider.complete({ messages: [], ...extra })).rejects.toThrow();
    }
    expect(requests).toBe(0);
  });

  it('bounds request and response sizes', async () => {
    let requests = 0;
    const socketPath = await broker((_req, res) => {
      requests++;
      res.end(JSON.stringify({ ...valid, text: 'x'.repeat(1024 * 1024) }));
    });
    const provider = new SubscriptionProvider({ socketPath, model: 'gpt-6.1-sol', timeoutMs: 1000 });
    await expect(provider.complete({ messages: [{ role: 'user', content: 'x'.repeat(256 * 1024) }] })).rejects.toThrow(/large/);
    expect(requests).toBe(0);
    await expect(provider.complete({ messages: [] })).rejects.toThrow(/large/);
  });

  it('times out a partial response and destroys the socket', async () => {
    const socketPath = await broker((_req, res) => { res.writeHead(200); res.write('{"text":"partial'); });
    const provider = new SubscriptionProvider({ socketPath, model: 'gpt-6.1-sol', timeoutMs: 30 });
    await expect(provider.complete({ messages: [] })).rejects.toThrow(/timed out/);
  });

  it('cancels the HTTP request when the caller aborts', async () => {
    const socketPath = await broker((_req, res) => { res.writeHead(200); res.write('{'); });
    const provider = new SubscriptionProvider({ socketPath, model: 'gpt-6.1-sol', timeoutMs: 1000 });
    const controller = new AbortController();
    const completion = provider.complete({ messages: [], signal: controller.signal });
    controller.abort();
    await expect(completion).rejects.toThrow(/cancelled/);
  });

  it('requires an absolute private socket', async () => {
    expect(() => new SubscriptionProvider({ socketPath: 'relative.sock', model: 'x', timeoutMs: 1000 })).toThrow(/absolute/);
    const socketPath = await broker((_req, res) => res.end(JSON.stringify(valid)));
    await fs.chmod(socketPath, 0o666);
    const provider = new SubscriptionProvider({ socketPath, model: 'x', timeoutMs: 1000 });
    await expect(provider.complete({ messages: [] })).rejects.toThrow(/private/);
  });
});
