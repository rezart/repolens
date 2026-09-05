export type Role = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface CompleteRequest {
  system?: string;
  messages: ChatMessage[];
  /** Ask the model for a single JSON object. Callers parse with extractJson(). */
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  /** Single-attempt review budget; disables retries and caps routing prices. */
  reviewBudget?: boolean;
}

/** Receives incremental text as the model produces it. */
export type OnDelta = (text: string) => void;

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  /** How many completions may run at once. CLI providers use 1. */
  readonly concurrency: number;
  /** Supports a whole-PR JSON review with enforced routing prices and no hidden retries. */
  readonly supportsBatchReview?: boolean;
  /** Ordered alternatives for batch reviews; selection is local to each review. */
  readonly reviewFallbacks?: readonly LLMProvider[];
  complete(req: CompleteRequest): Promise<string>;
  /**
   * Optional incremental variant of `complete`. Resolves with the full text;
   * `onDelta` receives each fragment as it arrives.
   */
  stream?(req: CompleteRequest, onDelta: OnDelta): Promise<string>;
}

/**
 * Stream when the provider can, otherwise fall back to a single `complete`
 * call and emit the whole answer as one delta. Callers can always assume the
 * concatenation of the deltas equals the resolved text.
 */
export async function completeStreaming(
  llm: LLMProvider,
  req: CompleteRequest,
  onDelta: OnDelta,
): Promise<string> {
  if (typeof llm.stream === 'function') return llm.stream(req, onDelta);
  const text = await llm.complete(req);
  if (text) onDelta(text);
  return text;
}

export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    public readonly status?: number,
    public readonly detail?: string,
  ) {
    super(`[${provider}] ${message}`);
    this.name = 'ProviderError';
  }
}

/** A completed model call whose output is incomplete and can be retried. */
export class IncompleteResponseError extends ProviderError {}

/** A transport failure that may already have consumed inference; reserve its full budget. */
export class NetworkProviderError extends ProviderError {}
