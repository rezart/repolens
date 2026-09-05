import type { Config, LLMProviderName } from '../config.js';
import { OpenRouterProvider } from './openrouter.js';
import { ClaudeCliProvider } from './claude-cli.js';
import type { LLMProvider } from './types.js';
import type { ReasoningEffort } from './claude-cli.js';
import type { UsageSink } from '../usage/types.js';

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
  /** Thinking budget; omitted means LLM_REASONING_EFFORT, `''` leaves the backend default alone. */
  reasoningEffort?: ReasoningEffort | '';
  /** Where the backend reports each call's tokens; one sink per role. */
  onUsage?: UsageSink;
}

/**
 * Build an LLM backend from config. Overrides let a second role (chat) run on a
 * different provider/model than reviews without a second Config object.
 */
export function createProvider(config: Config, opts: CreateProviderOptions = {}): LLMProvider {
  const llm = config.llm;
  const provider = opts.provider ?? llm.provider;
  if (provider === 'codex-cli') {
    throw new Error('codex-cli is temporarily disabled for security; use claude-cli or openrouter');
  }
  const model = opts.model ?? llm.model;
  // `??` so an explicit '' override still means "leave the backend default alone".
  const reasoningEffort = opts.reasoningEffort ?? llm.reasoningEffort;

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
        onUsage: opts.onUsage,
      });
    case 'claude-cli':
      return new ClaudeCliProvider({
        model: model || undefined,
        bin: llm.claudeBin,
        timeoutMs: llm.timeoutMs,
        reasoningEffort,
        onUsage: opts.onUsage,
      });
    default: {
      const exhaustive: never = provider;
      throw new Error(`Unknown LLM provider: ${String(exhaustive)}`);
    }
  }
}
