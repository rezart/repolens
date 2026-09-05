import type { CompleteRequest } from '../llm/types.js';

export const REVIEW_INPUT_PRICE = 0.4;
export const REVIEW_OUTPUT_PRICE = 2;
export const REVIEW_MAX_OUTPUT = 8000;
// Reserve half a cent below the user's $0.05 ceiling.
export const REVIEW_MAX_USD = 0.045;

export function reviewCostUpperBound(req: CompleteRequest): number {
  // ponytail: UTF-8 bytes bound byte-level BPE tokens conservatively; use the
  // exact Qwen tokenizer if this rejects practical reviews that would fit.
  const bytes = Buffer.byteLength(req.system ?? '', 'utf8') +
    req.messages.reduce((sum, m) => sum + Buffer.byteLength(m.content, 'utf8'), 0);
  const input = bytes + 1024 + 32 * req.messages.length;
  return (input * REVIEW_INPUT_PRICE + (req.maxTokens ?? REVIEW_MAX_OUTPUT) * REVIEW_OUTPUT_PRICE) / 1e6;
}
