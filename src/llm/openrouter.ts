import { ProviderError } from './types.js';
import type { ChatMessage, CompleteRequest, LLMProvider } from './types.js';

export type Sleep = (ms: number) => Promise<void>;

export interface OpenRouterOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Injectable for tests; defaults to setTimeout. */
  sleep?: Sleep;
}

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const MAX_ATTEMPTS = 3;

const defaultSleep: Sleep = (ms) => new Promise((res) => setTimeout(res, ms));

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
  error?: unknown;
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

  constructor(opts: OpenRouterOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async complete(req: CompleteRequest): Promise<string> {
    const messages: ChatMessage[] = req.system
      ? [{ role: 'system', content: req.system }, ...req.messages]
      : [...req.messages];

    const body: Record<string, unknown> = { model: this.model, messages };
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.json) body.response_format = { type: 'json_object' };

    const payload = JSON.stringify(body);
    let lastError: ProviderError | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
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

      if (res.ok) return this.readContent(res);

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
