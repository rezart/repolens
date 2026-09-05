import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from '@hono/node-server/serve-static';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { createHash, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { ConfigError, type Config } from './config.js';
import type { Db } from './db.js';
import type { LLMProvider } from './llm/types.js';
import type { EmbeddingProvider } from './embeddings/types.js';
import type { RetrieveFn } from './search/types.js';
import { JobQueue } from './jobs.js';
import { parseRemote, repoIdFor, repoIdOf, RepoCheckout } from './indexer/git.js';
import { indexRepo } from './indexer/indexer.js';
import { answerQuestion } from './query/answer.js';
import type { AnswerOptions, AnswerResult } from './query/answer.js';
import { reviewPullRequest } from './review/reviewer.js';
import { formatContext } from './search/retrieve.js';
import { identifiersFromCode } from './search/tokenize.js';
import { GitHubClient, verifyWebhookSignature } from './review/github.js';
import { handleGitHubWebhook } from './review/webhook.js';
import { listPullStatuses, reviewPulls } from './review/pulls.js';
import type { UsageTracker } from './usage/tracker.js';

export interface AppDeps {
  config: Config;
  db: Db;
  /** Backend used for pull request reviews. */
  llm: LLMProvider;
  /** Backend used for chat answers; may be a cheaper/faster model than `llm`. */
  chatLlm: LLMProvider;
  embeddings: EmbeddingProvider | null;
  retrieve: RetrieveFn;
  github: GitHubClient;
  jobs: JobQueue;
  /** Records what backend calls cost and reports it per day. */
  usage: UsageTracker;
  log?: (msg: string) => void;
  /** Directory for static dashboard files. Defaults to <project>/web. */
  webDir?: string;
}

export const VERSION = '0.1.0';

const addRepoSchema = z.object({
  remote: z.string().default('github'),
  repository: z.string().min(1).max(200),
  branch: z.string().max(200).optional(),
});

const querySchema = z.object({
  messages: z.array(z.object({ role: z.enum(['user', 'assistant', 'system']), content: z.string().max(20_000) })).min(1).max(50),
  repositories: z.array(z.union([z.string().max(200), z.object({ remote: z.string().max(50).optional(), repository: z.string().max(200), branch: z.string().max(200).optional() })])).min(1).max(50),
  stream: z.boolean().optional(),
  limit: z.number().int().positive().max(50).optional(),
});

const searchSchema = z.object({
  query: z.string().min(1).max(10_000),
  repositories: z.array(z.string().max(200)).min(1).max(50),
  limit: z.number().int().positive().max(100).optional(),
});

const reviewPullsSchema = z.object({
  prNumbers: z.array(z.number().int().positive()).max(100).optional(),
  post: z.boolean().optional(),
  force: z.boolean().optional(),
});

// `?days=` (empty) means the default, like an absent param; coercing '' would give 0 and fail min(1).
const usageDaysSchema = z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(1).max(365).default(30));

