import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.js';

describe('loadConfig', () => {
  it('loads defaults for a claude-cli setup with no keys', () => {
    const c = loadConfig({ LLM_PROVIDER: 'claude-cli' });
    expect(c.llm.provider).toBe('claude-cli');
    expect(c.port).toBe(3000);
    expect(c.embedding).toBeNull();
    expect(c.hostname).toBe('127.0.0.1');
    expect(c.revision).toBeNull();
  });
  it('trims the running image revision', () => {
    expect(loadConfig({ LLM_PROVIDER: 'claude-cli', REPOLENS_REVISION: ' abc123 ' }).revision).toBe('abc123');
  });
  it('allows an explicit bind hostname for containers', () => {
    expect(loadConfig({ LLM_PROVIDER: 'claude-cli', REPOLENS_HOST: '0.0.0.0' }).hostname).toBe('0.0.0.0');
  });
  it('rejects an empty bind hostname', () => {
    expect(() => loadConfig({ LLM_PROVIDER: 'claude-cli', REPOLENS_HOST: '' })).toThrow(ConfigError);
  });
  it('defaults to three response retries and validates overrides', () => {
    expect(loadConfig({ LLM_PROVIDER: 'claude-cli' }).review.maxRetries).toBe(3);
    expect(loadConfig({ LLM_PROVIDER: 'claude-cli', REVIEW_MAX_RETRIES: '0' }).review.maxRetries).toBe(0);
    for (const value of ['-1', '1.5', 'invalid']) {
      expect(() => loadConfig({ LLM_PROVIDER: 'claude-cli', REVIEW_MAX_RETRIES: value })).toThrow(ConfigError);
    }
  });
  it('requires an OpenRouter key for the openrouter provider', () => {
    expect(() => loadConfig({ LLM_PROVIDER: 'openrouter', LLM_MODEL: 'x' })).toThrow(ConfigError);
  });
  it('enables embeddings when a model is set', () => {
    const c = loadConfig({ LLM_PROVIDER: 'claude-cli', EMBEDDING_MODEL: 'm', EMBEDDING_API_KEY: 'k' });
    expect(c.embedding?.model).toBe('m');
  });
  it('rejects Codex for review and chat', () => {
    expect(() => loadConfig({ LLM_PROVIDER: 'codex-cli' })).toThrow(/codex-cli is temporarily disabled/);
    expect(() => loadConfig({ LLM_PROVIDER: 'claude-cli', CHAT_PROVIDER: 'codex-cli' })).toThrow(/codex-cli is temporarily disabled/);
  });
  it('validates OpenRouter credentials when only chat uses it', () => {
    expect(() => loadConfig({ LLM_PROVIDER: 'claude-cli', CHAT_PROVIDER: 'openrouter' })).toThrow(/OPENROUTER_API_KEY/);
    expect(() => loadConfig({ LLM_PROVIDER: 'claude-cli', CHAT_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'k' })).toThrow(/CHAT_MODEL/);
    const c = loadConfig({ LLM_PROVIDER: 'claude-cli', CHAT_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'k', CHAT_MODEL: 'openai/gpt-4o-mini' });
    expect(c.chatProvider).toBe('openrouter');
  });
});

it('requires a complete GitHub App configuration and preserves PAT-only setups', () => {
  const base = { LLM_PROVIDER: 'claude-cli', GITHUB_TOKEN: 'pat' };
  expect(loadConfig(base).github.app).toBeUndefined();
  expect(() => loadConfig({ ...base, GITHUB_APP_ID: '123' })).toThrow(/GITHUB_APP/);
  expect(() => loadConfig({ ...base, GITHUB_APP_ID: '123', GITHUB_APP_INSTALLATION_ID: '../bad', GITHUB_APP_PRIVATE_KEY_PATH: '/key.pem' })).toThrow(/GITHUB_APP_INSTALLATION_ID/);
  expect(loadConfig({ ...base, GITHUB_APP_ID: '123', GITHUB_APP_INSTALLATION_ID: '456', GITHUB_APP_PRIVATE_KEY_PATH: '/key.pem' }).github.app)
    .toEqual({ appId: '123', installationId: '456', privateKeyPath: '/key.pem' });
});

it('parses ordered review fallback models and rejects malformed lists or CLI fallbacks', () => {
  const base = { LLM_PROVIDER: 'openrouter', LLM_MODEL: 'qwen/qwen3-coder', OPENROUTER_API_KEY: 'k' };
  expect(loadConfig(base).review.fallbackModels).toEqual([]);
  expect(loadConfig({ ...base, REVIEW_FALLBACK_MODELS: ' qwen/qwen3-coder-next,other/coder ' }).review.fallbackModels).toEqual(['qwen/qwen3-coder-next', 'other/coder']);
  for (const value of ['qwen/qwen3-coder-next,', 'a,,b', 'a b']) {
    expect(() => loadConfig({ ...base, REVIEW_FALLBACK_MODELS: value })).toThrow(ConfigError);
  }
  expect(() => loadConfig({ LLM_PROVIDER: 'claude-cli', REVIEW_FALLBACK_MODELS: 'qwen/qwen3-coder-next' })).toThrow(/OpenRouter/);
});

it.each(['not-a-url', 'ftp://example.com'])('rejects invalid OpenRouter base URL %s at configuration time', (url) => {
  expect(() => loadConfig({ LLM_PROVIDER: 'openrouter', LLM_MODEL: 'm', OPENROUTER_API_KEY: 'k', OPENROUTER_BASE_URL: url })).toThrow(ConfigError);
});
