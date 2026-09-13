import { metrics, type Attributes } from '@opentelemetry/api';
import type { DiffFile } from './diff.js';

/** Counters describe executions, not distinct PRs; forced reviews count again. */
export function countReview(name: string, value: number, attributes: Attributes = {}): void {
  try {
    metrics.getMeter('repolens.review').createCounter(`repolens.review.${name}`).add(value, attributes);
  } catch {
    // Observability must never fail a review or prevent publication.
  }
}

export function recordReviewCall(seconds: number, attributes: Attributes): void {
  countReview('llm.calls', 1, attributes);
  try {
    metrics.getMeter('repolens.review').createHistogram('repolens.review.llm.duration', { unit: 's' }).record(seconds, attributes);
  } catch {
    // Observability must never fail a review.
  }
}

/** Selected diff scope, once per uncached run; not all prompt context or retry exposure. */
export function recordReviewScope(files: DiffFile[]): void {
  countReview('files', files.length);
  const lines = { add: 0, del: 0, ctx: 0 };
  for (const file of files) for (const hunk of file.hunks) for (const line of hunk.lines) lines[line.type]++;
  for (const [change, value] of Object.entries(lines)) countReview('diff_lines', value, { change });
}
