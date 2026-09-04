import type { Config } from '../config.js';
import { ProviderError } from '../llm/types.js';
import type { EmbeddingProvider } from './types.js';

export type { EmbeddingProvider } from './types.js';

export type Sleep = (ms: number) => Promise<void>;

export interface OpenAIEmbeddingsOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  batchSize?: number;
  timeoutMs?: number;
  /** Injectable for tests; defaults to setTimeout. */
  sleep?: Sleep;
}

const DEFAULT_BATCH_SIZE = 64;
const MAX_ATTEMPTS = 2; // one retry

const defaultSleep: Sleep = (ms) => new Promise((res) => setTimeout(res, ms));

interface EmbeddingResponse {
  data?: Array<{ index?: number; embedding?: unknown }>;
}

/** OpenAI-compatible /embeddings endpoint (OpenAI, OpenRouter, Ollama, LM Studio, ...). */
export class OpenAIEmbeddings implements EmbeddingProvider {
  readonly model: string;
  private dim: number | null = null;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly sleep: Sleep;

  constructor(opts: OpenAIEmbeddingsOptions) {
    this.model = opts.model;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  get dimension(): number | null {
    return this.dim;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const vectors = await this.embedBatch(batch);
      out.push(...vectors);
    }
    if (this.dim === null && out.length > 0) this.dim = out[0]!.length;
    return out;
  }

  private async embedBatch(batch: string[]): Promise<number[][]> {
    const payload = JSON.stringify({ model: this.model, input: batch });

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
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
        const netErr = new ProviderError('embeddings', `request failed: ${err instanceof Error ? err.message : String(err)}`);
        if (attempt === MAX_ATTEMPTS) throw netErr;
        await this.sleep(500);
        continue;
      }

      if (res.ok) return await parseVectors(res, batch.length);

      const detail = await safeText(res);
      const err = new ProviderError('embeddings', `HTTP ${res.status}`, res.status, detail);
      if (!isRetryable(res.status) || attempt === MAX_ATTEMPTS) throw err;
      await this.sleep(500);
    }
    /* c8 ignore next */
    throw new ProviderError('embeddings', 'request failed');
  }
}

async function parseVectors(res: Response, expected: number): Promise<number[][]> {
  const text = await safeText(res);
  let parsed: EmbeddingResponse;
  try {
    parsed = JSON.parse(text) as EmbeddingResponse;
  } catch {
    throw new ProviderError('embeddings', 'response was not JSON', res.status, text.slice(0, 500));
  }
  const rows = parsed.data;
  if (!Array.isArray(rows) || rows.length !== expected) {
    throw new ProviderError(
      'embeddings',
      `expected ${expected} vectors, got ${Array.isArray(rows) ? rows.length : 0}`,
      res.status,
      text.slice(0, 500),
    );
  }
  const ordered = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return ordered.map((row) => {
    const v = row.embedding;
    if (!Array.isArray(v) || v.some((n) => typeof n !== 'number')) {
      throw new ProviderError('embeddings', 'response contained a non-numeric embedding', res.status);
    }
    return v as number[];
  });
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/** Build the configured embedding backend, or null when embeddings are disabled. */
export function createEmbeddings(config: Config): EmbeddingProvider | null {
  if (!config.embedding) return null;
  return new OpenAIEmbeddings({
    baseUrl: config.embedding.baseUrl,
    apiKey: config.embedding.apiKey,
    model: config.embedding.model,
    timeoutMs: config.llm.timeoutMs,
  });
}
