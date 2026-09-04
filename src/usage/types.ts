/** Which part of RepoLens made the call. */
export type UsageRole = 'review' | 'chat' | 'embed';

/**
 * One backend call's token usage, normalised so the same pricing formula works
 * for every provider: `inputTokens` is fresh (uncached) input, cache reads and
 * writes are separate, and `costUsd` is only set when the backend reported one.
 */
export interface UsageRecord {
  provider: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export type UsageSink = (record: UsageRecord) => void;
