import { ProviderError } from './types.js';
import type { ChatMessage, CompleteRequest, LLMProvider, OnDelta } from './types.js';
import type { ReasoningEffort } from './claude-cli.js';

export type Sleep = (ms: number) => Promise<void>;

export interface OpenRouterOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Injectable for tests; defaults to setTimeout. */
  sleep?: Sleep;
  /** Sent as `reasoning: { effort }`. Blank/undefined omits it. */
  reasoningEffort?: ReasoningEffort | '';
}

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const MAX_ATTEMPTS = 3;

const defaultSleep: Sleep = (ms) => new Promise((res) => setTimeout(res, ms));

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
  error?: unknown;
}

/** One `data:` frame of a `stream: true` chat completion. */
interface StreamChunk {
  choices?: Array<{ delta?: { content?: unknown }; finish_reason?: unknown }>;
}

/** OpenRouter (OpenAI-compatible) chat completions. */
export class OpenRouterProvider implements LLMProvider {
  readonly name = 'openrouter';
  readonly model: string;
  readonly concurrency = 4;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly sleep: Sleep;
  private readonly effort: ReasoningEffort | undefined;

  constructor(opts: OpenRouterOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.sleep = opts.sleep ?? defaultSleep;
    this.effort = opts.reasoningEffort || undefined;
  }

  private buildPayload(req: CompleteRequest, streaming: boolean): string {
    const messages: ChatMessage[] = req.system
      ? [{ role: 'system', content: req.system }, ...req.messages]
      : [...req.messages];

    const body: Record<string, unknown> = { model: this.model, messages };
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.json) body.response_format = { type: 'json_object' };
    if (this.effort) body.reasoning = { effort: this.effort };
    if (streaming) body.stream = true;
    return JSON.stringify(body);
  }

  async complete(req: CompleteRequest): Promise<string> {
    return this.readContent(await this.post(this.buildPayload(req, false)));
  }

  /**
   * Server-sent chat completions. Retries only cover the initial response
   * status: once the body starts flowing a failure is surfaced to the caller,
   * because deltas have already been handed out.
   */
  async stream(req: CompleteRequest, onDelta: OnDelta): Promise<string> {
    const res = await this.post(this.buildPayload(req, true));
    const body = res.body;
    if (!body) throw new ProviderError('openrouter', 'streaming response had no body', res.status);

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let done = false;
    let finishReason = false;

    const consumeLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) return; // keep-alive comment
      if (!trimmed.startsWith('data:')) return;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') {
        done = true;
        return;
      }
      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(data) as StreamChunk;
      } catch {
        // A frame we cannot parse may be the one carrying the answer: fail loudly
        // rather than returning a silently truncated response.
        throw new ProviderError('openrouter', `malformed stream frame: ${data.slice(0, 200)}`, res.status);
      }
      if (chunk.choices?.[0]?.finish_reason) finishReason = true;
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta !== 'string' || !delta) return;
      text += delta;
      onDelta(delta);
    };

    for (;;) {
      const { value, done: finished } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf('\n');
        while (nl >= 0) {
          consumeLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf('\n');
        }
      }
      if (finished) break;
      if (done) {
        // The server may hold the connection open after [DONE]; stop reading.
        await reader.cancel().catch(() => {});
        break;
      }
    }
    if (buffer) consumeLine(buffer);
    // A body that ends without [DONE] (or a finish_reason) was cut short; the text
    // gathered so far is an incomplete answer, not a successful one.
    if (!done && !finishReason) {
      throw new ProviderError('openrouter', 'stream ended before [DONE]', res.status, text.slice(0, 200));
    }
    return text;
  }

  /** POST with retries, returning the successful response. */
  private async post(payload: string): Promise<Response> {
    let lastError: ProviderError | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/repolens',
            'X-Title': 'RepoLens',
          },
          body: payload,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        // DNS failures, resets and timeouts arrive as a thrown error, not a response.
        const netErr = new ProviderError('openrouter', `request failed: ${err instanceof Error ? err.message : String(err)}`);
        if (attempt === MAX_ATTEMPTS) throw netErr;
        lastError = netErr;
        await this.sleep(backoffMs(attempt));
        continue;
      }

      if (res.ok) return res;

      const detail = await safeText(res);
      const err = new ProviderError('openrouter', `HTTP ${res.status}`, res.status, detail);
      if (!isRetryable(res.status) || attempt === MAX_ATTEMPTS) throw err;
      lastError = err;
      await this.sleep(backoffMs(attempt));
    }
    /* c8 ignore next */
    throw lastError ?? new ProviderError('openrouter', 'request failed');
  }

  private async readContent(res: Response): Promise<string> {
    let parsed: ChatCompletionResponse;
    const text = await safeText(res);
    try {
      parsed = JSON.parse(text) as ChatCompletionResponse;
    } catch {
      throw new ProviderError('openrouter', 'response was not JSON', res.status, text.slice(0, 500));
    }
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new ProviderError('openrouter', 'response had no message content', res.status, text.slice(0, 500));
    }
    return content;
  }
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function backoffMs(attempt: number): number {
  return 500 * 2 ** (attempt - 1);
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
