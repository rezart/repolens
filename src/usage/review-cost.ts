import { AsyncLocalStorage } from 'node:async_hooks';

// Each completion can report multiple model costs; isolate concurrent calls.
export const reviewCallCost = new AsyncLocalStorage<{
  reported: boolean;
  costUsd: number | null;
}>();
