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

export function buildDeps(config: Config, log: (msg: string) => void = console.log): AppDeps {
  const db = openDb(join(config.dataDir, 'repolens.db'));
  const llm = createProvider(config);
  const embeddings = createEmbeddings(config);
  const retrieve = createRetriever({ db, embeddings });
  const github = new GitHubClient({ token: config.github.token, baseUrl: config.github.apiUrl });
  const jobs = new JobQueue(db, log);
  return { config, db, llm, embeddings, retrieve, github, jobs, log };
}

export function startServer(config: Config, log: (msg: string) => void = console.log) {
  const deps = buildDeps(config, log);
  const app = createApp(deps);
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    log(`RepoLens listening on http://localhost:${info.port}`);
    log(`LLM: ${deps.llm.name} (${deps.llm.model}); embeddings: ${deps.embeddings?.model ?? 'off (lexical retrieval only)'}`);
    if (!config.apiToken) log('WARNING: REPOLENS_API_TOKEN is empty; the API is unauthenticated');
  });
  return { server, deps };
}
