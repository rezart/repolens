import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { IncompleteResponseError, NetworkProviderError, ProviderError } from './types.js';
import type { CompleteRequest, LLMProvider } from './types.js';
import type { ReasoningEffort } from './claude-cli.js';
import type { UsageSink } from '../usage/types.js';

const MAX_INPUT = 256 * 1024;
const MAX_OUTPUT = 1024 * 1024;
const blockers = new Set(['authentication_required', 'subscription_exhausted', 'model_unavailable',
  'unsafe_tool_surface', 'incomplete_output']);
const count = z.number().int().nonnegative().nullable().optional();
const resultSchema = z.strictObject({
  text: z.string().refine((value) => value.trim().length > 0),
  thread_id: z.string().min(1).max(128), turn_id: z.string().min(1).max(128),
  input_tokens: count, output_tokens: count, cached_input_tokens: count,
});
const requestSchema = z.strictObject({
  system: z.string().optional(),
  messages: z.array(z.strictObject({ role: z.enum(['system', 'user', 'assistant']), content: z.string() })),
  json: z.boolean().optional(), jsonSchema: z.record(z.string(), z.unknown()).optional(),
  maxTokens: z.number().optional(), temperature: z.number().optional(), reviewBudget: z.boolean().optional(),
  reviewStage: z.enum(['initial', 'escalation', 'verification', 'arbitration']).optional(),
  signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal).optional(),
});

export interface SubscriptionOptions {
  socketPath: string;
  model: string;
  reasoningEffort?: ReasoningEffort | '';
  timeoutMs: number;
  onUsage?: UsageSink;
}

function encodeRequest(req: CompleteRequest, model: string, effort: string): string {
  const input = JSON.stringify({ system: req.system ?? '', messages: req.messages,
    ...(req.json || req.jsonSchema ? { outputInstruction: req.jsonSchema
      ? 'Return one JSON value matching the supplied output schema.'
      : 'Return a single JSON object and nothing else.' } : {}),
  });
  return JSON.stringify({ model, effort, input, ...(req.jsonSchema ? { output_schema: req.jsonSchema } : {}) });
}

/** Byte planning only; subscription turns have no enforceable dollar/token route cap. */
export function subscriptionRequestSize(req: CompleteRequest, model: string): number {
  return Buffer.byteLength(encodeRequest(req, model, 'medium'));
}

/** Text-only private IPC. This provider has no subprocess or TCP fallback. */
export class SubscriptionProvider implements LLMProvider {
  readonly name = 'subscription';
  readonly concurrency = 1;
  readonly model: string;
  private readonly socketPath: string;
  private readonly effort: string;
  private readonly timeoutMs: number;
  private readonly onUsage: UsageSink | undefined;

  constructor(options: SubscriptionOptions) {
    if (!path.isAbsolute(options.socketPath)) throw new ProviderError('subscription', 'socket path must be absolute');
    if (!options.model || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new ProviderError('subscription', 'invalid completion configuration');
    }
    this.socketPath = options.socketPath;
    this.model = options.model;
    this.effort = options.reasoningEffort || 'medium';
    this.timeoutMs = Math.min(options.timeoutMs, 300_000);
    this.onUsage = options.onUsage;
  }

  async complete(request: CompleteRequest): Promise<string> {
    const parsed = requestSchema.safeParse(request);
    if (!parsed.success) throw new ProviderError(this.name, 'unsupported completion request');
    const req = parsed.data;
    if (req.maxTokens !== undefined || req.temperature !== undefined || req.reviewBudget) {
      throw new ProviderError(this.name, 'subscription requests do not support sampling or dollar/token route budgets');
    }
    if (req.signal?.aborted) throw new ProviderError(this.name, 'cancelled');
    let schema: z.ZodType | undefined;
    if (req.jsonSchema) {
      try {
        schema = z.fromJSONSchema(req.jsonSchema, { registry: z.registry() });
      } catch {
        throw new ProviderError(this.name, 'unsupported output schema');
      }
    }
    // JSON framing preserves each role and prevents content from replacing the
    // envelope's system instructions. The broker receives no execution controls.
    const body = encodeRequest(req, this.model, this.effort);
    if (Buffer.byteLength(body) > MAX_INPUT) throw new ProviderError(this.name, 'request too large');
    try {
      const [socket, directory] = await Promise.all([fs.lstat(this.socketPath), fs.lstat(path.dirname(this.socketPath))]);
      if (!socket.isSocket() || socket.mode & 0o007 || !directory.isDirectory() || directory.mode & 0o007) {
        throw new Error('invalid socket');
      }
    } catch {
      throw new ProviderError(this.name, 'private completion socket is unavailable');
    }
    const response = await this.exchange(body, req.signal);
    const result = resultSchema.safeParse(response);
    if (!result.success) throw new IncompleteResponseError(this.name, 'incomplete or unsupported broker result');
    const value = result.data;
    if (typeof value.input_tokens === 'number' && typeof value.output_tokens === 'number'
        && (value.cached_input_tokens == null || value.cached_input_tokens <= value.input_tokens)) {
      try {
        this.onUsage?.({ provider: this.name, model: this.model,
          // Without a cache breakdown, retain the known total in the input bucket.
          // Zero here means no separately measured cache usage, not a measured cache miss.
          inputTokens: value.input_tokens - (value.cached_input_tokens ?? 0),
          cachedInputTokens: value.cached_input_tokens ?? 0, cacheWriteTokens: 0,
          outputTokens: value.output_tokens, costUsd: null });
      } catch { /* A failed usage sink must not repeat inference. */ }
    }
    if (req.json || schema) {
      try {
        const output: unknown = JSON.parse(value.text);
        if (schema) schema.parse(output);
        else if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error('expected object');
      } catch {
        throw new IncompleteResponseError(this.name, 'invalid structured output');
      }
    }
    return value.text;
  }

  private exchange(body: string, signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (error?: Error, result?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) { reject(error); request.destroy(); }
        else resolve(result);
      };
      const request = http.request({ socketPath: this.socketPath, path: '/complete', method: 'POST',
        agent: false, signal,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_OUTPUT) return finish(new IncompleteResponseError(this.name, 'response too large'));
          chunks.push(chunk);
        });
        response.on('aborted', () => finish(new IncompleteResponseError(this.name, 'incomplete response')));
        response.on('error', () => finish(new NetworkProviderError(this.name, 'completion transport failed')));
        response.on('end', () => {
          if (settled) return;
          let payload: unknown;
          try { payload = JSON.parse(Buffer.concat(chunks).toString()); }
          catch { return finish(new IncompleteResponseError(this.name, 'incomplete response')); }
          if (response.statusCode !== 200) {
            const error = payload && typeof payload === 'object' && 'error' in payload ? payload.error : undefined;
            return finish(new ProviderError(this.name, typeof error === 'string' && blockers.has(error) ? error : 'broker unavailable', response.statusCode));
          }
          finish(undefined, payload);
        });
      });
      timer = setTimeout(() => finish(new NetworkProviderError(this.name, 'completion timed out')), this.timeoutMs);
      request.on('error', () => finish(signal?.aborted
        ? new ProviderError(this.name, 'cancelled') : new NetworkProviderError(this.name, 'completion transport failed')));
      request.end(body);
    });
  }
}
