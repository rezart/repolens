import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.js';

describe('loadConfig', () => {
  it('loads defaults for a claude-cli setup with no keys', () => {
    const c = loadConfig({ LLM_PROVIDER: 'claude-cli' });
    expect(c.llm.provider).toBe('claude-cli');
    expect(c.port).toBe(3000);
    expect(c.embedding).toBeNull();
  });
  it('requires an OpenRouter key for the openrouter provider', () => {
    expect(() => loadConfig({ LLM_PROVIDER: 'openrouter', LLM_MODEL: 'x' })).toThrow(ConfigError);
  });
  it('enables embeddings when a model is set', () => {
    const c = loadConfig({ LLM_PROVIDER: 'codex-cli', EMBEDDING_MODEL: 'm', EMBEDDING_API_KEY: 'k' });
    expect(c.embedding?.model).toBe('m');
  });
});
