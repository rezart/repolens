import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import type { Config } from './config.js';
import type { Db } from './db.js';
import type { LLMProvider } from './llm/types.js';
import type { EmbeddingProvider } from './embeddings/types.js';
import type { RetrieveFn } from './search/types.js';
import { JobQueue } from './jobs.js';
import { parseRemote, repoIdFor, RepoCheckout } from './indexer/git.js';
import { indexRepo } from './indexer/indexer.js';
import { answerQuestion } from './query/answer.js';
import { reviewPullRequest } from './review/reviewer.js';
import { formatContext } from './search/retrieve.js';
import { identifiersFromCode } from './search/tokenize.js';
import { GitHubClient, verifyWebhookSignature } from './review/github.js';
import { handleGitHubWebhook } from './review/webhook.js';

export interface AppDeps {
  config: Config;
  db: Db;
  llm: LLMProvider;
  embeddings: EmbeddingProvider | null;
  retrieve: RetrieveFn;
  github: GitHubClient;
  jobs: JobQueue;
  log?: (msg: string) => void;
  /** Directory for static dashboard files. Defaults to <project>/web. */
  webDir?: string;
}

export const VERSION = '0.1.0';

const addRepoSchema = z.object({
  remote: z.string().default('github'),
  repository: z.string().min(1),
  branch: z.string().optional(),
});

const querySchema = z.object({
  messages: z.array(z.object({ role: z.enum(['user', 'assistant', 'system']), content: z.string() })).min(1),
  repositories: z.array(z.union([z.string(), z.object({ remote: z.string().optional(), repository: z.string(), branch: z.string().optional() })])).min(1),
  stream: z.boolean().optional(),
  limit: z.number().int().positive().max(50).optional(),
});

const searchSchema = z.object({
  query: z.string().min(1),
  repositories: z.array(z.string()).min(1),
  limit: z.number().int().positive().max(100).optional(),
});

const reviewSchema = z.object({
  repository: z.string().min(1),
  prNumber: z.number().int().positive(),
  post: z.boolean().optional(),
  force: z.boolean().optional(),
});

/** Constant-time comparison; differing lengths are rejected without leaking the length. */
function secretEquals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

export function checkoutFor(deps: Pick<AppDeps, 'config'>, repo: { id: string; remote: string }): RepoCheckout {
  const dir = join(deps.config.dataDir, 'repos', repo.id.replace(/[^a-zA-Z0-9._-]/g, '_'));
  return new RepoCheckout({ dir, url: repo.remote, token: deps.config.github.token || undefined });
}

/**
 * Normalize a repository reference (`github:o/n`, `o/n`, or an object) to a repo id.
 * Ids are lowercase because GitHub owner/repo names are case-insensitive.
 */
export function normalizeRepoId(ref: string | { remote?: string; repository: string }): string {
  const value = typeof ref === 'string' ? ref : ref.repository;
  return value.startsWith('github:') ? value.toLowerCase() : repoIdFor(value);
}

export function enqueueIndex(deps: AppDeps, repoId: string) {
  const repo = deps.db.getRepo(repoId);
  if (!repo) throw new Error(`Unknown repository ${repoId}`);
  deps.db.setRepoStatus(repoId, 'queued');
  return deps.jobs.enqueue('index', repoId, async (ctx) => {
    const checkout = checkoutFor(deps, repo);
    ctx.progress('cloning');
    await checkout.ensureClone();
    // An empty branch means "whatever the remote defaults to"; resolve it once.
    let branch = repo.branch;
    if (!branch) {
      branch = await checkout.defaultBranch();
      if (branch) deps.db.setRepoBranch(repoId, branch);
    }
    return indexRepo({
      db: deps.db,
      checkout,
      repoId,
      ref: branch || undefined,
      embeddings: deps.embeddings,
      onProgress: ctx.progress,
    });
  });
}

export function enqueueReview(deps: AppDeps, repoId: string, prNumber: number, opts: { post?: boolean; force?: boolean } = {}) {
  const repo = deps.db.getRepo(repoId);
  if (!repo) throw new Error(`Unknown repository ${repoId}`);
  return deps.jobs.enqueue('review', repoId, async (ctx) => {
    ctx.progress(`reviewing PR #${prNumber}`);
    const result = await reviewPullRequest(
      {
        db: deps.db,
        llm: deps.llm,
        retrieve: deps.retrieve,
        github: deps.github,
        identifiers: identifiersFromCode,
        formatContext: (chunks) => formatContext(chunks, 16000),
        log: (m) => ctx.progress(m),
      },
      { repoId, prNumber, post: opts.post ?? true, force: opts.force },
    );
    return { reviewId: result.reviewId, findings: result.findings.length, posted: result.posted, reviewUrl: result.reviewUrl };
  });
}

