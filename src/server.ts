import { serve } from '@hono/node-server';
import { join } from 'node:path';
import type { Config } from './config.js';
import { openDb } from './db.js';
import { createProvider } from './llm/index.js';
import { createEmbeddings } from './embeddings/index.js';
import { createRetriever } from './search/retrieve.js';
import { GitHubClient } from './review/github.js';
import { JobQueue } from './jobs.js';
import { createApp, type AppDeps } from './app.js';
import { startPoller } from './poller.js';

export function buildDeps(config: Config, log: (msg: string) => void = console.log): AppDeps {
  const db = openDb(join(config.dataDir, 'repolens.db'));
  // Reviews get the reasoning budget; chat is latency-sensitive and stays at the
  // backend default so answers start streaming quickly.
  const llm = createProvider(config, { reasoningEffort: config.llm.reasoningEffort });
  // Chat pins effort to 'low' rather than inheriting the review budget or the
  // backend default. Measured on the Claude CLI with haiku, the default budget
  // spends ~17s thinking before the first token; 'low' cuts that to ~7s.
  const chatLlm =
    config.chatProvider || config.chatModel
      ? createProvider(config, {
          provider: config.chatProvider || undefined,
          model: config.chatModel || undefined,
          reasoningEffort: 'low',
        })
      : llm;
  const embeddings = createEmbeddings(config);
  const retrieve = createRetriever({ db, embeddings });
  const github = new GitHubClient({ token: config.github.token, baseUrl: config.github.apiUrl });
  const jobs = new JobQueue(db, log);
  return { config, db, llm, chatLlm, embeddings, retrieve, github, jobs, log };
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

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    log(`RepoLens listening on http://localhost:${info.port}`);
    const effort = config.llm.reasoningEffort ? `, effort ${config.llm.reasoningEffort}` : '';
    log(`LLM: ${deps.llm.name} (${deps.llm.model}${effort}); chat: ${deps.chatLlm.name} (${deps.chatLlm.model})`);
    log(`Embeddings: ${deps.embeddings?.model ?? 'off (lexical retrieval only)'}`);
    if (!config.apiToken) {
      log('*'.repeat(72));
      log('*** WARNING: REPOLENS_API_TOKEN is empty. The API is UNAUTHENTICATED and');
      log('*** anyone who can reach this port can read every indexed repository.');
      log('*** Set REPOLENS_API_TOKEN before exposing it beyond localhost.');
      log('*'.repeat(72));
    }
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
