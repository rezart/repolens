import { z } from 'zod';

const envSchema = z.object({
  REPOLENS_DATA_DIR: z.string().default('./data'),
  REPOLENS_API_TOKEN: z.string().default(''),
  REPOLENS_PORT: z.coerce.number().int().positive().default(3000),
  REPOLENS_HOST: z.string().min(1).default('127.0.0.1'),
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
  GITHUB_APP_ID: z.string().regex(/^(?:[1-9][0-9]*)?$/).default(''),
  GITHUB_APP_INSTALLATION_ID: z.string().regex(/^(?:[1-9][0-9]*)?$/).default(''),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().trim().default(''),
  GITHUB_API_URL: z.string().default('https://api.github.com'),
  GITHUB_WEBHOOK_SECRET: z.string().default(''),
  REVIEW_BOT_HANDLE: z.string().default('@repolens'),
  /** Seconds between GitHub polls for new commits and pull requests. 0 disables polling. */
  REPOLENS_POLL_INTERVAL: z.coerce.number().int().min(0).default(300),
  /** Provider and model used for chat answers; blank = same as LLM_PROVIDER / LLM_MODEL. */
  CHAT_PROVIDER: z.enum(['openrouter', 'claude-cli', 'codex-cli', '']).default(''),
  CHAT_MODEL: z.string().default(''),
  /** Reasoning effort for the review provider (codex: model_reasoning_effort; openrouter: reasoning.effort). Blank = provider default. */
  LLM_REASONING_EFFORT: z.enum(['low', 'medium', 'high', '']).default(''),
  /** Commit status context reported on reviewed PR heads; blank disables statuses. */
  REVIEW_STATUS_CONTEXT: z.string().default('repolens/review'),
  /** Which finding severity makes the status fail: critical | warning | never. */
  REVIEW_FAIL_ON: z.enum(['critical', 'warning', 'never']).default('critical'),
  /** Extra attempts for invalid batch review responses, within the total review budget. */
  REVIEW_MAX_RETRIES: z.coerce.number().int().min(0).default(3),
  /** Seconds a PR must go without a new push before an automatic review starts. 0 reviews immediately. */
  REVIEW_SETTLE_SECONDS: z.coerce.number().int().min(0).default(300),
});

export type LLMProviderName = 'openrouter' | 'claude-cli' | 'codex-cli';

export interface Config {
  dataDir: string;
  apiToken: string;
  port: number;
  hostname?: string;
  publicUrl: string;
  llm: {
    provider: LLMProviderName;
    model: string;
    timeoutMs: number;
    openrouterApiKey: string;
    openrouterBaseUrl: string;
    claudeBin: string;
    codexBin: string;
    reasoningEffort: 'low' | 'medium' | 'high' | '';
  };
  embedding: { baseUrl: string; apiKey: string; model: string } | null;
  github: { token: string; apiUrl: string; webhookSecret: string; botHandle: string; app?: { appId: string; installationId: string; privateKeyPath: string } };
  pollIntervalSeconds: number;
  /** Provider/model for chat answers ('' = same as llm). */
  chatProvider: LLMProviderName | '';
  chatModel: string;
  review: { statusContext: string; failOn: 'critical' | 'warning' | 'never'; settleSeconds: number; maxRetries: number };
}

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const e = parsed.data;
  if (e.LLM_PROVIDER === 'codex-cli' || e.CHAT_PROVIDER === 'codex-cli') {
    throw new ConfigError('codex-cli is temporarily disabled for security; use claude-cli or openrouter');
  }
  const appFields = [e.GITHUB_APP_ID, e.GITHUB_APP_INSTALLATION_ID, e.GITHUB_APP_PRIVATE_KEY_PATH];
  if (appFields.some(Boolean) && !appFields.every(Boolean)) {
    throw new ConfigError('GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, and GITHUB_APP_PRIVATE_KEY_PATH must all be set');
  }
  if (e.LLM_PROVIDER === 'openrouter' && !e.OPENROUTER_API_KEY) {
    throw new ConfigError('OPENROUTER_API_KEY is required when LLM_PROVIDER=openrouter');
  }
  if (e.LLM_PROVIDER === 'openrouter' && !e.LLM_MODEL) {
    throw new ConfigError('LLM_MODEL is required when LLM_PROVIDER=openrouter (e.g. anthropic/claude-sonnet-4.5)');
  }
  // Chat may run on a different backend; validate the effective chat provider the same way.
  const chatProvider = e.CHAT_PROVIDER || e.LLM_PROVIDER;
  if (chatProvider === 'openrouter' && !e.OPENROUTER_API_KEY) {
    throw new ConfigError('OPENROUTER_API_KEY is required when chat runs on OpenRouter (CHAT_PROVIDER=openrouter)');
  }
  if (chatProvider === 'openrouter' && !(e.CHAT_MODEL || e.LLM_MODEL)) {
    throw new ConfigError('CHAT_MODEL (or LLM_MODEL) is required when chat runs on OpenRouter');
  }
  return {
    dataDir: e.REPOLENS_DATA_DIR,
    apiToken: e.REPOLENS_API_TOKEN,
    port: e.REPOLENS_PORT,
    hostname: e.REPOLENS_HOST,
    publicUrl: e.REPOLENS_PUBLIC_URL,
    llm: {
      provider: e.LLM_PROVIDER,
      model: e.LLM_MODEL,
      timeoutMs: e.LLM_TIMEOUT_MS,
      openrouterApiKey: e.OPENROUTER_API_KEY,
      openrouterBaseUrl: e.OPENROUTER_BASE_URL,
      claudeBin: e.CLAUDE_BIN,
      codexBin: e.CODEX_BIN,
      reasoningEffort: e.LLM_REASONING_EFFORT,
    },
    embedding: e.EMBEDDING_MODEL
      ? { baseUrl: e.EMBEDDING_BASE_URL, apiKey: e.EMBEDDING_API_KEY, model: e.EMBEDDING_MODEL }
      : null,
    pollIntervalSeconds: e.REPOLENS_POLL_INTERVAL,
    chatProvider: e.CHAT_PROVIDER,
    chatModel: e.CHAT_MODEL,
    review: { statusContext: e.REVIEW_STATUS_CONTEXT, failOn: e.REVIEW_FAIL_ON, settleSeconds: e.REVIEW_SETTLE_SECONDS, maxRetries: e.REVIEW_MAX_RETRIES },
    github: {
      token: e.GITHUB_TOKEN,
      app: e.GITHUB_APP_ID ? { appId: e.GITHUB_APP_ID, installationId: e.GITHUB_APP_INSTALLATION_ID, privateKeyPath: e.GITHUB_APP_PRIVATE_KEY_PATH } : undefined,
      apiUrl: e.GITHUB_API_URL,
      webhookSecret: e.GITHUB_WEBHOOK_SECRET,
      botHandle: e.REVIEW_BOT_HANDLE,
    },
  };
}
