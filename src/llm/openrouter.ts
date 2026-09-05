import { IncompleteResponseError, NetworkProviderError, ProviderError } from './types.js';
import type { ChatMessage, CompleteRequest, LLMProvider, OnDelta } from './types.js';
import type { ReasoningEffort } from './claude-cli.js';
import type { UsageSink } from '../usage/types.js';
import { reviewCostUpperBound, REVIEW_MAX_USD, REVIEW_MAX_OUTPUT, REVIEW_INPUT_PRICE, REVIEW_OUTPUT_PRICE } from '../review/budget.js';

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
  /** Called once when a response reports usage, even if its content is invalid. */
  onUsage?: UsageSink;
}

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const MAX_ATTEMPTS = 3;

const defaultSleep: Sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/** OpenRouter's usage block, requested with `usage: { include: true }`. */
interface RawUsage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  prompt_tokens_details?: { cached_tokens?: unknown } | null;
  cost?: unknown;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }>;
  usage?: RawUsage | null;
  error?: unknown;
}

/** One `data:` frame of a `stream: true` chat completion. */
interface StreamChunk {
  choices?: Array<{ delta?: { content?: unknown }; finish_reason?: unknown }>;
  usage?: RawUsage | null;
}

/** OpenRouter (OpenAI-compatible) chat completions. */
export class OpenRouterProvider implements LLMProvider {
  readonly name = 'openrouter';
  readonly model: string;
  readonly concurrency = 4;
  readonly supportsBatchReview = true;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly sleep: Sleep;
  private readonly effort: ReasoningEffort | undefined;
  private readonly onUsage: UsageSink | undefined;

  constructor(opts: OpenRouterOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const url = new URL(this.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('OpenRouter base URL must use HTTP(S) without credentials');
    }
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.sleep = opts.sleep ?? defaultSleep;
    this.effort = opts.reasoningEffort || undefined;
    this.onUsage = opts.onUsage;
  }

  /**
   * Normalise and hand one usage block to the sink. Silently ignores usage the
   * backend did not report (or reported malformed), and never lets a throwing
   * sink turn a finished completion into a failure.
   *
   * The block has no cache-write field, so Anthropic cache-creation tokens stay
   * counted inside `prompt_tokens` here, while the Claude CLI reports them
   * separately as `cacheWriteTokens`. Cost is unaffected: OpenRouter reports
   * `cost` itself, so those tokens are never re-priced from the token split.
   */
  private reportUsage(usage: RawUsage | null | undefined): void {
    if (!this.onUsage || !usage || typeof usage !== 'object') return;
    const prompt = usage.prompt_tokens;
    const completion = usage.completion_tokens;
    if (typeof prompt !== 'number' || typeof completion !== 'number') return;
    const rawCached = usage.prompt_tokens_details?.cached_tokens;
    const cached = typeof rawCached === 'number' ? rawCached : 0;
    try {
      this.onUsage({
        provider: 'openrouter',
        model: this.model,
        inputTokens: prompt - cached,
        cachedInputTokens: cached,
        cacheWriteTokens: 0,
        outputTokens: completion,
        costUsd: typeof usage.cost === 'number' ? usage.cost : null,
      });
    } catch {
      // Accounting must never break a completion.
    }
  }

  private buildPayload(req: CompleteRequest, streaming: boolean): string {
    const messages: ChatMessage[] = req.system
      ? [{ role: 'system', content: req.system }, ...req.messages]
      : [...req.messages];

    // `usage.include` makes OpenRouter return token counts and the call's cost.
    const body: Record<string, unknown> = { model: this.model, messages, usage: { include: true } };
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.json) body.response_format = { type: 'json_object' };
    if (this.effort) body.reasoning = { effort: this.effort };
    if (streaming) body.stream = true;
    if (req.reviewBudget) {
      if (streaming || !Number.isInteger(req.maxTokens) ||
          req.maxTokens! <= 0 || req.maxTokens! > REVIEW_MAX_OUTPUT || reviewCostUpperBound(req) > REVIEW_MAX_USD) {
        throw new ProviderError('openrouter', 'Review exceeds the $0.25 budget; split this pull request into smaller reviews.');
      }
      body.provider = {
        sort: 'price', require_parameters: true, allow_fallbacks: false,
        max_price: { prompt: REVIEW_INPUT_PRICE, completion: REVIEW_OUTPUT_PRICE, request: 0 },
      };
      delete body.reasoning;
    }
    return JSON.stringify(body);
  }

  async complete(req: CompleteRequest): Promise<string> {
    const { content, finishReason } = await this.readContent(await this.post(this.buildPayload(req, false), req.reviewBudget ? 1 : MAX_ATTEMPTS));
    if (req.reviewBudget && finishReason !== 'stop') {
      throw new IncompleteResponseError('openrouter', 'Review did not finish; refusing to publish an incomplete review.');
    }
    return content;
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
    // OpenRouter sends usage on a late frame (often one with no choices); keep the
    // last one and report it only once the stream has ended successfully.
    let usage: RawUsage | null | undefined;

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
      if (chunk.usage) usage = chunk.usage;
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
    // Flush any multi-byte character the decoder was holding back before the last line is parsed.
    buffer += decoder.decode();
    if (buffer) consumeLine(buffer);
    // A body that ends without [DONE] (or a finish_reason) was cut short; the text
    // gathered so far is an incomplete answer, not a successful one.
    if (!done && !finishReason) {
      throw new ProviderError('openrouter', 'stream ended before [DONE]', res.status, text.slice(0, 200));
    }
    this.reportUsage(usage);
    return text;
  }

  /** POST with retries, returning the successful response. */
  private async post(payload: string, maxAttempts = MAX_ATTEMPTS): Promise<Response> {
    let lastError: ProviderError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
        const netErr = new NetworkProviderError('openrouter', `request failed: ${err instanceof Error ? err.message : String(err)}`);
        if (attempt === maxAttempts) throw netErr;
        lastError = netErr;
        await this.sleep(backoffMs(attempt));
        continue;
      }

      if (res.ok) return res;

      const detail = await safeText(res);
      const err = new ProviderError('openrouter', `HTTP ${res.status}`, res.status, detail);
      if (!isRetryable(res.status) || attempt === maxAttempts) throw err;
      lastError = err;
      await this.sleep(backoffMs(attempt));
    }
    /* c8 ignore next */
    throw lastError ?? new ProviderError('openrouter', 'request failed');
  }

  /** Record any billed usage before validating the completion. */
  private async readContent(res: Response): Promise<{ content: string; finishReason?: string }> {
    let parsed: ChatCompletionResponse;
    const text = await safeText(res);
    try {
      parsed = JSON.parse(text) as ChatCompletionResponse;
    } catch {
      throw new IncompleteResponseError('openrouter', 'response was not JSON', res.status, text.slice(0, 500));
    }
    this.reportUsage(parsed?.usage);
    if (parsed?.error) {
      const code = typeof parsed.error === 'object' && 'code' in parsed.error ? parsed.error.code : undefined;
      throw new ProviderError('openrouter', 'response returned an error', typeof code === 'number' ? code : res.status, text.slice(0, 500));
    }
    const content = parsed?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new IncompleteResponseError('openrouter', 'response had no message content', res.status, text.slice(0, 500));
    }
    return { content, finishReason: parsed.choices?.[0]?.finish_reason };
  }
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
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
