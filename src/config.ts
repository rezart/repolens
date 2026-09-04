import { z } from 'zod';

const envSchema = z.object({
  REPOLENS_DATA_DIR: z.string().default('./data'),
  REPOLENS_API_TOKEN: z.string().default(''),
  REPOLENS_PORT: z.coerce.number().int().positive().default(3000),
  REPOLENS_PUBLIC_URL: z.string().default(''),

  LLM_PROVIDER: z.enum(['openrouter', 'claude-cli', 'codex-cli']).default('openrouter'),
  LLM_MODEL: z.string().default(''),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  OPENROUTER_API_KEY: z.string().default(''),
  OPENROUTER_BASE_URL: z.string().default('https://openrouter.ai/api/v1'),
  CLAUDE_BIN: z.string().default('claude'),
  CODEX_BIN: z.string().default('codex'),

  EMBEDDING_BASE_URL: z.string().default('https://openrouter.ai/api/v1'),
  EMBEDDING_API_KEY: z.string().default(''),
  EMBEDDING_MODEL: z.string().default(''),

  GITHUB_TOKEN: z.string().default(''),
  GITHUB_API_URL: z.string().default('https://api.github.com'),
  GITHUB_WEBHOOK_SECRET: z.string().default(''),
  REVIEW_BOT_HANDLE: z.string().default('@repolens'),
});

export type LLMProviderName = 'openrouter' | 'claude-cli' | 'codex-cli';

export interface Config {
  dataDir: string;
  apiToken: string;
  port: number;
  publicUrl: string;
  llm: {
    provider: LLMProviderName;
    model: string;
    timeoutMs: number;
    openrouterApiKey: string;
    openrouterBaseUrl: string;
    claudeBin: string;
    codexBin: string;
  };
  embedding: { baseUrl: string; apiKey: string; model: string } | null;
  github: { token: string; apiUrl: string; webhookSecret: string; botHandle: string };
}

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const e = parsed.data;
  if (e.LLM_PROVIDER === 'openrouter' && !e.OPENROUTER_API_KEY) {
    throw new ConfigError('OPENROUTER_API_KEY is required when LLM_PROVIDER=openrouter');
  }
  if (e.LLM_PROVIDER === 'openrouter' && !e.LLM_MODEL) {
    throw new ConfigError('LLM_MODEL is required when LLM_PROVIDER=openrouter (e.g. anthropic/claude-sonnet-4.5)');
  }
  return {
    dataDir: e.REPOLENS_DATA_DIR,
    apiToken: e.REPOLENS_API_TOKEN,
    port: e.REPOLENS_PORT,
    publicUrl: e.REPOLENS_PUBLIC_URL,
    llm: {
      provider: e.LLM_PROVIDER,
      model: e.LLM_MODEL,
      timeoutMs: e.LLM_TIMEOUT_MS,
      openrouterApiKey: e.OPENROUTER_API_KEY,
      openrouterBaseUrl: e.OPENROUTER_BASE_URL,
      claudeBin: e.CLAUDE_BIN,
      codexBin: e.CODEX_BIN,
    },
    embedding: e.EMBEDDING_MODEL
      ? { baseUrl: e.EMBEDDING_BASE_URL, apiKey: e.EMBEDDING_API_KEY, model: e.EMBEDDING_MODEL }
      : null,
    github: {
      token: e.GITHUB_TOKEN,
      apiUrl: e.GITHUB_API_URL,
      webhookSecret: e.GITHUB_WEBHOOK_SECRET,
      botHandle: e.REVIEW_BOT_HANDLE,
    },
  };
}
