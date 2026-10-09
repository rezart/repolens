import type { EmbeddingProvider } from '../embeddings/types.js';
import { traceOperation } from '../telemetry.js';

const BATCH_SIZE = 16;
const CONCURRENCY = 2;
const CACHE_SIZE = 128;

interface PendingQuery {
  query: string;
  resolve: (vector: number[]) => void;
  reject: (error: unknown) => void;
}

/** Cache vectors, never search results: every retrieval still reads the current index. */
export class QueryEmbeddings {
  private cache = new Map<string, number[]>();
  private pending = new Map<string, Promise<number[]>>();
  private queue: PendingQuery[] = [];
  private active = 0;
  private scheduled = false;

  constructor(private readonly provider: EmbeddingProvider, private readonly dimension: () => number | null) {}

  get(query: string): Promise<number[]> {
    const cached = this.cache.get(query);
    if (cached) {
      this.cache.delete(query);
      this.cache.set(query, cached);
      return Promise.resolve(cached);
    }
    const existing = this.pending.get(query);
    if (existing) return existing;
    const promise = new Promise<number[]>((resolve, reject) => this.queue.push({ query, resolve, reject }));
    this.pending.set(query, promise);
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        this.drain();
      });
    }
    return promise;
  }

  private drain(): void {
    while (this.active < CONCURRENCY && this.queue.length) {
      const batch = this.queue.splice(0, BATCH_SIZE);
      this.active++;
      void this.run(batch);
    }
  }

  private async run(batch: PendingQuery[]): Promise<void> {
    try {
      const vectors = await traceOperation('retrieval.query-embeddings', () => this.provider.embed(batch.map(({ query }) => query)), {
        'embedding.model': this.provider.model, 'embedding.batch_size': batch.length,
      });
      const dimension = this.dimension();
      if (vectors.length !== batch.length || vectors.some((vector) => !Array.isArray(vector) || vector.length !== dimension || vector.some((value) => !Number.isFinite(value)))) {
        throw new Error('Query embedding batch returned invalid vectors');
      }
      for (let i = 0; i < batch.length; i++) {
        const { query, resolve } = batch[i]!;
        const vector = vectors[i]!;
        this.cache.set(query, vector);
        if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
        this.pending.delete(query);
        resolve(vector);
      }
    } catch (error) {
      for (const { query, reject } of batch) {
        this.pending.delete(query);
        reject(error);
      }
    } finally {
      this.active--;
      this.drain();
    }
  }
}
