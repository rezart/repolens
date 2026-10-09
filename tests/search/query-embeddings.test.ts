import { describe, it, expect } from 'vitest';
import { QueryEmbeddings } from '../../src/search/query-embeddings.js';
import type { EmbeddingProvider } from '../../src/embeddings/types.js';

const vector = (query: string) => [Number(query), 1, 0];
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function provider(embed: EmbeddingProvider['embed']): EmbeddingProvider {
  return { model: 'fake', dimension: 3, embed };
}

describe('query embedding batches', () => {
  it('batches and deduplicates concurrent queries while preserving each vector', async () => {
    const batches: string[][] = [];
    const queries = new QueryEmbeddings(provider(async (texts) => {
      batches.push(texts);
      return texts.map(vector);
    }), () => 3);
    const input = Array.from({ length: 80 }, (_, i) => String(i % 40));
    expect(await Promise.all(input.map((query) => queries.get(query)))).toEqual(input.map(vector));
    expect(batches.map((batch) => batch.length)).toEqual([16, 16, 8]);
    expect(batches.flat()).toEqual(Array.from({ length: 40 }, (_, i) => String(i)));
    await queries.get('0');
    expect(batches).toHaveLength(3);
  });

  it('limits concurrent batches even as more queries arrive', async () => {
    let active = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const queries = new QueryEmbeddings(provider(async (texts) => {
      peak = Math.max(peak, ++active);
      await new Promise<void>((resolve) => release.push(resolve));
      active--;
      return texts.map(vector);
    }), () => 3);
    const result = Promise.all(Array.from({ length: 65 }, (_, i) => queries.get(String(i))));
    await tick();
    expect(release).toHaveLength(2);
    const more = queries.get('100');
    for (let i = 0; i < 6; i++) {
      release.shift()?.();
      await tick();
    }
    expect(await result).toHaveLength(65);
    expect(await more).toEqual(vector('100'));
    expect(peak).toBe(2);
  });

  it.each(['failure', 'missing', 'dimension', 'nonfinite'])('does not cache a %s batch and retries on the next retrieval', async (failure) => {
    let calls = 0;
    const queries = new QueryEmbeddings(provider(async (texts) => {
      calls++;
      if (calls === 1) {
        if (failure === 'failure') throw new Error('offline');
        if (failure === 'missing') return [];
        if (failure === 'dimension') return texts.map(() => [1]);
        return texts.map(() => [NaN, 0, 0]);
      }
      return texts.map(vector);
    }), () => 3);
    const results = await Promise.allSettled([queries.get('1'), queries.get('1'), queries.get('2')]);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(await queries.get('1')).toEqual(vector('1'));
    expect(calls).toBe(2);
  });

  it('bounds the vector cache and refreshes recently used entries', async () => {
    const batches: string[][] = [];
    const queries = new QueryEmbeddings(provider(async (texts) => {
      batches.push(texts);
      return texts.map(vector);
    }), () => 3);
    await Promise.all(Array.from({ length: 128 }, (_, i) => queries.get(String(i))));
    await queries.get('0');
    await queries.get('128');
    const before = batches.length;
    await queries.get('0');
    expect(batches).toHaveLength(before);
    await queries.get('1');
    expect(batches.at(-1)).toEqual(['1']);
  });
});
