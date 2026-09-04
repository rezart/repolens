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
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  /** How many completions may run at once. CLI providers use 1. */
  readonly concurrency: number;
  complete(req: CompleteRequest): Promise<string>;
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
