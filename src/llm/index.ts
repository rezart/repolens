import type { Config } from '../config.js';
import { OpenRouterProvider } from './openrouter.js';
import { ClaudeCliProvider } from './claude-cli.js';
import { CodexCliProvider } from './codex-cli.js';
import type { LLMProvider } from './types.js';

export { OpenRouterProvider } from './openrouter.js';
export { ClaudeCliProvider, flattenMessages, withJsonInstruction, JSON_INSTRUCTION } from './claude-cli.js';
export type { CliProviderOptions } from './claude-cli.js';
export { CodexCliProvider } from './codex-cli.js';
export { ProviderError } from './types.js';
export type { ChatMessage, CompleteRequest, LLMProvider, Role } from './types.js';
export { extractJson, JsonExtractError } from './json.js';

/** Build the configured LLM backend. */
export function createProvider(config: Config): LLMProvider {
  const llm = config.llm;
  switch (llm.provider) {
    case 'openrouter':
      return new OpenRouterProvider({
        apiKey: llm.openrouterApiKey,
        model: llm.model,
        baseUrl: llm.openrouterBaseUrl,
        timeoutMs: llm.timeoutMs,
      });
    case 'claude-cli':
      return new ClaudeCliProvider({
        model: llm.model || undefined,
        bin: llm.claudeBin,
        timeoutMs: llm.timeoutMs,
      });
    case 'codex-cli':
      return new CodexCliProvider({
        model: llm.model || undefined,
        bin: llm.codexBin,
        timeoutMs: llm.timeoutMs,
      });
    default: {
      const exhaustive: never = llm.provider;
      throw new Error(`Unknown LLM provider: ${String(exhaustive)}`);
    }
  }
}