export function createApp(deps: AppDeps): Hono {
  const { config, db } = deps;
  const log = deps.log ?? (() => {});
  const app = new Hono();

  app.onError((err, c) => {
    log(`error: ${err.message}`);
    const status = (err as { status?: number }).status;
    return c.json({ error: err.message }, status && status >= 400 && status < 600 ? (status as 400) : 500);
  });

  // ---- auth ----
  // The token is only accepted in the Authorization header: query strings leak into
  // logs, proxies and referrers. An empty REPOLENS_API_TOKEN disables auth entirely.
  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/health' || !config.apiToken) return next();
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!secretEquals(token, config.apiToken)) return c.json({ error: 'Unauthorized' }, 401);
    return next();
  });

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      version: VERSION,
      llm: { provider: deps.llm.name, model: deps.llm.model },
      embeddings: deps.embeddings?.model ?? null,
    }),
  );

  // ---- repositories ----
  app.get('/api/repositories', (c) => c.json({ repositories: db.listRepos() }));

  app.post('/api/repositories', async (c) => {
    const body = addRepoSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.message }, 400);
    if (body.data.remote !== 'github') return c.json({ error: 'Only remote "github" is supported' }, 400);
    const parsed = parseRemote(body.data.repository);
    const id = `github:${parsed.owner}/${parsed.name}`;
    // An unset branch is stored as '' and resolved from the remote by the index job.
    const repo = db.upsertRepo({ id, remote: parsed.url, owner: parsed.owner, name: parsed.name, branch: body.data.branch ?? '' });
    const job = enqueueIndex(deps, id);
    return c.json({ repository: repo, jobId: job.id }, 202);
  });

  app.get('/api/repositories/:id', (c) => {
    const repo = db.getRepo(decodeURIComponent(c.req.param('id')));
    return repo ? c.json(repo) : c.json({ error: 'Not found' }, 404);
  });

  app.post('/api/repositories/:id/reindex', (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    if (!db.getRepo(id)) return c.json({ error: 'Not found' }, 404);
    const job = enqueueIndex(deps, id);
    return c.json({ jobId: job.id }, 202);
  });

  app.put('/api/repositories/:id/instructions', async (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    if (!db.getRepo(id)) return c.json({ error: 'Not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { instructions?: string };
    db.setRepoInstructions(id, body.instructions?.trim() ? body.instructions : null);
    return c.json(db.getRepo(id));
  });

  app.delete('/api/repositories/:id', (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    if (!db.getRepo(id)) return c.json({ error: 'Not found' }, 404);
    db.deleteRepo(id);
    return c.json({ ok: true });
  });

  // ---- query / search ----
  app.post('/api/query', async (c) => {
    const body = querySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.message }, 400);
    const repoIds = body.data.repositories.map(normalizeRepoId);
    const missing = repoIds.filter((id) => !db.getRepo(id));
    if (missing.length) return c.json({ error: `Unknown repositories: ${missing.join(', ')}` }, 404);
    const run = () =>
      answerQuestion({
        llm: deps.llm,
        retrieve: deps.retrieve,
        repoIds,
        messages: body.data.messages,
        limit: body.data.limit,
      });
    if (body.data.stream) {
      return streamSSE(c, async (stream) => {
        try {
          const result = await run();
          await stream.writeSSE({ event: 'sources', data: JSON.stringify(result.sources) });
          await stream.writeSSE({ event: 'message', data: JSON.stringify({ content: result.message }) });
          await stream.writeSSE({ event: 'done', data: '{}' });
        } catch (err) {
          await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: (err as Error).message }) });
        }
      });
    }
    return c.json(await run());
  });

  app.post('/api/search', async (c) => {
    const body = searchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.message }, 400);
    const results = await deps.retrieve({ repoIds: body.data.repositories.map(normalizeRepoId), query: body.data.query, limit: body.data.limit });
    return c.json({ results });
  });

  // ---- reviews ----
  app.get('/api/reviews', (c) => {
    const repo = c.req.query('repository');
    return c.json({ reviews: db.listReviews(repo ? normalizeRepoId(repo) : undefined) });
  });

  app.post('/api/reviews', async (c) => {
    const body = reviewSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.message }, 400);
    const id = normalizeRepoId(body.data.repository);
    if (!db.getRepo(id)) return c.json({ error: 'Not found' }, 404);
    const job = enqueueReview(deps, id, body.data.prNumber, { post: body.data.post ?? true, force: body.data.force });
    return c.json({ jobId: job.id }, 202);
  });

  // ---- jobs ----
  app.get('/api/jobs', (c) => c.json({ jobs: db.listJobs() }));
  app.get('/api/jobs/:id', (c) => {
    const job = db.getJob(Number(c.req.param('id')));
    return job ? c.json(job) : c.json({ error: 'Not found' }, 404);
  });

  // ---- webhook ----
  app.post('/webhooks/github', async (c) => {
    const raw = await c.req.text();
    // Fail closed: an unconfigured secret must never mean "accept everything".
    if (!config.github.webhookSecret) {
      log('webhook rejected: GITHUB_WEBHOOK_SECRET is not configured');
      return c.json({ error: 'GITHUB_WEBHOOK_SECRET is not configured' }, 503);
    }
    if (!verifyWebhookSignature(config.github.webhookSecret, raw, c.req.header('x-hub-signature-256'))) {
      return c.json({ error: 'Invalid signature' }, 401);
    }
    const event = c.req.header('x-github-event') ?? '';
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const outcome = handleGitHubWebhook(deps, event, payload);
    return c.json(outcome, 202);
  });

  // ---- dashboard ----
  const webDir = deps.webDir ?? join(process.cwd(), 'web');
  app.use('/*', serveStatic({ root: webDir, rewriteRequestPath: (p) => (p === '/' ? '/index.html' : p) }));

  return app;
}
