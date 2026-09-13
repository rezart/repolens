import type { CompleteRequest } from '../llm/types.js';

export const REVIEW_INPUT_PRICE = 0.4;
export const REVIEW_OUTPUT_PRICE = 2;
export const REVIEW_VERIFIER_INPUT_PRICE = 1.1;
export const REVIEW_VERIFIER_OUTPUT_PRICE = 3.2;
// Route caps leave room for Kimi's listed price while allowing other providers
// up to the requested stage ceiling.
export const REVIEW_ESCALATION_INPUT_PRICE = 1;
export const REVIEW_ESCALATION_OUTPUT_PRICE = 4;
export const REVIEW_ARBITRATION_INPUT_PRICE = 10;
export const REVIEW_ARBITRATION_OUTPUT_PRICE = 50;
export const REVIEW_ARBITRATION_MAX_OUTPUT = 600;
export const REVIEW_MAX_OUTPUT = 8000;
export const REVIEW_VERIFIER_MAX_OUTPUT = 6000;
export const REVIEW_ESCALATION_MAX_OUTPUT = 16000;
// Reserve half a cent below the benchmark's $0.50 ceiling.
export const REVIEW_MAX_USD = 0.495;

export function reviewCostUpperBound(req: CompleteRequest): number {
  // ponytail: UTF-8 bytes bound byte-level BPE tokens conservatively; use the
  // exact Qwen tokenizer if this rejects practical reviews that would fit.
  const bytes = Buffer.byteLength(req.system ?? '', 'utf8') +
    req.messages.reduce((sum, m) => sum + Buffer.byteLength(m.content, 'utf8'), 0) +
    (req.jsonSchema ? Buffer.byteLength(JSON.stringify(req.jsonSchema), 'utf8') : 0);
  const input = bytes + 1024 + 32 * req.messages.length;
  const inputPrice = req.reviewStage === 'arbitration' ? REVIEW_ARBITRATION_INPUT_PRICE : req.reviewStage === 'escalation' ? REVIEW_ESCALATION_INPUT_PRICE : req.reviewStage === 'verification' ? REVIEW_VERIFIER_INPUT_PRICE : REVIEW_INPUT_PRICE;
  const outputPrice = req.reviewStage === 'arbitration' ? REVIEW_ARBITRATION_OUTPUT_PRICE : req.reviewStage === 'escalation' ? REVIEW_ESCALATION_OUTPUT_PRICE : req.reviewStage === 'verification' ? REVIEW_VERIFIER_OUTPUT_PRICE : REVIEW_OUTPUT_PRICE;
  const maxOutput = req.maxTokens ?? (req.reviewStage === 'escalation' ? REVIEW_ESCALATION_MAX_OUTPUT : req.reviewStage === 'verification' ? REVIEW_VERIFIER_MAX_OUTPUT : REVIEW_MAX_OUTPUT);
  return (input * inputPrice + maxOutput * outputPrice) / 1e6;
}
