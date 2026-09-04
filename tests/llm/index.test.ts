import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createProvider } from '../../src/llm/index.js';
import { completeStreaming } from '../../src/llm/types.js';
import type { CompleteRequest, LLMProvider } from '../../src/llm/types.js';

const base = { LLM_PROVIDER: 'claude-cli', LLM_MODEL: 'sonnet' } as Record<string, string>;

describe('createProvider', () => {
  it('builds the configured backend when there are no overrides', () => {
    const p = createProvider(loadConfig(base));
    expect(p.name).toBe('claude-cli');
    expect(p.model).toBe('sonnet');
  });

  it('overrides the model without touching the provider', () => {
    const p = createProvider(loadConfig(base), { model: 'haiku' });
    expect(p.name).toBe('claude-cli');
    expect(p.model).toBe('haiku');
  });

  it('overrides the provider, so chat can run on a different backend than reviews', () => {
    const config = loadConfig({ ...base, CHAT_PROVIDER: 'codex-cli', CHAT_MODEL: 'gpt-5-mini' });
    const chat = createProvider(config, { provider: config.chatProvider || undefined, model: config.chatModel });
    expect(chat.name).toBe('codex-cli');
    expect(chat.model).toBe('gpt-5-mini');
    // The review backend is unaffected.
    expect(createProvider(config).name).toBe('claude-cli');
  });

  it('rejects an openrouter override without an API key', () => {
    // loadConfig now catches this for CHAT_PROVIDER; the factory still guards direct overrides.
    expect(() => loadConfig({ ...base, CHAT_PROVIDER: 'openrouter', CHAT_MODEL: 'openai/gpt-4o-mini' })).toThrow(/OPENROUTER_API_KEY/);
    const config = loadConfig(base);
    expect(() => createProvider(config, { provider: 'openrouter', model: 'openai/gpt-4o-mini' })).toThrow(/OPENROUTER_API_KEY/);
  });

  // The effort is private on every provider; reading it is the only way to see
  // what the factory picked without spawning a CLI.
  const effortOf = (p: LLMProvider): string | undefined => (p as unknown as { effort?: string }).effort;

  it('defaults the reasoning effort to LLM_REASONING_EFFORT', () => {
    expect(effortOf(createProvider(loadConfig({ ...base, LLM_REASONING_EFFORT: 'high' })))).toBe('high');
  });

  it('lets an explicit effort override the configured one', () => {
    const config = loadConfig({ ...base, LLM_REASONING_EFFORT: 'high' });
    expect(effortOf(createProvider(config, { reasoningEffort: 'low' }))).toBe('low');
  });

  it('keeps a blank override meaning "leave the backend default alone"', () => {
    const config = loadConfig({ ...base, LLM_REASONING_EFFORT: 'high' });
    expect(effortOf(createProvider(config, { reasoningEffort: '' }))).toBeUndefined();
  });

  it('rejects an openrouter override without a model', () => {
    const config = loadConfig({ ...base, OPENROUTER_API_KEY: 'k' });
    expect(() => createProvider(config, { provider: 'openrouter', model: '' })).toThrow(/model is required/i);
  });
});

describe('completeStreaming', () => {
  const req: CompleteRequest = { messages: [{ role: 'user', content: 'hi' }] };

  it('uses the provider stream when it has one', async () => {
    const llm: LLMProvider = {
      name: 'x',
      model: 'x',
      concurrency: 1,
      complete: async () => {
        throw new Error('complete() must not be called');
      },
      async stream(_r, onDelta) {
        onDelta('a');
        onDelta('b');
        return 'ab';
      },
    };
    const seen: string[] = [];
    expect(await completeStreaming(llm, req, (t) => seen.push(t))).toBe('ab');
    expect(seen).toEqual(['a', 'b']);
  });

  it('emits the whole answer once for a provider without stream()', async () => {
    const llm: LLMProvider = { name: 'x', model: 'x', concurrency: 1, complete: async () => 'whole' };
    const seen: string[] = [];
    expect(await completeStreaming(llm, req, (t) => seen.push(t))).toBe('whole');
    expect(seen).toEqual(['whole']);
  });

  it('emits nothing for an empty answer', async () => {
    const llm: LLMProvider = { name: 'x', model: 'x', concurrency: 1, complete: async () => '' };
    const seen: string[] = [];
    expect(await completeStreaming(llm, req, (t) => seen.push(t))).toBe('');
    expect(seen).toEqual([]);
  });
});
