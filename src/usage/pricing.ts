import type { Db } from '../db.js';

/** List prices in USD per token. */
export interface ModelPrice {
  prompt: number;
  completion: number;
  inputCacheRead: number;
  inputCacheWrite: number;
}

/** OpenRouter's public price list as of `fetchedAt`, keyed by model id. */
export interface PriceList {
  fetchedAt: string;
  models: Record<string, ModelPrice>;
}

export interface OpenRouterPricingOptions {
  db: Db;
  /** e.g. https://openrouter.ai/api/v1 */
  baseUrl: string;
  fetch?: typeof fetch;
  ttlMs?: number;
  /** How long a failed refresh is left alone before it is tried again. */
  retryAfterMs?: number;
  /** Injectable for tests; defaults to Date.now. */
  now?: () => number;
}

const META_KEY = 'openrouter_pricing';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETRY_AFTER_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;

/** The model name that stands in for "whatever the CLI defaults to", which we cannot price. */
const UNKNOWN_MODEL = 'default';

/** One entry of the `/models` response, before validation. */
interface RawModel {
  id?: unknown;
  pricing?: Record<string, unknown>;
}

/**
 * OpenRouter's public model list, used to estimate a cost for calls that report
 * none (the subscription CLIs). The list is cached in `meta` and refreshed at
 * most once per TTL; a failed refresh keeps whatever we already had, because a
 * stale price is a far better estimate than no price at all.
 */
export class OpenRouterPricing {
  private readonly db: Db;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly ttlMs: number;
  private readonly retryAfterMs: number;
  private readonly now: () => number;

  private list: PriceList | null = null;
  private error: string | null = null;
  /** When the last refresh was started, so a failed one is not retried per request. */
  private lastAttemptAt: number | null = null;
  /** The refresh currently in flight, so concurrent callers share one fetch. */
  private pending: Promise<void> | null = null;

  constructor(opts: OpenRouterPricingOptions) {
    this.db = opts.db;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.retryAfterMs = opts.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
    this.now = opts.now ?? Date.now;
    this.list = this.load();
  }

  /** Refresh if stale. Never throws: a failure is reported alongside the old list. */
  async ensure(): Promise<{ list: PriceList | null; error: string | null }> {
    if (this.isFresh()) return { list: this.list, error: this.error };
    // While OpenRouter is unreachable every call would otherwise wait out the
    // fetch timeout again; the report is better served late prices than a stall.
    if (this.coolingDown()) return { list: this.list, error: this.error };
    if (!this.pending) {
      this.pending = this.refresh().finally(() => {
        this.pending = null;
      });
    }
    await this.pending;
    return { list: this.list, error: this.error };
  }

  /** The price of the first candidate id present in the list, or null. */
  static resolve(list: PriceList, provider: string, model: string): ModelPrice | null {
    for (const id of candidateIds(provider, model)) {
      const price = list.models[id];
      if (price) return price;
    }
    return null;
  }

  /** List-price estimate in USD for one call's tokens. */
  static estimate(
    price: ModelPrice,
    tokens: { inputTokens: number; cachedInputTokens: number; cacheWriteTokens: number; outputTokens: number },
  ): number {
    return (
      tokens.inputTokens * price.prompt +
      tokens.cachedInputTokens * price.inputCacheRead +
      tokens.cacheWriteTokens * price.inputCacheWrite +
      tokens.outputTokens * price.completion
    );
  }

  /** True while the last attempt failed recently enough not to be worth repeating. */
  private coolingDown(): boolean {
    if (this.error === null || this.lastAttemptAt === null) return false;
    return this.now() - this.lastAttemptAt < this.retryAfterMs;
  }

  private isFresh(): boolean {
    if (!this.list) return false;
    const at = Date.parse(this.list.fetchedAt);
    if (Number.isNaN(at)) return false;
    return this.now() - at < this.ttlMs;
  }

  private load(): PriceList | null {
    const stored = this.db.getMeta(META_KEY);
    if (!stored) return null;
    try {
      const parsed = JSON.parse(stored) as PriceList;
      if (typeof parsed?.fetchedAt !== 'string' || typeof parsed?.models !== 'object' || !parsed.models) return null;
      return parsed;
    } catch {
      // A corrupt value is simply a cache miss.
      return null;
    }
  }

  private async refresh(): Promise<void> {
    this.lastAttemptAt = this.now();
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: { 'HTTP-Referer': 'https://github.com/repolens', 'X-Title': 'RepoLens' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.error = `HTTP ${res.status}`;
        return;
      }
      const text = await res.text();
      let body: { data?: unknown };
      try {
        body = JSON.parse(text) as { data?: unknown };
      } catch {
        this.error = 'model list was not JSON';
        return;
      }
      if (!Array.isArray(body.data)) {
        this.error = 'model list had no data array';
        return;
      }
      const list: PriceList = {
        fetchedAt: new Date(this.now()).toISOString(),
        models: parseModels(body.data as RawModel[]),
      };
      this.list = list;
      this.error = null;
      this.db.setMeta(META_KEY, JSON.stringify(list));
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    }
  }
}

function parseModels(entries: RawModel[]): Record<string, ModelPrice> {
  const models: Record<string, ModelPrice> = {};
  for (const entry of entries) {
    if (typeof entry?.id !== 'string') continue;
    const pricing = entry.pricing;
    if (!pricing || typeof pricing !== 'object') continue;
    const prompt = num(pricing.prompt);
    const completion = num(pricing.completion);
    if (prompt === null || completion === null) continue;
    // Providers without prompt caching omit these; charging the fresh input rate
    // is the right assumption there.
    models[entry.id] = {
      prompt,
      completion,
      inputCacheRead: num(pricing.input_cache_read) ?? prompt,
      inputCacheWrite: num(pricing.input_cache_write) ?? prompt,
    };
  }
  return models;
}

/**
 * OpenRouter prices are decimal strings in USD per token; a bare number is
 * accepted too. A negative value is not a price: "-1" marks a variable-priced
 * auto-router, so such an entry is skipped rather than billed as a credit.
 */
function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * The OpenRouter ids worth trying for a provider/model pair, best guess first.
 * The CLIs name models the way their vendor does, not the way OpenRouter does.
 */
export function candidateIds(provider: string, model: string): string[] {
  if (!model || model === UNKNOWN_MODEL) return [];

  switch (provider) {
    case 'openrouter':
      // A route suffix (":nitro", ":floor") is not part of the priced id.
      return dedupe([model, model.split(':')[0]!]);
    case 'claude-cli':
      if (model === 'haiku' || model === 'sonnet' || model === 'opus') {
        return [`~anthropic/claude-${model}-latest`];
      }
      // The CLI writes "claude-haiku-4-5"; OpenRouter writes "claude-haiku-4.5".
      return dedupe([`anthropic/${model.replace(/-(\d+)-(\d+)$/, '-$1.$2')}`, `anthropic/${model}`]);
    case 'codex-cli':
      return [`openai/${model}`];
    case 'embeddings':
      return dedupe([model, `openai/${model}`]);
    default:
      return [model];
  }
}

function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}
