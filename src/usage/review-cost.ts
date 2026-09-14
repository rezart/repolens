import { AsyncLocalStorage } from 'node:async_hooks';

// Each completion can report multiple model costs; isolate concurrent calls.
export const reviewCallCost = new AsyncLocalStorage<{
  reported: boolean;
  costUsd: number | null;
  stage?: string;
  pass?: string;
  /** Set while a budgeted checkpoint call is in flight; enables the durable usage path. */
  attemptId?: string;
  /** Sequence of the next durable usage row; the sink advances it exactly once per event. */
  usageSeq?: number;
  /** Set to the exact error when persisting usage failed; the caller must refuse to advance. */
  durableWriteFailed?: Error;
}>();
