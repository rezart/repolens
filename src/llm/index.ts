import type { Config, LLMProviderName } from '../config.js';
import { OpenRouterProvider } from './openrouter.js';
import { ClaudeCliProvider } from './claude-cli.js';
import { CodexCliProvider } from './codex-cli.js';
import type { LLMProvider } from './types.js';
import type { ReasoningEffort } from './claude-cli.js';

export { OpenRouterProvider } from './openrouter.js';
export { ClaudeCliProvider, flattenMessages, withJsonInstruction, JSON_INSTRUCTION } from './claude-cli.js';
export type { CliProviderOptions, ReasoningEffort } from './claude-cli.js';
export { CodexCliProvider } from './codex-cli.js';
export { ProviderError, completeStreaming } from './types.js';
export type { ChatMessage, CompleteRequest, LLMProvider, OnDelta, Role } from './types.js';
export { extractJson, JsonExtractError } from './json.js';

export interface CreateProviderOptions {
  /** Use a different backend than LLM_PROVIDER (for the chat role). */
  provider?: LLMProviderName;
  /** Use a different model than LLM_MODEL. */
  model?: string;
  /** Thinking budget; blank/undefined leaves the backend default alone. */
  reasoningEffort?: ReasoningEffort | '';
}

/**
 * Build an LLM backend from config. Overrides let a second role (chat) run on a
 * different provider/model than reviews without a second Config object.
 */
export function createProvider(config: Config, opts: CreateProviderOptions = {}): LLMProvider {
  const llm = config.llm;
  const provider = opts.provider ?? llm.provider;
  const model = opts.model ?? llm.model;
  const reasoningEffort = opts.reasoningEffort ?? '';

  switch (provider) {
    case 'openrouter':
      if (!llm.openrouterApiKey) {
        throw new Error('OPENROUTER_API_KEY is required to use the openrouter provider');
      }
      if (!model) {
        throw new Error('A model is required for the openrouter provider (set LLM_MODEL or CHAT_MODEL)');
      }
      return new OpenRouterProvider({
        apiKey: llm.openrouterApiKey,
        model,
        baseUrl: llm.openrouterBaseUrl,
        timeoutMs: llm.timeoutMs,
        reasoningEffort,
      });
    case 'claude-cli':
      return new ClaudeCliProvider({
        model: model || undefined,
        bin: llm.claudeBin,
        timeoutMs: llm.timeoutMs,
        reasoningEffort,
      });
    case 'codex-cli':
      return new CodexCliProvider({
        model: model || undefined,
        bin: llm.codexBin,
        timeoutMs: llm.timeoutMs,
        reasoningEffort,
      });
    default: {
      const exhaustive: never = provider;
      throw new Error(`Unknown LLM provider: ${String(exhaustive)}`);
    }
  }
}