const reviewListSchema = z.object({
  repository: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const reviewSchema = z.object({
  repository: z.string().min(1).max(200),
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

export function checkoutFor(deps: Pick<AppDeps, 'config' | 'github'>, repo: { id: string; remote: string }): RepoCheckout {
  const dir = join(deps.config.dataDir, 'repos', repo.id.replace(/[^a-zA-Z0-9._-]/g, '_'));
  return new RepoCheckout({ dir, url: repo.remote, token: repo.id.startsWith('github:') ? () => deps.github.getToken() : undefined });
}

/**
 * Normalize a repository reference (`github:o/n`, `o/n`, or an object) to a repo id.
 * Ids are lowercase because GitHub owner/repo names are case-insensitive.
 */
export function normalizeRepoId(ref: string | { remote?: string; repository: string }): string {
  const value = typeof ref === 'string' ? ref : ref.repository;
  return /^(github|local):/.test(value) ? value.toLowerCase() : repoIdFor(value);
}

export function enqueueIndex(deps: AppDeps, repoId: string) {
  const repo = deps.db.getRepo(repoId);
  if (!repo) throw new Error(`Unknown repository ${repoId}`);
  const job = deps.jobs.enqueue('index', repoId, async (ctx) => {
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
  deps.db.setRepoStatus(repoId, 'queued');
  return job;
}

/**
 * Automatic triggers (webhook, poller) go through here: the review is deferred until the
 * PR has had no push for `review.settleSeconds`, and each new push restarts the wait.
 */
export function scheduleReview(deps: AppDeps, repoId: string, prNumber: number): void {
  const ms = deps.config.review.settleSeconds * 1000;
  if (ms <= 0) {
    enqueueReview(deps, repoId, prNumber, { post: true });
    return;
  }
  deps.jobs.schedule(reviewKey(repoId, prNumber), ms, () => enqueueReview(deps, repoId, prNumber, { post: true }));
}

export function reviewKey(repoId: string, prNumber: number): string {
  return `${repoId}#${prNumber}`;
}

export function enqueueReview(deps: AppDeps, repoId: string, prNumber: number, opts: { post?: boolean; force?: boolean } = {}) {
  const repo = deps.db.getRepo(repoId);
  if (!repo) throw new Error(`Unknown repository ${repoId}`);
  if (!repoId.startsWith('github:')) throw new Error(`Pull request review needs a GitHub repository; ${repoId} is local`);
  // enqueue enforces the review capacity before writing a job, for every trigger.
  return deps.jobs.enqueue(
    'review',
    repoId,
    async (ctx) => {
      ctx.progress(`reviewing PR #${prNumber}`);
      const result = await reviewPullRequest(
        {
          db: deps.db,
          llm: deps.llm,
          retrieve: deps.retrieve,
          github: deps.github,
          identifiers: identifiersFromCode,
          formatContext: (chunks) => formatContext(chunks, 16000),
          statusContext: deps.config.review.statusContext,
          failOn: deps.config.review.failOn,
          maxRetries: deps.config.review.maxRetries,
          publicUrl: deps.config.publicUrl,
          log: (m) => ctx.progress(m),
        },
        { repoId, prNumber, post: opts.post ?? true, force: opts.force },
      );
      return { reviewId: result.reviewId, findings: result.findings.length, posted: result.posted, reviewUrl: result.reviewUrl };
    },
    { prNumber },
  );
}

/** The part of hono's SSE stream this module uses, so the pump is testable on its own. */
export interface SSEWriter {
  writeSSE(message: { event: string; data: string }): Promise<void>;
}

type AnswerHooks = Pick<AnswerOptions, 'onDelta' | 'onSources'>;

/**
 * Stream one answer as SSE events. Writes are queued rather than awaited inline:
 * the provider callbacks are synchronous, and a delta must never be dropped or
 * reordered. The first write failure (usually a disconnected client) is kept and
 * stops every later write, so a dead connection is not written to for the rest of
 * the generation.
 */
export async function streamAnswer(stream: SSEWriter, run: (hooks: AnswerHooks) => Promise<AnswerResult>): Promise<void> {
  let pending: Promise<void> = Promise.resolve();
  let writeFailed = false;
  const send = (event: string, data: unknown) => {
    if (writeFailed) return;
    pending = pending
      // Checked again here: events queued before the failure surfaced must not be written.
      .then(() => (writeFailed ? undefined : stream.writeSSE({ event, data: JSON.stringify(data) })))
      .catch(() => {
        writeFailed = true;
      });
  };
  try {
    const result = await run({
      onSources: (sources) => send('sources', sources),
      onDelta: (text) => send('delta', { text }),
    });
    // Queued writes may still be in flight; a failure among them must be seen
    // before the closing events are queued.
    await pending;
    send('message', { content: result.message });
    send('done', {});
  } catch (err) {
    await pending;
    send('error', { error: (err as Error).message });
  }
  await pending;
}

export function createApp(deps: AppDeps): Hono {
  const { config, db } = deps;
  if (!config.apiToken.trim() || new Set(['change-me', 'changeme', 'your-token', 'your-token-here', 'replace-me']).has(config.apiToken.trim().toLowerCase())) {
    throw new ConfigError('REPOLENS_API_TOKEN must be a non-placeholder API token when starting the API');
  }
  const log = deps.log ?? (() => {});
  const app = new Hono();
  const seenWebhooks = new Map<string, number>();

  app.use('*', async (c, next) => {
    c.res.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    await next();
  });

  app.onError((err, c) => {
    log(`error: ${err.message}`);
    const status = (err as { status?: number }).status;
    return c.json({ error: err.message }, status && status >= 400 && status < 600 ? (status as 400) : 500);
  });

  // ---- auth ----
  // The token is only accepted in the Authorization header: query strings leak into
  // logs, proxies and referrers. Startup rejects empty and placeholder tokens.
  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/health') return next();
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!secretEquals(token, config.apiToken)) return c.json({ error: 'Unauthorized' }, 401);
    return next();
  });
  app.use('/api/*', bodyLimit({ maxSize: 1_048_576 }));
  // Apply this before reading the body or checking the signature so unsigned oversized deliveries are cheap to reject.
  app.use('/webhooks/github', bodyLimit({ maxSize: 5 * 1024 * 1024 }));

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      version: VERSION,
      llm: { provider: deps.llm.name, model: deps.llm.model, effort: config.llm.reasoningEffort || null },
      chat: { provider: deps.chatLlm.name, model: deps.chatLlm.model },
      embeddings: deps.embeddings?.model ?? null,
    }),
  );

  // ---- repositories ----
  app.get('/api/repositories', (c) => c.json({ repositories: db.listRepos() }));

  app.post('/api/repositories', async (c) => {
    const body = addRepoSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.message }, 400);
    if (body.data.remote !== 'github' && body.data.remote !== 'local') {
      return c.json({ error: 'remote must be "github" or "local"' }, 400);
    }
    let parsed;
    try {
      parsed = parseRemote(body.data.repository);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    if (parsed.host !== body.data.remote) return c.json({ error: `${body.data.repository} is not a ${body.data.remote} repository` }, 400);
    if (!deps.jobs.hasCapacity('index')) return c.json({ error: 'job queue (index) is full' }, 429);
    const id = repoIdOf(parsed);
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
    const body = z.object({ instructions: z.string().max(20_000).optional() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.message }, 400);
    db.setRepoInstructions(id, body.data.instructions?.trim() ? body.data.instructions : null);
    return c.json(db.getRepo(id));
  });

  app.delete('/api/repositories/:id', (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    if (!db.getRepo(id)) return c.json({ error: 'Not found' }, 404);
    db.deleteRepo(id);
    return c.json({ ok: true });
  });

  // ---- pull requests ----
  app.get('/api/repositories/:id/pulls', async (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    if (!db.getRepo(id)) return c.json({ error: 'Not found' }, 404);
    if (!id.startsWith('github:')) return c.json({ error: 'pull requests need a GitHub repository' }, 400);
    try {
      return c.json({ pulls: await listPullStatuses(deps, id) });
    } catch (err) {
      // The repo exists and is on GitHub, so a failure here is GitHub's (or the network's).
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  app.post('/api/repositories/:id/pulls/review', async (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    if (!db.getRepo(id)) return c.json({ error: 'Not found' }, 404);
    if (!id.startsWith('github:')) return c.json({ error: 'pull requests need a GitHub repository' }, 400);
    const body = reviewPullsSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.message }, 400);
    // Avoid an external GitHub request when no review can be queued.
    if (!deps.jobs.hasCapacity('review')) return c.json({ error: 'job queue (review) is full' }, 429);
    let pulls;
    try {
      pulls = await listPullStatuses(deps, id);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
    return c.json(reviewPulls(deps, id, { ...body.data, pulls }), 202);
  });

  // ---- query / search ----
  app.post('/api/query', async (c) => {
    const body = querySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.message }, 400);
    const repoIds = body.data.repositories.map(normalizeRepoId);
    const missing = repoIds.filter((id) => !db.getRepo(id));
    if (missing.length) return c.json({ error: `Unknown repositories: ${missing.join(', ')}` }, 404);
    const run = (hooks: AnswerHooks = {}) =>
      answerQuestion({
        llm: deps.chatLlm,
        retrieve: deps.retrieve,
        repoIds,
        messages: body.data.messages,
        limit: body.data.limit,
        ...hooks,
      });
    if (body.data.stream) {
      return streamSSE(c, (stream) => streamAnswer(stream, run));
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
    const q = reviewListSchema.safeParse(c.req.query());
    if (!q.success) return c.json({ error: q.error.message }, 400);
    const repo = q.data.repository ? normalizeRepoId(q.data.repository) : undefined;
    return c.json({ reviews: db.listReviews(repo, q.data.limit, q.data.offset), total: db.countReviews(repo) });
  });

  app.post('/api/reviews', async (c) => {
    const body = reviewSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.message }, 400);
    const id = normalizeRepoId(body.data.repository);
    if (!db.getRepo(id)) return c.json({ error: 'Not found' }, 404);
    const job = enqueueReview(deps, id, body.data.prNumber, { post: body.data.post ?? true, force: body.data.force });
    return c.json({ jobId: job.id }, 202);
  });

  // ---- usage ----
  app.get('/api/usage', async (c) => {
    const days = usageDaysSchema.safeParse(c.req.query('days'));
    if (!days.success) return c.json({ error: days.error.message }, 400);
    return c.json(await deps.usage.report(days.data));
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
    const now = Date.now();
    const webhookKey = event === 'issue_comment' ? createHash('sha256').update(event + '\0' + raw).digest('hex') : '';
    if (webhookKey) {
      for (const [key, at] of seenWebhooks) if (now - at > 60 * 60 * 1000) seenWebhooks.delete(key);
      if (seenWebhooks.has(webhookKey)) return c.json({ action: 'ignored', reason: 'duplicate webhook delivery' }, 202);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const outcome = handleGitHubWebhook(deps, event, payload);
    if (webhookKey) {
      if (seenWebhooks.size >= 1000) seenWebhooks.delete(seenWebhooks.keys().next().value!);
      seenWebhooks.set(webhookKey, now);
    }
    return c.json(outcome, 202);
  });

  // ---- dashboard ----
  const webDir = deps.webDir ?? join(process.cwd(), 'web');
  app.get('/vendor/marked.js', async (c) => {
    c.header('Content-Type', 'text/javascript');
    c.header('Cache-Control', 'no-cache');
    return c.body(await readFile(join(process.cwd(), 'node_modules/marked/lib/marked.umd.js')));
  });
  app.get('/vendor/purify.js', async (c) => {
    c.header('Content-Type', 'text/javascript');
    c.header('Cache-Control', 'no-cache');
    return c.body(await readFile(join(process.cwd(), 'node_modules/dompurify/dist/purify.min.js')));
  });
  // The dashboard has no build step or hashed filenames, so browsers must
  // revalidate on every load; otherwise heuristic caching keeps serving a
  // pre-deploy app.js and new features never appear without a hard reload.
  // Registered after the API routes, so their responses are untouched.
  app.use('/*', async (c, next) => {
    await next();
    c.res.headers.set('Cache-Control', 'no-cache');
  });
  app.use('/*', serveStatic({ root: webDir, rewriteRequestPath: (p) => (p === '/' ? '/index.html' : p) }));
  // Dashboard routes (/repos/..., /usage) are handled client-side; deep links load the shell.
  app.get('/*', async (c) => {
    if (c.req.path.startsWith('/api/') || /\.[a-z0-9]+$/i.test(c.req.path)) return c.notFound();
    const shell = await readFile(join(webDir, 'index.html'), 'utf8');
    return c.html(shell);
  });

  return app;
}
