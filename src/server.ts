import { serve } from '@hono/node-server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import { openDb } from './db.js';
import { createProvider } from './llm/index.js';
import { createEmbeddings } from './embeddings/index.js';
import { createRetriever } from './search/retrieve.js';
import { createAppTokenProvider } from './review/github-app.js';
import { GitHubClient } from './review/github.js';
import { JobQueue } from './jobs.js';
import { createApp, type AppDeps } from './app.js';
import { OpenRouterPricing } from './usage/pricing.js';
import { UsageTracker } from './usage/tracker.js';
import { startPoller } from './poller.js';

export function buildDeps(config: Config, log: (msg: string) => void = console.log): AppDeps {
  const token = config.github.app
    ? createAppTokenProvider({ ...config.github.app, privateKey: readFileSync(config.github.app.privateKeyPath, 'utf8') }, { baseUrl: config.github.apiUrl })
    : config.github.token;
  const db = openDb(join(config.dataDir, 'repolens.db'));
  // Accounting is wired before the backends so each one gets its role's sink.
  // The price list is public, so it is fetched with or without an OpenRouter key.
  const pricing = new OpenRouterPricing({ db, baseUrl: config.llm.openrouterBaseUrl });
  const usage = new UsageTracker({ db, pricing, log });
  // Reviews get the configured reasoning budget.
  const llm = createProvider(config, { reasoningEffort: config.llm.reasoningEffort, onUsage: usage.sinkFor('review') });
  // Chat always gets its own provider so it pins effort to 'low' rather than
  // inheriting the review budget, even when it runs on the same provider/model.
  // Measured on the Claude CLI with haiku, the default budget spends ~17s thinking
  // before the first token; 'low' cuts that to ~7s. CLI providers serialise on a
  // semaphore shared per binary, so the second instance cannot double the
  // concurrency of the underlying CLI.
  const chatLlm = createProvider(config, {
    provider: config.chatProvider || undefined,
    model: config.chatModel || undefined,
    reasoningEffort: 'low',
    onUsage: usage.sinkFor('chat'),
  });
  const embeddings = createEmbeddings(config, { onUsage: usage.sinkFor('embed') });
  const retrieve = createRetriever({ db, embeddings });
  const github = new GitHubClient({ token, baseUrl: config.github.apiUrl });
  const jobs = new JobQueue(db, log);
  return { config, db, llm, chatLlm, embeddings, retrieve, github, jobs, usage, log };
}

export function startServer(config: Config, log: (msg: string) => void = console.log) {
  const deps = buildDeps(config, log);
  const app = createApp(deps);

  // A long-running server must survive a stray async failure (an EPIPE on a child's
  // stdin, an abandoned fetch) rather than exiting mid-job.
  process.on('uncaughtException', (err: Error) => {
    log(`uncaught exception: ${err?.stack ?? err?.message ?? String(err)}`);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    log(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
  });

  const hostname = config.hostname ?? '127.0.0.1';
  const server = serve({ fetch: app.fetch, port: config.port, hostname }, (info) => {
    log(`RepoLens listening on http://${hostname}:${info.port}`);
    const effort = config.llm.reasoningEffort ? `, effort ${config.llm.reasoningEffort}` : '';
    log(`LLM: ${deps.llm.name} (${deps.llm.model}${effort}); chat: ${deps.chatLlm.name} (${deps.chatLlm.model})`);
    log(`Embeddings: ${deps.embeddings?.model ?? 'off (lexical retrieval only)'}`);
    if (!config.github.webhookSecret) {
      log('WARNING: GITHUB_WEBHOOK_SECRET is empty; /webhooks/github will reject all deliveries with 503');
    }
  });
  let poller: { stop: () => void } | undefined;
  if (config.pollIntervalSeconds > 0) {
    poller = startPoller(deps, config.pollIntervalSeconds * 1000, log);
    log(`Polling GitHub every ${config.pollIntervalSeconds}s for new commits and pull requests`);
  } else {
    log('Polling disabled (REPOLENS_POLL_INTERVAL=0); relying on webhooks');
  }
  return { server, deps, poller };
}
