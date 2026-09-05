import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type Db } from '../../src/db.js';
import type { CompleteRequest, LLMProvider } from '../../src/llm/types.js';
import type { RetrieveFn, RetrievedChunk } from '../../src/search/types.js';
import type {
  PullRequest,
  CreateReviewInput,
  ExistingReviewComment,
  CommitStatusInput,
  PathCommit,
  HistoricalPullRequest,
} from '../../src/review/github.js';
import { FILE_REVIEW_SYSTEM_PROMPT, BATCH_REVIEW_SYSTEM_PROMPT, SUMMARY_SYSTEM_PROMPT } from '../../src/review/prompts.js';
import { reviewCostUpperBound, REVIEW_MAX_USD } from '../../src/review/budget.js';
import { UsageTracker } from '../../src/usage/tracker.js';
import { OpenRouterProvider } from '../../src/llm/openrouter.js';
import { JobQueue } from '../../src/jobs.js';
import { hunkText, parseUnifiedDiff } from '../../src/review/diff.js';
import {
  reviewPullRequest,
  ReviewSupersededError,
  isReviewablePath,
  buildReviewBody,
  defaultIdentifiers,
  defaultFormatContext,
  statusForFindings,
  type ReviewDeps,
  type Finding,
} from '../../src/review/reviewer.js';

const REPO_ID = 'github:o/r';

const DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,5 +1,6 @@',
  " import { x } from './x.js';",
  ' ',
  '-export function run() {',
  '+export function run(n: number) {',
  '+  if (n = 0) return;',
  '   return x();',
  ' }',
  'diff --git a/package-lock.json b/package-lock.json',
  '--- a/package-lock.json',
  '+++ b/package-lock.json',
  '@@ -1,2 +1,2 @@',
  '-  "version": "1.0.0",',
  '+  "version": "1.0.1",',
  '   "x": 1',
  'diff --git a/assets/logo.png b/assets/logo.png',
  'index ddddddd..eeeeeee 100644',
  'Binary files a/assets/logo.png and b/assets/logo.png differ',
  'diff --git a/src/gone.ts b/src/gone.ts',
  'deleted file mode 100644',
  '--- a/src/gone.ts',
  '+++ /dev/null',
  '@@ -1,1 +0,0 @@',
  '-const gone = true;',
  '',
].join('\n');

const PR: PullRequest = {
  number: 42,
  title: 'Add run()',
  body: 'Adds a guard.',
  headSha: 'head-sha-1',
  baseSha: 'base-sha-1',
  headRef: 'feature',
  baseRef: 'main',
  author: 'octocat',
  htmlUrl: 'https://github.com/o/r/pull/42',
  draft: false,
  updatedAt: '2026-01-01T00:00:00Z',
};

const CHUNK: RetrievedChunk = {
  chunkId: 1,
  repoId: REPO_ID,
  path: 'src/x.ts',
  startLine: 1,
  endLine: 3,
  content: 'export function x() { return 1; }',
  score: 0.9,
};

interface FakeLlmOptions {
  file?: string | (() => string);
  summary?: string;
  allowDeleted?: boolean;
}

function fakeLlm(opts: FakeLlmOptions = {}) {
  const calls: CompleteRequest[] = [];
  const provider: LLMProvider = {
    name: 'fake',
    model: 'm1',
    concurrency: 2,
    async complete(req) {
      calls.push(req);
      if (req.system === FILE_REVIEW_SYSTEM_PROMPT) {
        if (!opts.allowDeleted && req.messages[0]!.content.includes('File under review: src/gone.ts')) return '{"findings":[]}';
        if (opts.allowDeleted && !req.messages[0]!.content.includes('File under review: src/gone.ts')) return '{"findings":[]}';
        const f = opts.file ?? '{"findings":[]}';
        return typeof f === 'function' ? f() : f;
      }
      if (req.system === SUMMARY_SYSTEM_PROMPT) {
        return opts.summary ?? '{"summary":"Adds a guard to run().","verdict":"comment"}';
      }
      throw new Error('unexpected system prompt');
    },
  };
  return { calls, provider, fileCalls: () => calls.filter((c) => c.system === FILE_REVIEW_SYSTEM_PROMPT) };
}

interface FakeGithubOptions {
  /** Comments already on the PR, returned by listReviewComments. */
  existingComments?: ExistingReviewComment[];
  /** Make createReview reject. */
  createReviewError?: () => Error | null;
  /** Make listReviewComments reject. */
  listError?: Error;
  /** Make getPullDiff reject (stands in for any failure inside the review). */
  diffError?: Error;
  /** Make createCommitStatus reject. */
  statusError?: Error;
  /** Post-change content by path, as returned by getFileContent (missing path → null). */
  headFiles?: Record<string, string>;
  /** Make getFileContent reject for the given path. */
  fileContentError?: (path: string) => Error | null;
  /** Commits returned by listPullCommits. */
  commits?: Array<{ sha: string; message: string }>;
  /** Diff returned by compareDiff (null = GitHub cannot compare). */
  compare?: string | null;
  /** Historical path commits and associated PRs. */
  historyCommits?: PathCommit[];
  historyCommitsByPath?: Record<string, PathCommit[]>;
  historyPulls?: HistoricalPullRequest[];
  historyPullsByCommit?: Record<string, HistoricalPullRequest[]>;
}

interface StatusCall {
  owner: string;
  repo: string;
  sha: string;
  input: CommitStatusInput;
}

function fakeGithub(diff = DIFF, pr: PullRequest = PR, opts: FakeGithubOptions = {}) {
  const reviews: Array<{ owner: string; repo: string; number: number; input: CreateReviewInput }> = [];
  const listCalls: Array<{ owner: string; repo: string; number: number }> = [];
  const statuses: StatusCall[] = [];
  const contentCalls: Array<{ path: string; ref: string }> = [];
  const compareCalls: Array<{ base: string; head: string }> = [];
  const historyCalls: string[] = [];
  const github: ReviewDeps['github'] = {
    async listPullCommits() {
      return opts.commits ?? [];
    },
    async listCommitPulls(_owner: string, _repo: string, sha: string) {
      return opts.historyPullsByCommit?.[sha] ?? opts.historyPulls ?? [];
    },
    async listPathCommits(_owner: string, _repo: string, path: string, ref: string) {
      historyCalls.push(`${path}@${ref}`);
      return opts.historyCommitsByPath?.[path] ?? opts.historyCommits ?? [];
    },
    async compareDiff(_owner: string, _repo: string, base: string, head: string) {
      compareCalls.push({ base, head });
      return opts.compare === undefined ? null : opts.compare;
    },
    async getPull() {
      return pr;
    },
    async getPullDiff() {
      if (opts.diffError) throw opts.diffError;
      return diff;
    },
    async getFileContent(_owner: string, _repo: string, path: string, ref: string) {
      contentCalls.push({ path, ref });
      const err = opts.fileContentError?.(path);
      if (err) throw err;
      return opts.headFiles?.[path] ?? null;
    },
    async createCommitStatus(owner: string, repo: string, sha: string, input: CommitStatusInput) {
      statuses.push({ owner, repo, sha, input });
      if (opts.statusError) throw opts.statusError;
    },
    async listReviewComments(owner: string, repo: string, number: number) {
      listCalls.push({ owner, repo, number });
      if (opts.listError) throw opts.listError;
      return opts.existingComments ?? [];
    },
    async createReview(owner: string, repo: string, number: number, input: CreateReviewInput) {
      const err = opts.createReviewError?.();
      if (err) throw err;
      reviews.push({ owner, repo, number, input });
      return { id: 7, htmlUrl: 'https://github.com/o/r/pull/42#pullrequestreview-7' };
    },
  };
  return { reviews, listCalls, statuses, contentCalls, compareCalls, historyCalls, github };
}

const retrieveOne: RetrieveFn = async () => [CHUNK];

function makeDeps(db: Db, overrides: Partial<ReviewDeps> = {}): ReviewDeps {
  const llm = fakeLlm();
  return { db, llm: llm.provider, retrieve: retrieveOne, github: fakeGithub().github, ...overrides };
}

describe('reviewPullRequest', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
    db.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    // Indexed at the PR base by default, so no staleness note or "never indexed" warning.
    db.setRepoStatus(REPO_ID, 'ready', { last_commit: PR.baseSha });
  });
  afterEach(() => db.close());

  it.each([
    { costs: [0.012, 0.003, 0.004], expected: 0.019 },
    { costs: [0, 0, 0], expected: 0 },
    { costs: [0.012, null, 0.004], expected: null },
    { costs: [0.012, undefined, 0.004], expected: null },
    { costs: [[0.01, 0.002], 0.003, 0.004], expected: 0.019 },
    { costs: [[0.01, 0.002], undefined, 0.004], expected: null },
  ])('stores the review cost for $costs and preserves it on cache hits', async ({ costs, expected }) => {
    const tracker = new UsageTracker({ db, pricing: null });
    const fake = fakeLlm();
    const record = { provider: 'fake', model: 'm1', inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1 };
    const llm = { ...fake.provider, async complete(req: CompleteRequest) {
      const costUsd = costs[fake.calls.length];
      tracker.sinkFor('chat')({ ...record, costUsd: 1 });
      for (const value of Array.isArray(costUsd) ? costUsd : [costUsd]) {
        if (value !== undefined) tracker.sinkFor('review')({ ...record, costUsd: value });
      }
      return fake.provider.complete(req);
    } };
    const deps = makeDeps(db, { llm });
    const result = await reviewPullRequest(deps, { repoId: REPO_ID, prNumber: 42, post: false });
    expect(fake.calls).toHaveLength(3); // modified file, deleted file, summary
    expect(db.getReview(result.reviewId)?.cost_usd).toEqual(expected);
    await reviewPullRequest(deps, { repoId: REPO_ID, prNumber: 42, post: false });
    expect(fake.calls).toHaveLength(3);
    expect(db.listReviews(REPO_ID)[0]?.cost_usd).toEqual(expected);
  });

  it('keeps concurrent review costs separate', async () => {
    const tracker = new UsageTracker({ db, pricing: null });
    const results = await Promise.all([0.01, 0.02].map(async (costUsd, i) => {
      const fake = fakeLlm();
      const llm = { ...fake.provider, async complete(req: CompleteRequest) {
        await new Promise((resolve) => setTimeout(resolve, i ? 1 : 5));
        tracker.sinkFor('review')({ provider: 'fake', model: 'm1', inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1, costUsd });
        return fake.provider.complete(req);
      } };
      return reviewPullRequest(makeDeps(db, { llm }), { repoId: REPO_ID, prNumber: 42 + i, post: false });
    }));
    expect(results.map((r) => db.getReview(r.reviewId)?.cost_usd)).toEqual([0.03, 0.06]);
  });

  it('reviews forty Qwen files and summarizes in one bounded call, sharing context once', async () => {
    const paths = Array.from({ length: 40 }, (_, i) => `src/file${i}.ts`);
    const diff = paths.map((path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${'n'.repeat(2000)}\n`).join('');
    const gh = fakeGithub(diff);
    const calls: CompleteRequest[] = [];
    const llm: LLMProvider = { name: 'openrouter', model: 'qwen/qwen3-coder', supportsBatchReview: true, concurrency: 4, async complete(req) {
      calls.push(req);
      return JSON.stringify({ reviewedPaths: paths, summary: 'Updates the files.', verdict: 'request_changes', findings: [
        { path: paths[39], line: 1, severity: 'critical', title: 'Bug', body: 'Fix it.' },
        { path: paths[0], line: 1, severity: 'warning', title: 'Valid line', body: 'Not ignored.' },
      ] });
    } };
    const retrieve: RetrieveFn = async (req) => {
      expect(req.lexicalOnly).toBe(true);
      expect(req.excludePaths).toEqual(paths);
      return [CHUNK, { ...CHUNK, chunkId: 2, content: '💸'.repeat(200000) }];
    };
    const result = await reviewPullRequest({ db, llm, retrieve, github: gh.github }, { repoId: REPO_ID, prNumber: 42, post: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.reviewBudget).toBe(true);
    expect(reviewCostUpperBound(calls[0]!)).toBeGreaterThan(0.045);
    expect(reviewCostUpperBound(calls[0]!)).toBeLessThanOrEqual(REVIEW_MAX_USD);
    expect(calls[0]!.messages[0]!.content.split(CHUNK.content)).toHaveLength(2);
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]!.path).toBe(paths[39]);
    expect(result.verdict).toBe('request_changes');
    expect(result.warnings.some((w) => w.includes('optional context'))).toBe(true);
  });

  it('lists exactly the validator-allowed finding lines for normal, deleted and deletion-only files', async () => {
    const diff = [
      'diff --git a/src/app.ts b/src/app.ts', '--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1,2 +1,2 @@',
      ' context', '-old', '+new',
      'diff --git a/src/gone.ts b/src/gone.ts', 'deleted file mode 100644', '--- a/src/gone.ts', '+++ /dev/null', '@@ -10,2 +0,0 @@',
      '-gone', '-also gone',
      'diff --git a/src/auth.ts b/src/auth.ts', '--- a/src/auth.ts', '+++ b/src/auth.ts', '@@ -4,3 +4,1 @@',
      ' context', '-const auth = true;', '-const allowed = true;', '',
    ].join('\n');
    const requests: CompleteRequest[] = [];
    const llm: LLMProvider = { name: 'fake', model: 'batch', supportsBatchReview: true, concurrency: 1, async complete(req) {
      requests.push(req);
      return JSON.stringify({ reviewedPaths: ['src/app.ts', 'src/gone.ts', 'src/auth.ts'], summary: 'Reviewed.', verdict: 'request_changes', findings: [
        { path: 'src/app.ts', line: 2, severity: 'warning', title: 'Normal', body: 'Check.' },
        { path: 'src/gone.ts', line: 10, severity: 'critical', title: 'Deleted', body: 'Restore.' },
        { path: 'src/auth.ts', line: 4, severity: 'warning', title: 'Deletion only', body: 'Check.' },
      ] });
    } };
    const result = await reviewPullRequest({ db, llm, retrieve: async () => [], github: fakeGithub(diff).github }, { repoId: REPO_ID, prNumber: 42, post: false });
    const payload = JSON.parse(requests[0]!.messages[0]!.content) as { files: Array<{ path: string; allowedFindingLines: number[] }> };
    expect(payload.files.map((file) => [file.path, file.allowedFindingLines])).toEqual([
      ['src/app.ts', [2]],
      ['src/gone.ts', [10, 11]],
      ['src/auth.ts', [4, 5, 6]],
    ]);
    expect(result.findings.map((finding) => [finding.path, finding.line])).toEqual([
      ['src/gone.ts', 0], ['src/app.ts', 2], ['src/auth.ts', 0],
    ]);
  });

  it('fails oversized Qwen reviews before inference without posting or caching a clean review', async () => {
    const llm = { ...fakeLlm().provider, name: 'openrouter', model: 'qwen/qwen3-coder', supportsBatchReview: true, complete: async () => { throw new Error('must not call'); } };
    const gh = fakeGithub(DIFF.replace('+  if (n = 0) return;', '+' + '💸'.repeat(150000)));
    let retrievals = 0;
    const retrieve: RetrieveFn = async () => { retrievals++; return [CHUNK]; };
    await expect(reviewPullRequest({ db, llm, retrieve, github: gh.github, statusContext: 'repolens/review' }, { repoId: REPO_ID, prNumber: 42 })).rejects.toThrow('$0.25');
    expect(retrievals).toBe(0);
    expect(gh.statuses.map((s) => s.input.state)).toEqual(['pending', 'error']);
    expect(gh.reviews).toHaveLength(0);
    expect(db.findReview(REPO_ID, 42, PR.headSha)).toBeUndefined();
  });

  it.each([40, 2])('rejects Qwen reviews above the %i-file limit before fetching head content', async (maxFiles) => {
    const paths = Array.from({ length: maxFiles + 1 }, (_, i) => `src/file${i}.ts`);
    const diff = paths.map((path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`).join('');
    const gh = fakeGithub(diff);
    const llm = { ...fakeLlm().provider, name: 'openrouter', model: 'qwen/qwen3-coder' };
    await expect(reviewPullRequest({ db, llm, maxFiles, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 })).rejects.toThrow('file limit');
    expect(gh.contentCalls.filter((c) => c.ref === PR.headSha)).toEqual([]);
    expect(gh.reviews).toHaveLength(0);
  });

  it('records malformed Qwen JSON as an error and continues processing jobs', async () => {
    const gh = fakeGithub();
    const llm = { ...fakeLlm().provider, name: 'openrouter', model: 'qwen/qwen3-coder', supportsBatchReview: true, complete: async () => 'not JSON' };
    const queue = new JobQueue(db);
    const failed = queue.enqueue('review', REPO_ID, () => reviewPullRequest({ db, llm, retrieve: retrieveOne, github: gh.github, statusContext: 'repolens/review' }, { repoId: REPO_ID, prNumber: 42 }));
    const next = queue.enqueue('review', REPO_ID, async () => 'still running');
    await queue.idle();
    expect(db.getJob(failed.id)?.status).toBe('error');
    expect(db.getJob(next.id)?.status).toBe('done');
    expect(gh.statuses.map((s) => s.input.state)).toEqual(['pending', 'error']);
    expect(gh.reviews).toHaveLength(0);
    expect(db.findReview(REPO_ID, 42, PR.headSha)).toBeUndefined();
  });

  it('rejects a Qwen response that omitted a reviewed path', async () => {
    const llm = { ...fakeLlm().provider, name: 'openrouter', model: 'qwen/qwen3-coder', supportsBatchReview: true, complete: async () => JSON.stringify({ findings: [], summary: 'Fine', verdict: 'approve', reviewedPaths: [] }) };
    const gh = fakeGithub();
    await expect(reviewPullRequest({ db, llm, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 })).rejects.toThrow('Incomplete review');
    expect(gh.reviews).toHaveLength(0);
    expect(db.findReview(REPO_ID, 42, PR.headSha)).toBeUndefined();
  });

  it.each(['not JSON', JSON.stringify({ findings: [], summary: 'Fine', verdict: 'approve', reviewedPaths: [] })])('retries invalid batch responses and publishes only the valid fourth attempt: %s', async (invalid) => {
    const gh = fakeGithub();
    let calls = 0;
    const llm = { ...fakeLlm().provider, name: 'openrouter', model: 'qwen/qwen3-coder', supportsBatchReview: true, complete: async () => {
      calls++;
      return calls < 4 ? invalid : JSON.stringify({ findings: [], summary: 'Reviewed all changes.', verdict: 'approve', reviewedPaths: ['src/app.ts', 'src/gone.ts'] });
    } };
    const result = await reviewPullRequest({ db, llm, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 });
    expect(calls).toBe(4);
    expect(result.posted).toBe(true);
    expect(result.summary).toBe('Reviewed all changes.');
    expect(gh.reviews).toHaveLength(1);
  });

  it('retries an incomplete Qwen batch with the deleted file and publishes its body-only finding', async () => {
    const gh = fakeGithub();
    const deletedDiff = [
      '@@ -1,1 +0,0 @@',
      '    1 - const gone = true;',
    ].join('\n');
    const requests: CompleteRequest[] = [];
    let calls = 0;
    const llm = { ...fakeLlm().provider, name: 'openrouter', model: 'qwen/qwen3-coder', supportsBatchReview: true, complete: async (req: CompleteRequest) => {
      calls++;
      requests.push(req);
      if (calls === 1) return JSON.stringify({ findings: [], summary: 'Incomplete.', verdict: 'approve', reviewedPaths: ['src/app.ts'] });
      return JSON.stringify({
        reviewedPaths: ['src/app.ts', 'src/gone.ts'], summary: 'Auth was removed.', verdict: 'request_changes',
        findings: [{ path: 'src/gone.ts', line: 1, severity: 'critical', title: 'Auth removed', body: 'Restore the check.' }],
      });
    } };

    const result = await reviewPullRequest({ db, llm, retrieve: retrieveOne, github: gh.github, statusContext: 'repolens/review' }, { repoId: REPO_ID, prNumber: 42 });

    expect(calls).toBe(2);
    expect(requests).toHaveLength(2);
    for (const req of requests) {
      const payload = JSON.parse(req.messages[0]!.content.split('\n\n', 1)[0]!) as { files: Array<{ path: string; status: string; diff: string }> };
      expect(payload.files.find((file) => file.path === 'src/gone.ts')).toMatchObject({ status: 'deleted', diff: deletedDiff });
    }
    expect(result.status?.state).toBe('failure');
    expect(result.findings).toMatchObject([{ path: 'src/gone.ts', line: 0, severity: 'critical' }]);
    expect(gh.reviews[0]!.input.body).toContain('Auth removed');
    expect(gh.reviews[0]!.input.comments).toEqual([]);
  });

  it('retries a Qwen batch whose finding points outside the diff', async () => {
    const gh = fakeGithub();
    let calls = 0;
    const llm = { ...fakeLlm().provider, name: 'openrouter', model: 'qwen/qwen3-coder', supportsBatchReview: true, complete: async () => {
      calls++;
      return JSON.stringify({
        reviewedPaths: ['src/app.ts', 'src/gone.ts'], summary: 'Reviewed all changes.', verdict: 'approve',
        findings: calls === 1
          ? [{ path: 'src/app.ts', line: 999, severity: 'warning', title: 'Outside diff', body: 'Invalid line.' }]
          : [],
      });
    } };

    const result = await reviewPullRequest({ db, llm, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 });

    expect(calls).toBe(2);
    expect(result.posted).toBe(true);
    expect(gh.reviews).toHaveLength(1);
  });

  it.each([undefined, 0, 1])('stops invalid response retries at the configured limit %s', async (maxRetries) => {
    const gh = fakeGithub();
    let calls = 0;
    const llm = { ...fakeLlm().provider, name: 'openrouter', model: 'qwen/qwen3-coder', supportsBatchReview: true, complete: async () => { calls++; return '{}'; } };
    await expect(reviewPullRequest({ db, llm, maxRetries, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 })).rejects.toThrow('Incomplete review');
    expect(calls).toBe((maxRetries ?? 3) + 1);
    expect(gh.reviews).toHaveLength(0);
    expect(db.findReview(REPO_ID, 42, PR.headSha)).toBeUndefined();
  });

  it('stops retries when the next attempt would exceed the total review budget', async () => {
    const gh = fakeGithub(DIFF.replace('+  if (n = 0) return;', '+' + 'n'.repeat(300000)));
    let reserved = 0;
    let calls = 0;
    const llm = { ...fakeLlm().provider, name: 'openrouter', model: 'qwen/qwen3-coder', supportsBatchReview: true, complete: async (req: CompleteRequest) => {
      calls++;
      reserved += reviewCostUpperBound(req);
      return '{}';
    } };
    await expect(reviewPullRequest({ db, llm, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 })).rejects.toThrow('budget');
    expect(calls).toBe(1);
    expect(reserved).toBeLessThanOrEqual(REVIEW_MAX_USD);
    expect(gh.reviews).toHaveLength(0);
  });

  it('leaves retry budget after admitting optional context while preserving the full diff and history', async () => {
    const calls: CompleteRequest[] = [];
    const invalid = JSON.stringify({ reviewedPaths: ['src/app.ts', 'src/gone.ts'], summary: 'Incomplete.', verdict: 'approve',
      findings: [{ path: 'src/app.ts', line: 999, severity: 'critical', title: 'Bad', body: 'Fix.' }] });
    const valid = JSON.stringify({ reviewedPaths: ['src/app.ts', 'src/gone.ts'], summary: 'Complete.', verdict: 'approve', findings: [] });
    const fallback: LLMProvider = { name: 'fake', model: 'fallback', concurrency: 1, supportsBatchReview: true, complete: async (req) => {
      calls.push(req);
      return valid;
    } };
    const primary: LLMProvider = { name: 'fake', model: 'primary', concurrency: 1, supportsBatchReview: true, reviewFallbacks: [fallback], complete: async (req) => {
      calls.push(req);
      return invalid;
    } };
    const gh = fakeGithub(DIFF, PR, {
      headFiles: { 'src/app.ts': 'x'.repeat(50_000) },
      historyCommits: [{ sha: 'history-commit', message: 'history', htmlUrl: 'https://github.com/o/r/commit/history-commit' }],
      historyPulls: [{ number: 7, title: 'Old fix', body: 'Historical description', htmlUrl: 'https://github.com/o/r/pull/7', mergedAt: '2025-01-01', repository: 'o/r' }],
    });
    const result = await reviewPullRequest({ db, llm: primary, retrieve: async () => [{ ...CHUNK, content: 'x'.repeat(300_000) }], github: gh.github }, { repoId: REPO_ID, prNumber: 42, post: false });
    expect(result.summary).toBe('Complete.');
    expect(calls).toHaveLength(2);
    const primaryContent = calls[0]!.messages[0]!.content;
    expect(calls[1]!.messages[0]!.content).toBe(primaryContent);
    expect(primaryContent).toContain('Historical description');
    const payload = JSON.parse(primaryContent.split('\n\n', 1)[0]!) as { files: Array<{ path: string; status: string; diff: string }> };
    const expected = parseUnifiedDiff(DIFF)
      .filter((file) => file.newPath === 'src/app.ts' || file.oldPath === 'src/gone.ts')
      .map((file) => ({ path: file.newPath ?? file.oldPath!, status: file.status, diff: hunkText(file, Infinity) }));
    expect(payload.files.map(({ path, status, diff }) => ({ path, status, diff }))).toEqual(expected);
    expect(reviewCostUpperBound(calls[0]!) * 2).toBeLessThanOrEqual(REVIEW_MAX_USD);
  });

  it('retries truncated provider output and counts the cost of both attempts', async () => {
    const gh = fakeGithub();
    const tracker = new UsageTracker({ db, pricing: null });
    let calls = 0;
    const llm = new OpenRouterProvider({
      apiKey: 'fake', model: 'qwen/qwen3-coder', onUsage: tracker.sinkFor('review'),
      fetch: async () => {
        calls++;
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ findings: [], summary: 'Complete.', verdict: 'approve', reviewedPaths: ['src/app.ts', 'src/gone.ts'] }) }, finish_reason: calls === 1 ? 'length' : 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 100, cost: 0.01 },
        }), { status: 200 });
      },
    });
    const result = await reviewPullRequest({ db, llm, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 });
    expect(calls).toBe(2);
    expect(result.posted).toBe(true);
    expect(db.getReview(result.reviewId)?.cost_usd).toBeCloseTo(0.02);
    expect(gh.reviews).toHaveLength(1);
  });

  it('does not retry provider authentication failures', async () => {
    const gh = fakeGithub();
    let calls = 0;
    const llm = new OpenRouterProvider({ apiKey: 'fake', model: 'qwen/qwen3-coder', fetch: async () => {
      calls++;
      return new Response('unauthorized', { status: 401 });
    } });
    await expect(reviewPullRequest({ db, llm, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 })).rejects.toThrow('401');
    expect(calls).toBe(1);
    expect(gh.reviews).toHaveLength(0);
  });

  it('abandons retries if the PR changes after an invalid response', async () => {
    const gh = fakeGithub();
    let calls = 0;
    const llm = { ...fakeLlm().provider, name: 'openrouter', model: 'qwen/qwen3-coder', supportsBatchReview: true, complete: async () => {
      calls++;
      gh.github.getPull = async () => ({ ...PR, headSha: 'moved' });
      return '{}';
    } };
    await expect(reviewPullRequest({ db, llm, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 })).rejects.toBeInstanceOf(ReviewSupersededError);
    expect(calls).toBe(1);
    expect(gh.reviews).toHaveLength(0);
  });

  it.each(['qwen/qwen3-coder-next', 'other/coder'])('batches reviews for %s without a model-name special case', async (model) => {
    const gh = fakeGithub(DIFF, PR, {
      historyCommits: [{ sha: 'history-commit', message: 'history', htmlUrl: 'https://github.com/o/r/commit/history-commit' }],
      historyPulls: [{ number: 7, title: 'Old fix', body: 'Historical description', htmlUrl: 'https://github.com/o/r/pull/7', mergedAt: '2025-01-01', repository: 'o/r' }],
    });
    const calls: CompleteRequest[] = [];
    const llm = new OpenRouterProvider({ apiKey: 'fake', model, fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe(model);
      expect(body.provider.max_price).toEqual({ prompt: 0.4, completion: 2, request: 0 });
      expect(body.messages[0].content).toBe(BATCH_REVIEW_SYSTEM_PROMPT);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ findings: [], summary: 'Complete.', verdict: 'approve', reviewedPaths: ['src/app.ts', 'src/gone.ts'] }) }, finish_reason: 'stop' }] }));
    } });
    const wrapped = { name: llm.name, model: llm.model, concurrency: llm.concurrency, supportsBatchReview: true,
      complete: (req: CompleteRequest) => { calls.push(req); return llm.complete(req); } };
    const result = await reviewPullRequest({ db, llm: wrapped, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 });
    expect(result.posted).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.messages[0]!.content).toContain('Historical description');
  });

  it.each(['408', '429', '503', 'timeout', 'invalid', 'truncated', 'missing content', 'invalid finding'])('falls back on %s with the same prompt and attributes the actual model', async (failure) => {
    const gh = fakeGithub(DIFF, PR, {
      historyCommits: [{ sha: 'history-commit', message: 'history', htmlUrl: 'https://github.com/o/r/commit/history-commit' }],
      historyPulls: [{ number: 7, title: 'Old fix', body: 'Historical description', htmlUrl: 'https://github.com/o/r/pull/7', mergedAt: '2025-01-01', repository: 'o/r' }],
    });
    const tracker = new UsageTracker({ db, pricing: null });
    const sent: Array<{ model: string; messages: unknown; provider: unknown }> = [];
    const response = (content: string, finish_reason = 'stop') => new Response(JSON.stringify({
      choices: [{ message: { content }, finish_reason }],
      usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.01 },
    }));
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      sent.push(body);
      if (body.model === 'qwen/qwen3-coder') {
        if (failure === '408' || failure === '429' || failure === '503') return new Response('unavailable', { status: Number(failure) });
        if (failure === 'timeout') throw new Error('timeout');
        if (failure === 'missing content') return new Response(JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.01 } }));
        if (failure === 'invalid finding') return response(JSON.stringify({ findings: [{ path: 'src/app.ts', line: 999, severity: 'critical', title: 'Bad', body: 'Fix' }], summary: 'Complete.', verdict: 'request_changes', reviewedPaths: ['src/app.ts', 'src/gone.ts'] }));
        return response('{}', failure === 'truncated' ? 'length' : 'stop');
      }
      return response(JSON.stringify({ findings: [], summary: 'Complete.', verdict: 'approve', reviewedPaths: ['src/app.ts', 'src/gone.ts'] }));
    };
    const fallback = new OpenRouterProvider({ apiKey: 'fake', model: 'qwen/qwen3-coder-next', fetch, onUsage: tracker.sinkFor('review') });
    const llm = Object.assign(new OpenRouterProvider({ apiKey: 'fake', model: 'qwen/qwen3-coder', fetch, onUsage: tracker.sinkFor('review') }), { reviewFallbacks: [fallback] });
    const result = await reviewPullRequest({ db, llm, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42, post: false });
    expect(sent.map((r) => r.model)).toEqual(['qwen/qwen3-coder', 'qwen/qwen3-coder-next']);
    expect(sent[1]!.messages).toEqual(sent[0]!.messages);
    expect(JSON.stringify(sent[1]!.messages)).toContain('Historical description');
    expect(sent.every((r) => (r.provider as { allow_fallbacks: boolean }).allow_fallbacks === false)).toBe(true);
    expect(result.warnings.join(' ')).toContain('qwen/qwen3-coder-next');
    expect(db.getReview(result.reviewId)?.model).toBe('qwen/qwen3-coder-next');
    if (['invalid', 'truncated', 'missing content', 'invalid finding'].includes(failure)) {
      expect(db.getReview(result.reviewId)?.cost_usd).toBeCloseTo(0.02);
      expect((await tracker.report(1)).rows.map((r) => r.model).sort()).toEqual(['qwen/qwen3-coder', 'qwen/qwen3-coder-next']);
    } else {
      expect(db.getReview(result.reviewId)?.cost_usd).toBeNull();
    }
    // Posting a saved review later must preserve the generating model.
    await reviewPullRequest({ db, llm, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 });
    expect(sent).toHaveLength(2);
    expect(gh.reviews[0]!.input.body).toContain('qwen/qwen3-coder-next');
  });

  it.each([400, 401, 402, 403])('does not fall back on HTTP %s', async (status) => {
    const gh = fakeGithub();
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => { calls++; return new Response('rejected', { status }); };
    const fallback = new OpenRouterProvider({ apiKey: 'fake', model: 'qwen/qwen3-coder-next', fetch });
    const llm = Object.assign(new OpenRouterProvider({ apiKey: 'fake', model: 'qwen/qwen3-coder', fetch }), { reviewFallbacks: [fallback] });
    await expect(reviewPullRequest({ db, llm, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 })).rejects.toThrow(`HTTP ${status}`);
    expect(calls).toBe(1);
    expect(gh.reviews).toHaveLength(0);
  });

  it.each([0, 1, 3])('stops the fallback chain at the shared retry limit %s', async (maxRetries) => {
    const gh = fakeGithub();
    const models: string[] = [];
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      models.push(JSON.parse(String(init?.body)).model);
      return new Response('unavailable', { status: 503 });
    };
    const alternatives = ['second/coder', 'third/coder'].map((model) => new OpenRouterProvider({ apiKey: 'fake', model, fetch }));
    const llm = Object.assign(new OpenRouterProvider({ apiKey: 'fake', model: 'first/coder', fetch }), { reviewFallbacks: alternatives });
    await expect(reviewPullRequest({ db, llm, maxRetries, retrieve: retrieveOne, github: gh.github, statusContext: 'repolens/review' }, { repoId: REPO_ID, prNumber: 42 })).rejects.toThrow('503');
    expect(models).toEqual(['first/coder', 'second/coder', 'third/coder', 'third/coder'].slice(0, maxRetries + 1));
    expect(gh.reviews).toHaveLength(0);
    expect(gh.statuses.map((s) => s.input.state)).toEqual(['pending', 'error']);
  });

  it('starts each review at the primary without mutating shared providers', async () => {
    const gh = fakeGithub();
    const models: string[] = [];
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      const model = JSON.parse(String(init?.body)).model;
      models.push(model);
      if (models.length === 1) return new Response('unavailable', { status: 503 });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ findings: [], summary: 'Complete.', verdict: 'approve', reviewedPaths: ['src/app.ts', 'src/gone.ts'] }) }, finish_reason: 'stop' }] }));
    };
    const llm = Object.assign(new OpenRouterProvider({ apiKey: 'fake', model: 'first/coder', fetch }), {
      reviewFallbacks: [new OpenRouterProvider({ apiKey: 'fake', model: 'second/coder', fetch })],
    });
    const deps = { db, llm, retrieve: retrieveOne, github: gh.github };
    await reviewPullRequest(deps, { repoId: REPO_ID, prNumber: 42, post: false });
    await reviewPullRequest(deps, { repoId: REPO_ID, prNumber: 42, force: true, post: false });
    expect(models).toEqual(['first/coder', 'second/coder', 'first/coder']);
    expect(llm.model).toBe('first/coder');
  });

  it('reserves failed primary calls against the fallback budget', async () => {
    const gh = fakeGithub(DIFF.replace('+  if (n = 0) return;', '+' + 'n'.repeat(300000)));
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => { calls++; return new Response('unavailable', { status: 503 }); };
    const fallback = new OpenRouterProvider({ apiKey: 'fake', model: 'qwen/qwen3-coder-next', fetch });
    const llm = Object.assign(new OpenRouterProvider({ apiKey: 'fake', model: 'qwen/qwen3-coder', fetch }), { reviewFallbacks: [fallback] });
    await expect(reviewPullRequest({ db, llm, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 })).rejects.toThrow('budget');
    expect(calls).toBe(1);
    expect(gh.reviews).toHaveLength(0);
  });

  it('abandons the review without posting when the PR head moves mid-review', async () => {
    const llm = fakeLlm();
    const gh = fakeGithub();
    let calls = 0;
    gh.github.getPull = async () => (calls++ === 0 ? PR : { ...PR, headSha: 'moved' });
    await expect(
      reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github, statusContext: 'repolens/review' }, { repoId: REPO_ID, prNumber: 42 }),
    ).rejects.toBeInstanceOf(ReviewSupersededError);
    expect(llm.fileCalls()).toHaveLength(0);
    expect(gh.reviews).toHaveLength(0);
    expect(gh.statuses.map((s) => s.input.state)).toEqual(['pending']);
    expect(db.findReview(REPO_ID, 42, PR.headSha)).toBeUndefined();
  });

  it('fails closed when a finding points outside the reviewable diff', async () => {
    const llm = fakeLlm({ allowDeleted: true,
      file: JSON.stringify({
        findings: [
          { line: 4, severity: 'critical', title: 'Assignment in condition', body: 'Use `===`.' },
          { line: 999, severity: 'warning', title: 'Not in diff', body: 'nope' },
          { line: 5, severity: 'warning', title: 'Context line', body: 'not an added line' },
        ],
      }),
      summary: '{"summary":"Adds a guard.","verdict":"request_changes"}',
    });
    const gh = fakeGithub();
    await expect(reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, {
      repoId: REPO_ID,
      prNumber: 42,
    })).rejects.toThrow('invalid finding line');
  });

  it('reviews only reviewable files and reports the rest as skipped', async () => {
    const llm = fakeLlm();
    const gh = fakeGithub();
    const res = await reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, {
      repoId: REPO_ID,
      prNumber: 42,
    });
    expect(llm.fileCalls()).toHaveLength(2);
    expect(llm.fileCalls()[0]!.messages[0]!.content).toContain('src/app.ts');
    expect(res.skippedFiles.sort()).toEqual(['assets/logo.png', 'package-lock.json']);
  });

  it('posts a review with the head sha and severity-tagged inline comments', async () => {
    const llm = fakeLlm({
      file: JSON.stringify({ findings: [{ line: 4, severity: 'critical', title: 'Assignment', body: 'Use `===`.' }] }),
    });
    const gh = fakeGithub();
    const res = await reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, {
      repoId: REPO_ID,
      prNumber: 42,
    });

    expect(gh.reviews).toHaveLength(1);
    const { owner, repo, number, input } = gh.reviews[0]!;
    expect({ owner, repo, number }).toEqual({ owner: 'o', repo: 'r', number: 42 });
    expect(input.commitId).toBe('head-sha-1');
    expect(input.event).toBe('COMMENT');
    expect(input.comments).toEqual([
      { path: 'src/app.ts', line: 4, body: '**[critical] Assignment**\n\nUse `===`.' },
    ]);
    expect(input.body).toContain('## RepoLens review');
    expect(input.body).toContain('| critical | src/app.ts:4 | Assignment |');
    expect(res.posted).toBe(true);
    expect(res.reviewUrl).toContain('pullrequestreview-7');
    expect(db.getReview(res.reviewId)!.posted).toBe(1);
  });

  it('posts REQUEST_CHANGES only when the verdict says so', async () => {
    const llm = fakeLlm({
      file: JSON.stringify({ findings: [{ line: 3, severity: 'critical', title: 'Bad', body: 'boom' }] }),
      summary: '{"summary":"Risky.","verdict":"request_changes"}',
    });
    const gh = fakeGithub();
    await reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 });
    expect(gh.reviews[0]!.input.event).toBe('REQUEST_CHANGES');
  });

  it('never sends APPROVE: an approve verdict posts as COMMENT', async () => {
    const llm = fakeLlm({ summary: '{"summary":"Looks good.","verdict":"approve"}' });
    const gh = fakeGithub();
    const res = await reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, {
      repoId: REPO_ID,
      prNumber: 42,
    });
    expect(res.verdict).toBe('approve');
    expect(gh.reviews[0]!.input.event).toBe('COMMENT');
  });

  it('downgrades request_changes to comment when there is no critical finding', async () => {
    const llm = fakeLlm({
      file: JSON.stringify({ findings: [{ line: 4, severity: 'nit', title: 'Minor', body: 'meh' }] }),
      summary: '{"summary":"Small change.","verdict":"request_changes"}',
    });
    const gh = fakeGithub();
    const res = await reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, {
      repoId: REPO_ID,
      prNumber: 42,
    });
    expect(res.verdict).toBe('comment');
    expect(gh.reviews[0]!.input.event).toBe('COMMENT');
  });

  it('does not post when post:false', async () => {
    const llm = fakeLlm();
    const gh = fakeGithub();
    const res = await reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, {
      repoId: REPO_ID,
      prNumber: 42,
      post: false,
    });
    expect(gh.reviews).toHaveLength(0);
    expect(res.posted).toBe(false);
    expect(db.getReview(res.reviewId)!.posted).toBe(0);
  });

  it('returns the cached review for the same head sha without calling the LLM again', async () => {
    const llm = fakeLlm({
      file: JSON.stringify({ findings: [{ line: 4, severity: 'warning', title: 'Hmm', body: 'check' }] }),
    });
    const gh = fakeGithub();
    const deps = { db, llm: llm.provider, retrieve: retrieveOne, github: gh.github };
    const first = await reviewPullRequest(deps, { repoId: REPO_ID, prNumber: 42 });
    const callsAfterFirst = llm.calls.length;

    const second = await reviewPullRequest(deps, { repoId: REPO_ID, prNumber: 42 });
    expect(llm.calls).toHaveLength(callsAfterFirst);
    expect(gh.reviews).toHaveLength(1);
    expect(second.reviewId).toBe(first.reviewId);
    expect(second.posted).toBe(true);
    expect(second.findings).toEqual(first.findings);
    expect(second.verdict).toBe(first.verdict);
  });

  it('re-reviews when force is set', async () => {
    const llm = fakeLlm();
    const gh = fakeGithub();
    const deps = { db, llm: llm.provider, retrieve: retrieveOne, github: gh.github };
    const first = await reviewPullRequest(deps, { repoId: REPO_ID, prNumber: 42 });
    const second = await reviewPullRequest(deps, { repoId: REPO_ID, prNumber: 42, force: true });
    expect(second.reviewId).not.toBe(first.reviewId);
    expect(gh.reviews).toHaveLength(2);
  });

  it('fails closed when a file review returns garbage', async () => {
    const llm = fakeLlm({ file: 'I am not JSON at all.' });
    const gh = fakeGithub();
    await expect(reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, {
      repoId: REPO_ID,
      prNumber: 42,
    })).rejects.toThrow('file review failed');
    expect(gh.reviews).toHaveLength(0);
  });

  it('fails closed when the summary call fails', async () => {
    const llm = fakeLlm({
      file: JSON.stringify({ findings: [{ line: 4, severity: 'warning', title: 'Hmm', body: 'check' }] }),
      summary: 'not json',
    });
    const gh = fakeGithub();
    await expect(reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, {
      repoId: REPO_ID,
      prNumber: 42,
    })).rejects.toThrow('summary review failed');
  });

  it('passes repo instructions and retrieved context to the file prompt', async () => {
    db.setRepoInstructions(REPO_ID, 'Always check for SQL injection.');
    const llm = fakeLlm();
    const gh = fakeGithub();
    await reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 });
    const msg = llm.fileCalls()[0]!.messages[0]!.content;
    expect(msg).toContain('Always check for SQL injection.');
    expect(msg).toContain('src/x.ts:1-3');
    expect(msg).toContain('if (n = 0) return;');
    expect(llm.fileCalls()[0]!.json).toBe(true);
    expect(llm.fileCalls()[0]!.maxTokens).toBe(2000);
  });

  it('builds the retrieval query from the path and added-line identifiers', async () => {
    const seen: string[] = [];
    const retrieve: RetrieveFn = async (req) => {
      seen.push(req.query);
      // Every changed path, including the ones that are not reviewed: their index
      // chunks describe the base branch, not this PR.
      expect(req.excludePaths).toEqual(['src/app.ts', 'package-lock.json', 'assets/logo.png']);
      expect(req.limit).toBe(8);
      expect(req.repoIds).toEqual([REPO_ID]);
      return [];
    };
    const llm = fakeLlm();
    await reviewPullRequest({ db, llm: llm.provider, retrieve, github: fakeGithub().github }, { repoId: REPO_ID, prNumber: 42 });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain('src/app.ts');
    expect(seen[0]).toContain('run');
    expect(seen[0]).toContain('number');
  });

  it('fails closed on maxFiles overflow for every provider', async () => {
    const llm = fakeLlm();
    const gh = fakeGithub();
    await expect(reviewPullRequest(
      { db, llm: llm.provider, retrieve: retrieveOne, github: gh.github, maxFiles: 0 },
      { repoId: REPO_ID, prNumber: 42 },
    )).rejects.toThrow('file limit');
    expect(llm.fileCalls()).toHaveLength(0);
  });

  it('reviews deleted source files and keeps findings in the body', async () => {
    const llm = fakeLlm({ allowDeleted: true,
      file: JSON.stringify({ findings: [{ line: 1, severity: 'critical', title: 'Auth bypass', body: 'Do not remove this check.' }] }),
    });
    const gh = fakeGithub(DIFF);
    const res = await reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, {
      repoId: REPO_ID, prNumber: 42,
    });
    const finding = res.findings.find((f) => f.path === 'src/gone.ts');
    expect(finding).toMatchObject({ line: 0, severity: 'critical' });
    expect(gh.reviews[0]!.input.comments.some((c) => c.path === 'src/gone.ts')).toBe(false);
    expect(gh.reviews[0]!.input.body).toContain('Auth bypass');
  });

  it('reviews deletion-only auth removal and blocks without inline comments', async () => {
    const diff = 'diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,2 +1 @@\n-checkAuth();\n serve();\n';
    const llm = fakeLlm({ file: JSON.stringify({ findings: [{ line: 1, severity: 'critical', title: 'Auth removed', body: 'Restore the check.' }] }) });
    const gh = fakeGithub(diff);
    const result = await reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github, statusContext: 'repolens/review' }, { repoId: REPO_ID, prNumber: 42 });
    expect(llm.fileCalls()).toHaveLength(1);
    expect(result.status?.state).toBe('failure');
    expect(result.findings[0]).toMatchObject({ path: 'src/auth.ts', line: 0 });
    expect(gh.reviews[0]!.input.comments).toEqual([]);
    expect(gh.reviews[0]!.input.body).toContain('Restore the check.');
  });

  it.each(['provider failure', 'invalid severity'])('reports error and does not cache success on %s', async (failure) => {
    const llm = fakeLlm({ file: () => {
      if (failure === 'provider failure') throw new Error('unavailable');
      return JSON.stringify({ findings: [{ line: 4, severity: 'severe', title: 'Auth removed', body: 'Restore the check.' }] });
    } });
    const gh = fakeGithub();
    await expect(reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github, statusContext: 'repolens/review' }, { repoId: REPO_ID, prNumber: 42 })).rejects.toThrow('file review failed');
    expect(gh.statuses.map((s) => s.input.state)).toEqual(['pending', 'error']);
    expect(db.findReview(REPO_ID, 42, PR.headSha)).toBeUndefined();
    expect(gh.reviews).toEqual([]);
  });

  it('reviews deleted source files in Qwen batch mode and blocks on body findings', async () => {
    const deleted = [
      'diff --git a/src/auth.ts b/src/auth.ts', 'deleted file mode 100644',
      '--- a/src/auth.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@',
      '-checkAuth(user);', '-return secret;', '',
    ].join('\n');
    const llm = { ...fakeLlm().provider, name: 'openrouter', model: 'qwen/qwen3-coder', supportsBatchReview: true, complete: async (req: CompleteRequest) => {
      if (req.system === BATCH_REVIEW_SYSTEM_PROMPT) return JSON.stringify({
        reviewedPaths: ['src/auth.ts'], summary: 'Removed auth.', verdict: 'request_changes',
        findings: [{ path: 'src/auth.ts', line: 1, severity: 'critical', title: 'Auth removed', body: 'Restore the check.' }],
      });
      throw new Error('unexpected call');
    } };
    const gh = fakeGithub(deleted);
    const res = await reviewPullRequest({ db, llm, retrieve: retrieveOne, github: gh.github, statusContext: 'repolens/review' }, {
      repoId: REPO_ID, prNumber: 42,
    });
    expect(res.findings).toMatchObject([{ path: 'src/auth.ts', line: 0, severity: 'critical' }]);
    expect(res.status).toEqual({ state: 'failure', description: '1 critical' });
    expect(gh.reviews[0]!.input.comments).toEqual([]);
    expect(gh.reviews[0]!.input.body).toContain('Auth removed');
  });

  it('keeps the stored review and warns when posting throws', async () => {
    const llm = fakeLlm({
      file: JSON.stringify({ findings: [{ line: 4, severity: 'warning', title: 'Hmm', body: 'check' }] }),
    });
    const gh = fakeGithub(DIFF, PR, { createReviewError: () => new Error('GitHub 502 POST reviews') });
    const res = await reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, {
      repoId: REPO_ID,
      prNumber: 42,
    });

    expect(res.posted).toBe(false);
    expect(res.reviewUrl).toBeUndefined();
    expect(res.warnings.some((w) => w.includes('GitHub 502'))).toBe(true);
    const row = db.getReview(res.reviewId)!;
    expect(row.posted).toBe(0);
    expect(row.status).toBe('done');
  });

  it('retries the post for a cached review that was never posted, without calling the LLM', async () => {
    const llm = fakeLlm({
      file: JSON.stringify({ findings: [{ line: 4, severity: 'warning', title: 'Hmm', body: 'check' }] }),
    });
    let fail = true;
    const gh = fakeGithub(DIFF, PR, { createReviewError: () => (fail ? new Error('boom') : null) });
    const deps = { db, llm: llm.provider, retrieve: retrieveOne, github: gh.github };

    const first = await reviewPullRequest(deps, { repoId: REPO_ID, prNumber: 42 });
    expect(first.posted).toBe(false);
    expect(gh.reviews).toHaveLength(0);
    const callsAfterFirst = llm.calls.length;

    fail = false;
    const second = await reviewPullRequest(deps, { repoId: REPO_ID, prNumber: 42 });
    expect(llm.calls).toHaveLength(callsAfterFirst);
    expect(second.reviewId).toBe(first.reviewId);
    expect(second.posted).toBe(true);
    expect(second.findings).toEqual(first.findings);
    expect(gh.reviews).toHaveLength(1);
    expect(gh.reviews[0]!.input.comments).toHaveLength(1);
    expect(db.getReview(second.reviewId)!.posted).toBe(1);
  });

  it('drops findings that already have an identical review comment', async () => {
    const llm = fakeLlm({
      file: JSON.stringify({
        findings: [
          { line: 4, severity: 'warning', title: 'Assignment in condition', body: 'Use `===`.' },
          { line: 3, severity: 'nit', title: 'Fresh one', body: 'new' },
        ],
      }),
    });
    const gh = fakeGithub(DIFF, PR, {
      existingComments: [
        { path: 'src/app.ts', line: 4, body: '**[warning] Assignment in condition**\n\nUse `===`.', user: 'repolens[bot]' },
      ],
    });
    const res = await reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, {
      repoId: REPO_ID,
      prNumber: 42,
    });

    expect(gh.listCalls).toEqual([{ owner: 'o', repo: 'r', number: 42 }]);
    expect(res.findings).toHaveLength(2);
    expect(gh.reviews[0]!.input.comments).toEqual([
      { path: 'src/app.ts', line: 3, body: '**[nit] Fresh one**\n\nnew' },
    ]);
    expect(res.warnings).toContain('Skipped 1 findings already commented');
  });

  it('posts every finding when listing existing comments fails', async () => {
    const llm = fakeLlm({
      file: JSON.stringify({ findings: [{ line: 4, severity: 'warning', title: 'Hmm', body: 'check' }] }),
    });
    const gh = fakeGithub(DIFF, PR, { listError: new Error('GitHub 403 GET comments') });
    const res = await reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, {
      repoId: REPO_ID,
      prNumber: 42,
    });
    expect(res.posted).toBe(true);
    expect(gh.reviews[0]!.input.comments).toHaveLength(1);
    expect(res.warnings.some((w) => w.includes('GitHub 403'))).toBe(true);
  });

  it('notes in the body when the index is older than the PR base', async () => {
    db.setRepoStatus(REPO_ID, 'ready', { last_commit: 'older-commit-sha' });
    const llm = fakeLlm();
    const gh = fakeGithub();
    await reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 });
    expect(gh.reviews[0]!.input.body).toContain('<sub>Context indexed at older-c; PR base is base-sh.</sub>');
  });

  it('warns when the repository has never been indexed', async () => {
    db.setRepoStatus(REPO_ID, 'queued', { last_commit: null });
    const llm = fakeLlm();
    const gh = fakeGithub();
    const res = await reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, {
      repoId: REPO_ID,
      prNumber: 42,
    });
    expect(res.warnings).toContain('Repository has not been indexed; review ran without codebase context.');
    expect(gh.reviews[0]!.input.body).not.toContain('Context indexed at');
  });

  it('throws for an unknown repo', async () => {
    await expect(reviewPullRequest(makeDeps(db), { repoId: 'github:nope/nope', prNumber: 1 })).rejects.toThrow(/Unknown repo/);
  });
});

describe('reviewPullRequest PR-head context', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
    db.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    db.setRepoStatus(REPO_ID, 'ready', { last_commit: PR.baseSha });
  });
  afterEach(() => db.close());

  // a.ts uses a helper that b.ts adds in this same PR: the index still has the old b.ts.
  const TWO_FILE_DIFF = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,3 @@',
    " import { helper } from './b.js';",
    ' ',
    '+export const value = helper(2);',
    'diff --git a/src/b.ts b/src/b.ts',
    '--- a/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -1,1 +1,3 @@',
    ' export const base = 1;',
    '+',
    '+export function helper(n: number) { return n + base; }',
    '',
  ].join('\n');

  const A_HEAD = "import { helper } from './b.js';\n\nexport const value = helper(2);\n";
  const B_HEAD = 'export const base = 1;\n\nexport function helper(n: number) { return n + base; }\n';
  const HEAD_FILES = { 'src/a.ts': A_HEAD, 'src/b.ts': B_HEAD };

  const AUTHORITATIVE = '## Files changed in this pull request (post-change content, authoritative)';
  const INDEXED = "## Related code from the base-branch index (may not reflect this PR's changes)";

  /** A stale chunk for a changed path plus an unrelated one, filtered like the real retriever. */
  function stalyRetrieve(seen: string[][]): RetrieveFn {
    const chunks: RetrievedChunk[] = [
      { chunkId: 1, repoId: REPO_ID, path: 'src/b.ts', startLine: 1, endLine: 1, content: 'export const base = 1; // STALE b.ts', score: 1 },
      { chunkId: 2, repoId: REPO_ID, path: 'src/other.ts', startLine: 1, endLine: 1, content: 'export const other = 2;', score: 0.5 },
    ];
    return async (req) => {
      seen.push(req.excludePaths ?? []);
      const excluded = new Set(req.excludePaths ?? []);
      return chunks.filter((c) => !excluded.has(c.path));
    };
  }

  it('gives the reviewer the post-change content of the files a change references', async () => {
    const llm = fakeLlm();
    const gh = fakeGithub(TWO_FILE_DIFF, PR, { headFiles: HEAD_FILES });
    const excludes: string[][] = [];
    await reviewPullRequest(
      { db, llm: llm.provider, retrieve: stalyRetrieve(excludes), github: gh.github },
      { repoId: REPO_ID, prNumber: 42 },
    );

    // Lineage reads overview docs at the base sha; the post-change fetches are the head ones.
    const headCalls = gh.contentCalls.filter((c) => c.ref === PR.headSha);
    expect(headCalls.map((c) => c.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);

    const msg = llm.fileCalls().find((c) => c.messages[0]!.content.includes('File under review: src/a.ts'))!.messages[0]!.content;
    // b.ts's new content is present, under the authoritative heading and before the index one.
    expect(msg).toContain(AUTHORITATIVE);
    expect(msg).toContain('### src/b.ts (content after this pull request)');
    expect(msg).toContain('export function helper(n: number) { return n + base; }');
    expect(msg.indexOf(AUTHORITATIVE)).toBeLessThan(msg.indexOf('### src/b.ts (content after this pull request)'));
    expect(msg.indexOf('### src/b.ts (content after this pull request)')).toBeLessThan(msg.indexOf(INDEXED));
    // The reviewed file's own new content is there too, so the model sees past the hunk.
    expect(msg).toContain('### src/a.ts (content after this pull request)');

    // Every changed path is excluded from retrieval, so no stale chunk survives.
    for (const paths of excludes) expect(paths).toEqual(['src/a.ts', 'src/b.ts']);
    expect(msg).not.toContain('STALE b.ts');
    expect(msg).toContain('export const other = 2;');
  });

  it('matches an added identifier to the changed file that exports it', async () => {
    // c.ts has no import of b.ts at all; only the added line mentions `helper`.
    const diff = [
      'diff --git a/src/c.ts b/src/c.ts',
      '--- a/src/c.ts',
      '+++ b/src/c.ts',
      '@@ -1,1 +1,2 @@',
      ' const n = 1;',
      '+const out = helper(n);',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1,1 +1,3 @@',
      ' export const base = 1;',
      '+',
      '+export function helper(n: number) { return n + base; }',
      '',
    ].join('\n');
    const llm = fakeLlm();
    const gh = fakeGithub(diff, PR, { headFiles: { 'src/c.ts': 'const n = 1;\nconst out = helper(n);\n', 'src/b.ts': B_HEAD } });
    await reviewPullRequest({ db, llm: llm.provider, retrieve: async () => [], github: gh.github }, { repoId: REPO_ID, prNumber: 42 });

    const msg = llm.fileCalls().find((c) => c.messages[0]!.content.includes('File under review: src/c.ts'))!.messages[0]!.content;
    expect(msg).toContain('### src/b.ts (content after this pull request)');
    expect(msg).toContain('export function helper(n: number) { return n + base; }');
  });

  it('warns but completes when head content is oversized, missing or fails to fetch', async () => {
    const llm = fakeLlm();
    const gh = fakeGithub(TWO_FILE_DIFF, PR, {
      headFiles: { 'src/a.ts': 'x'.repeat(60_001) },
      fileContentError: (p) => (p === 'src/b.ts' ? new Error('GitHub 502 GET contents') : null),
    });
    const res = await reviewPullRequest(
      { db, llm: llm.provider, retrieve: async () => [], github: gh.github },
      { repoId: REPO_ID, prNumber: 42 },
    );

    expect(res.findings).toEqual([]);
    expect(llm.fileCalls()).toHaveLength(2);
    expect(res.warnings.some((w) => w.includes('src/a.ts: post-change content skipped'))).toBe(true);
    expect(res.warnings.some((w) => w.includes('src/b.ts: fetching post-change content failed: GitHub 502'))).toBe(true);
    const msg = llm.fileCalls()[0]!.messages[0]!.content;
    expect(msg).not.toContain('content after this pull request');
  });

  it('logs, but does not warn, when a changed file has no content at the head sha', async () => {
    const llm = fakeLlm();
    const gh = fakeGithub(TWO_FILE_DIFF, PR, { headFiles: { 'src/a.ts': A_HEAD } });
    const logs: string[] = [];
    const res = await reviewPullRequest(
      { db, llm: llm.provider, retrieve: async () => [], github: gh.github, log: (m) => logs.push(m) },
      { repoId: REPO_ID, prNumber: 42 },
    );
    expect(res.warnings).toEqual([]);
    expect(logs.some((l) => l.includes('src/b.ts: no post-change content at head-sh'))).toBe(true);
    // a.ts still gets its own content; b.ts is simply not quoted.
    const msg = llm.fileCalls().find((c) => c.messages[0]!.content.includes('File under review: src/a.ts'))!.messages[0]!.content;
    expect(msg).toContain('### src/a.ts (content after this pull request)');
    expect(msg).not.toContain('### src/b.ts');
  });
});

describe('reviewPullRequest lineage', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
    db.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    db.setRepoStatus(REPO_ID, 'ready', { last_commit: PR.baseSha });
  });
  afterEach(() => db.close());

  const DELTA = [
    'diff --git a/src/app.ts b/src/app.ts',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -4,2 +4,2 @@',
    '-  if (n = 0) return;',
    '+  if (n === 0) return;',
    '',
  ].join('\n');

  it('feeds the previous review, the delta and the commits to the prompts and notes the review number in the body', async () => {
    db.insertReview({
      repo_id: REPO_ID, pr_number: 42, head_sha: 'head-sha-0', status: 'done', summary: 'First pass.', verdict: 'request_changes',
      comments_json: JSON.stringify([{ path: 'src/app.ts', line: 5, severity: 'critical', title: 'Assignment in condition', body: 'Use ===.' }]),
      posted: 1, error: null,
    });
    const llm = fakeLlm();
    const gh = fakeGithub(DIFF, PR, {
      commits: [{ sha: 'head-sha-0', message: 'feat: run' }, { sha: 'head-sha-1', message: 'fix: compare' }],
      compare: DELTA,
    });
    const result = await reviewPullRequest(makeDeps(db, { llm: llm.provider, github: gh.github }), { repoId: REPO_ID, prNumber: 42 });

    expect(gh.compareCalls).toEqual([{ base: 'head-sha-0', head: 'head-sha-1' }]);
    const file = llm.fileCalls()[0]!.messages[0]!.content as string;
    expect(file).toContain('review 1 at head-sh');
    expect(file).toContain('- [critical] src/app.ts:5 — Assignment in condition');
    expect(file).toMatch(/\+\s+if \(n === 0\) return;/);
    expect(file).toContain('- head-sh fix: compare');
    const summary = llm.calls.find((c) => c.system === SUMMARY_SYSTEM_PROMPT)!.messages[0]!.content as string;
    expect(summary).toContain('First pass.');
    expect(summary).toContain('1 commit since that review');
    expect(summary).toContain('Changes since the previous review');
    expect(summary).toMatch(/\+\s+if \(n === 0\) return;/);
    expect(gh.reviews[0]!.input.body).toContain('Review 2 of this pull request; 1 commit since head-sh');
    expect(result.warnings).toEqual([]);
  });

  it('reads overview docs at the base sha and puts them in the file prompt', async () => {
    const llm = fakeLlm();
    const gh = fakeGithub(DIFF, PR, { headFiles: { 'CLAUDE.md': 'One Node process, no external services.' } });
    await reviewPullRequest(makeDeps(db, { llm: llm.provider, github: gh.github }), { repoId: REPO_ID, prNumber: 42 });
    expect(gh.contentCalls).toContainEqual({ path: 'CLAUDE.md', ref: 'base-sha-1' });
    expect(llm.fileCalls()[0]!.messages[0]!.content).toContain('One Node process, no external services.');
  });

  it('carries no previous review on a first review and does not call compare', async () => {
    const llm = fakeLlm();
    const gh = fakeGithub();
    await reviewPullRequest(makeDeps(db, { llm: llm.provider, github: gh.github }), { repoId: REPO_ID, prNumber: 42 });
    expect(gh.compareCalls).toEqual([]);
    expect(llm.fileCalls()[0]!.messages[0]!.content).not.toContain('Previous RepoLens review');
    expect(gh.reviews[0]!.input.body).not.toContain('Review 1 of');
  });

  it('warns and still reviews when lineage fetches fail', async () => {
    db.insertReview({ repo_id: REPO_ID, pr_number: 42, head_sha: 'head-sha-0', status: 'done', summary: 's', verdict: 'comment', comments_json: '[]', posted: 1, error: null });
    const llm = fakeLlm();
    const gh = fakeGithub(DIFF, PR, {});
    gh.github.listPullCommits = async () => { throw new Error('commits down'); };
    const result = await reviewPullRequest(makeDeps(db, { llm: llm.provider, github: gh.github }), { repoId: REPO_ID, prNumber: 42 });
    expect(result.warnings.join('\n')).toContain('commits down');
    expect(llm.fileCalls()[0]!.messages[0]!.content).toContain('Delta unavailable');
  });

  it('includes relevant historical PR context in per-file review prompts', async () => {
    db.insertReview({ repo_id: REPO_ID, pr_number: 7, head_sha: 'old', status: 'done', summary: 'Old summary', verdict: 'comment',
      comments_json: JSON.stringify([{ path: 'src/app.ts', line: 3, severity: 'warning', title: 'Old issue', body: 'Check this.' }]), posted: 1, error: null });
    const llm = fakeLlm();
    const gh = fakeGithub(DIFF, PR, {
      historyCommits: [{ sha: 'abc1234', message: 'old change', htmlUrl: 'https://github.com/o/r/commit/abc1234' }],
      historyPulls: [{ number: 7, title: 'Old fix', body: 'Description', htmlUrl: 'https://github.com/o/r/pull/7', mergedAt: '2025-01-01', repository: 'o/r' }],
    });
    await reviewPullRequest(makeDeps(db, { llm: llm.provider, github: gh.github }), { repoId: REPO_ID, prNumber: 42, post: false });
    expect(llm.fileCalls()[0]!.messages[0]!.content).toContain('[#7 Old fix](https://github.com/o/r/pull/7)');
    expect(llm.fileCalls()[0]!.messages[0]!.content).toContain('[abc1234](https://github.com/o/r/commit/abc1234)');
    expect(llm.fileCalls()[0]!.messages[0]!.content).toContain('Old issue');
  });

  it('adds deduplicated historical context as optional Qwen batch input', async () => {
    const calls: CompleteRequest[] = [];
    const llm: LLMProvider = { name: 'openrouter', model: 'qwen/qwen3-coder', concurrency: 1, supportsBatchReview: true, async complete(req) {
      calls.push(req);
      return JSON.stringify({ reviewedPaths: ['src/app.ts', 'src/gone.ts'], findings: [], summary: 'Reviewed.', verdict: 'approve' });
    } };
    const gh = fakeGithub(DIFF, PR, {
      historyCommits: [{ sha: 'abc1234', message: 'old change', htmlUrl: 'https://github.com/o/r/commit/abc1234' }],
      historyPulls: [{ number: 7, title: 'Old fix', body: 'Description', htmlUrl: 'https://github.com/o/r/pull/7', mergedAt: '2025-01-01', repository: 'o/r' }],
    });
    await reviewPullRequest({ db, llm, retrieve: async () => [], github: gh.github }, { repoId: REPO_ID, prNumber: 42, post: false });
    expect(calls).toHaveLength(1);
    const content = calls[0]!.messages[0]!.content;
    expect(content).toContain('Relevant merged pull requests');
    expect(content.match(/Relevant merged pull requests/g)).toHaveLength(1);
  });

  it('merges rename history into the new-file prompt and ordinary summary', async () => {
    const renameDiff = [
      'diff --git a/src/old.ts b/src/new.ts', 'similarity index 80%', 'rename from src/old.ts', 'rename to src/new.ts',
      '--- a/src/old.ts', '+++ b/src/new.ts', '@@ -1,1 +1,2 @@', ' export const value = 1;', '+export const next = 2;', '',
    ].join('\n');
    db.insertReview({ repo_id: REPO_ID, pr_number: 7, head_sha: 'old', status: 'done', summary: 'Old summary', verdict: 'comment',
      comments_json: JSON.stringify([
        { path: 'src/old.ts', line: 1, severity: 'warning', title: 'Old path finding', body: 'Old detail.' },
        { path: 'src/new.ts', line: 2, severity: 'critical', title: 'New path finding', body: 'New detail.' },
      ]), posted: 1, error: null });
    const llm = fakeLlm();
    const gh = fakeGithub(renameDiff, PR, {
      historyCommitsByPath: {
        'src/old.ts': [{ sha: 'old-commit', message: 'old', htmlUrl: 'https://github.com/o/r/commit/old-commit' }],
        'src/new.ts': [{ sha: 'new-commit', message: 'new', htmlUrl: 'https://github.com/o/r/commit/new-commit' }],
      },
      historyPullsByCommit: {
        'old-commit': [{ number: 7, title: 'Old fix', body: 'Description', htmlUrl: 'https://github.com/o/r/pull/7', mergedAt: '2025-01-01', repository: 'o/r' }],
        'new-commit': [{ number: 7, title: 'Old fix', body: 'Description', htmlUrl: 'https://github.com/o/r/pull/7', mergedAt: '2025-01-01', repository: 'o/r' }],
      },
    });
    await reviewPullRequest(makeDeps(db, { llm: llm.provider, github: gh.github }), { repoId: REPO_ID, prNumber: 42, post: false });
    const file = llm.fileCalls()[0]!.messages[0]!.content;
    const summary = llm.calls.find((c) => c.system === SUMMARY_SYSTEM_PROMPT)!.messages[0]!.content;
    expect(file).toContain('Old path finding');
    expect(file).toContain('New path finding');
    expect(summary).toContain('Old path finding');
    expect(summary).toContain('New path finding');
  });

  it('keeps both paths\' historical findings in the Qwen batch context', async () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-a', '+b',
      'diff --git a/src/b.ts b/src/b.ts', '--- a/src/b.ts', '+++ b/src/b.ts', '@@ -1 +1 @@', '-a', '+b', '',
    ].join('\n');
    db.insertReview({ repo_id: REPO_ID, pr_number: 7, head_sha: 'old', status: 'done', summary: 'Old summary', verdict: 'comment',
      comments_json: JSON.stringify([
        { path: 'src/a.ts', line: 1, severity: 'warning', title: 'A finding', body: 'A detail.' },
        { path: 'src/b.ts', line: 1, severity: 'warning', title: 'B finding', body: 'B detail.' },
      ]), posted: 1, error: null });
    const calls: CompleteRequest[] = [];
    const llm: LLMProvider = { name: 'openrouter', model: 'qwen/qwen3-coder', concurrency: 1, supportsBatchReview: true, async complete(req) {
      calls.push(req);
      return JSON.stringify({ reviewedPaths: ['src/a.ts', 'src/b.ts'], findings: [], summary: 'Reviewed.', verdict: 'approve' });
    } };
    const gh = fakeGithub(diff, PR, {
      historyCommitsByPath: {
        'src/a.ts': [{ sha: 'a-commit', message: 'a' }],
        'src/b.ts': [{ sha: 'b-commit', message: 'b' }],
      },
      historyPullsByCommit: {
        'a-commit': [{ number: 7, title: 'Old fix', body: '', htmlUrl: 'https://github.com/o/r/pull/7', mergedAt: '2025-01-01', repository: 'o/r' }],
        'b-commit': [{ number: 7, title: 'Old fix', body: '', htmlUrl: 'https://github.com/o/r/pull/7', mergedAt: '2025-01-01', repository: 'o/r' }],
      },
    });
    await reviewPullRequest({ db, llm, retrieve: async () => [], github: gh.github }, { repoId: REPO_ID, prNumber: 42, post: false });
    expect(calls[0]!.messages[0]!.content).toContain('A finding');
    expect(calls[0]!.messages[0]!.content).toContain('B finding');
  });
});

describe('statusForFindings', () => {
  const critical: Finding = { path: 'a.ts', line: 1, severity: 'critical', title: 'Boom', body: 'b' };
  const warning: Finding = { path: 'a.ts', line: 2, severity: 'warning', title: 'Hmm', body: 'b' };
  const nit: Finding = { path: 'a.ts', line: 3, severity: 'nit', title: 'Tiny', body: 'b' };

  it('fails on criticals in the default mode', () => {
    expect(statusForFindings([critical, warning, warning, nit], 'critical')).toEqual({
      state: 'failure',
      description: '1 critical, 2 warnings, 1 nit',
    });
    expect(statusForFindings([warning, nit], 'critical')).toEqual({ state: 'success', description: '1 warning, 1 nit' });
    expect(statusForFindings([], 'critical')).toEqual({ state: 'success', description: 'No blocking findings' });
  });

  it('fails on warnings too when failOn is warning', () => {
    expect(statusForFindings([warning], 'warning')).toEqual({ state: 'failure', description: '1 warning' });
    expect(statusForFindings([critical], 'warning')).toEqual({ state: 'failure', description: '1 critical' });
    expect(statusForFindings([nit], 'warning')).toEqual({ state: 'success', description: '1 nit' });
  });

  it('never fails when failOn is never', () => {
    expect(statusForFindings([critical, warning], 'never')).toEqual({
      state: 'success',
      description: '1 critical, 1 warning',
    });
    expect(statusForFindings([], 'never')).toEqual({ state: 'success', description: 'No blocking findings' });
  });

  it('defaults to critical', () => {
    expect(statusForFindings([critical]).state).toBe('failure');
    expect(statusForFindings([warning]).state).toBe('success');
  });
});

describe('reviewPullRequest commit statuses', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
    db.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    db.setRepoStatus(REPO_ID, 'ready', { last_commit: PR.baseSha });
  });
  afterEach(() => db.close());

  const CONTEXT = 'repolens/review';
  const criticalFinding = JSON.stringify({
    findings: [{ line: 4, severity: 'critical', title: 'Assignment', body: 'Use `===`.' }],
  });
  const warningFinding = JSON.stringify({
    findings: [{ line: 4, severity: 'warning', title: 'Hmm', body: 'check' }],
  });

  function deps(gh: ReturnType<typeof fakeGithub>, llm: ReturnType<typeof fakeLlm>, overrides: Partial<ReviewDeps> = {}): ReviewDeps {
    return {
      db,
      llm: llm.provider,
      retrieve: retrieveOne,
      github: gh.github,
      statusContext: CONTEXT,
      ...overrides,
    };
  }

  it('posts pending then success for a clean review', async () => {
    const llm = fakeLlm();
    const gh = fakeGithub();
    const res = await reviewPullRequest(deps(gh, llm), { repoId: REPO_ID, prNumber: 42 });

    expect(gh.statuses.map((s) => s.input.state)).toEqual(['pending', 'success']);
    expect(gh.statuses[0]).toEqual({
      owner: 'o',
      repo: 'r',
      sha: 'head-sha-1',
      input: {
        state: 'pending',
        context: CONTEXT,
        description: 'RepoLens review in progress',
        targetUrl: PR.htmlUrl,
      },
    });
    expect(gh.statuses[1]!.input).toEqual({
      state: 'success',
      context: CONTEXT,
      description: 'No blocking findings',
      targetUrl: 'https://github.com/o/r/pull/42#pullrequestreview-7',
    });
    expect(res.status).toEqual({ state: 'success', description: 'No blocking findings' });
    expect(res.warnings).toEqual([]);
  });

  it('fails the check when a critical finding is present', async () => {
    const llm = fakeLlm({ file: criticalFinding });
    const gh = fakeGithub();
    const res = await reviewPullRequest(deps(gh, llm), { repoId: REPO_ID, prNumber: 42 });
    expect(gh.statuses.map((s) => s.input.state)).toEqual(['pending', 'failure']);
    expect(gh.statuses[1]!.input.description).toBe('1 critical');
    expect(res.status).toEqual({ state: 'failure', description: '1 critical' });
  });

  it('fails on a warning only when failOn is warning', async () => {
    const clean = fakeGithub();
    await reviewPullRequest(deps(clean, fakeLlm({ file: warningFinding })), { repoId: REPO_ID, prNumber: 42 });
    expect(clean.statuses[1]!.input.state).toBe('success');

    const strict = fakeGithub();
    const res = await reviewPullRequest(
      deps(strict, fakeLlm({ file: warningFinding }), { failOn: 'warning' }),
      { repoId: REPO_ID, prNumber: 42, force: true },
    );
    expect(strict.statuses[1]!.input).toMatchObject({ state: 'failure', description: '1 warning' });
    expect(res.status!.state).toBe('failure');
  });

  it('always succeeds when failOn is never', async () => {
    const llm = fakeLlm({ file: criticalFinding });
    const gh = fakeGithub();
    const res = await reviewPullRequest(deps(gh, llm, { failOn: 'never' }), { repoId: REPO_ID, prNumber: 42 });
    expect(gh.statuses.map((s) => s.input.state)).toEqual(['pending', 'success']);
    expect(res.status).toEqual({ state: 'success', description: '1 critical' });
  });

  it('reports a single final status for a cached, already posted review', async () => {
    const llm = fakeLlm({ file: criticalFinding });
    const gh = fakeGithub();
    const d = deps(gh, llm);
    await reviewPullRequest(d, { repoId: REPO_ID, prNumber: 42 });
    gh.statuses.length = 0;

    const second = await reviewPullRequest(d, { repoId: REPO_ID, prNumber: 42 });
    expect(gh.statuses).toHaveLength(1);
    expect(gh.statuses[0]!.input).toMatchObject({ state: 'failure', description: '1 critical', targetUrl: PR.htmlUrl });
    expect(second.status).toEqual({ state: 'failure', description: '1 critical' });
  });

  it('sets an error status and rethrows when the review blows up', async () => {
    const llm = fakeLlm();
    const gh = fakeGithub(DIFF, PR, { diffError: new Error('GitHub 500 GET diff') });
    await expect(reviewPullRequest(deps(gh, llm), { repoId: REPO_ID, prNumber: 42 })).rejects.toThrow('GitHub 500 GET diff');
    expect(gh.statuses.map((s) => s.input.state)).toEqual(['pending', 'error']);
    expect(gh.statuses[1]!.input.description).toBe('RepoLens review failed: GitHub 500 GET diff');
  });

  it('sets an error status and rethrows when posting a cached review blows up', async () => {
    const llm = fakeLlm({ file: criticalFinding });
    const gh = fakeGithub();
    const d = deps(gh, llm);
    // Store a review that was never posted, so the next run takes the cached posting path.
    await reviewPullRequest(d, { repoId: REPO_ID, prNumber: 42, post: false });
    gh.statuses.length = 0;

    // A malformed saved finding exercises an unexpected failure while rendering
    // the cached post; metadata now comes from the saved review, not the provider.
    db.raw.prepare('update reviews set comments_json=? where id=?').run('[null]', db.findReview(REPO_ID, 42, PR.headSha)!.id);
    await expect(reviewPullRequest(d, { repoId: REPO_ID, prNumber: 42 })).rejects.toThrow();
    expect(gh.statuses.map((s) => s.input.state)).toEqual(['pending', 'error']);
    expect(gh.statuses[1]!.input.description).toContain('RepoLens review failed:');
  });

  it('truncates a long error description to the 140 characters GitHub allows', async () => {
    const llm = fakeLlm();
    const gh = fakeGithub(DIFF, PR, { diffError: new Error('x'.repeat(300)) });
    await expect(reviewPullRequest(deps(gh, llm), { repoId: REPO_ID, prNumber: 42 })).rejects.toThrow(/x{300}/);
    const description = gh.statuses[1]!.input.description;
    expect(description).toHaveLength(140);
    expect(description.endsWith('…')).toBe(true);
  });

  it('completes the review with a warning when the status endpoint fails', async () => {
    const llm = fakeLlm({ file: criticalFinding });
    const gh = fakeGithub(DIFF, PR, { statusError: new Error('GitHub 403 POST statuses') });
    const res = await reviewPullRequest(deps(gh, llm), { repoId: REPO_ID, prNumber: 42 });

    expect(res.posted).toBe(true);
    expect(gh.reviews).toHaveLength(1);
    // One warning for the pending call, one for the final call.
    const statusWarnings = res.warnings.filter((w) => w.startsWith('posting commit status failed:'));
    expect(statusWarnings).toHaveLength(2);
    expect(statusWarnings[0]).toContain('GitHub 403 POST statuses');
    expect(res.status).toEqual({ state: 'failure', description: '1 critical' });
  });

  it('reports nothing when the status context is blank', async () => {
    const llm = fakeLlm({ file: criticalFinding });
    const gh = fakeGithub();
    const res = await reviewPullRequest(deps(gh, llm, { statusContext: '' }), { repoId: REPO_ID, prNumber: 42 });
    expect(gh.statuses).toEqual([]);
    expect(res.status).toBeUndefined();
  });

  it('falls back to the dashboard url when the PR has no html url', async () => {
    const llm = fakeLlm();
    const gh = fakeGithub(DIFF, { ...PR, htmlUrl: '' }, { createReviewError: () => new Error('nope') });
    await reviewPullRequest(deps(gh, llm, { publicUrl: 'https://repolens.example/' }), { repoId: REPO_ID, prNumber: 42 });
    expect(gh.statuses[0]!.input.targetUrl).toBe(`https://repolens.example/#/reviews/${REPO_ID}`);
  });
});

describe('isReviewablePath', () => {
  it('accepts source files', () => {
    for (const p of ['src/app.ts', 'lib/main.py', 'README.md', 'Dockerfile', 'scripts/build.ts', 'src/distance.ts']) {
      expect(isReviewablePath(p), p).toBe(true);
    }
  });

  it('rejects lockfiles, vendored trees, build output and binaries', () => {
    for (const p of [
      'package-lock.json',
      'a/b/yarn.lock',
      'pnpm-lock.yaml',
      'Cargo.lock',
      'go.sum',
      'node_modules/x/index.js',
      'web/node_modules/x/index.js',
      'vendor/lib.go',
      'dist/bundle.js',
      'build/out.js',
      'packages/web/dist/index.js',
      'static/app.min.js',
      'assets/logo.png',
      'fonts/a.woff2',
      'tests/__snapshots__/a.test.ts.snap',
      'dist/app.js.map',
      '',
    ]) {
      expect(isReviewablePath(p), p).toBe(false);
    }
  });
});

describe('buildReviewBody', () => {
  const findings: Finding[] = [
    { path: 'src/a.ts', line: 4, severity: 'critical', title: 'Bad | thing', body: 'x' },
    { path: 'src/b.ts', line: 9, severity: 'nit', title: 'Tiny', body: 'y' },
  ];

  it('renders the header, counts, table and footer', () => {
    const body = buildReviewBody({ summary: 'It changes things.', verdict: 'request_changes', findings, providerName: 'fake', model: 'm1' });
    expect(body.startsWith('## RepoLens review')).toBe(true);
    expect(body).toContain('It changes things.');
    expect(body).toContain('**Verdict:** request_changes · **Findings:** 2 (1 critical, 0 warnings, 1 nits)');
    expect(body).toContain('| Severity | File | Title |');
    expect(body).toContain('| critical | src/a.ts:4 | Bad \\| thing |');
    expect(body).toContain('| nit | src/b.ts:9 | Tiny |');
    expect(body.trimEnd().endsWith('<sub>Generated by RepoLens (fake/m1)</sub>')).toBe(true);
  });

  it('omits the table when there are no findings', () => {
    const body = buildReviewBody({ summary: 'Nothing to flag.', verdict: 'approve', findings: [], providerName: 'p', model: 'm' });
    expect(body).not.toContain('| Severity |');
    expect(body).toContain('**Findings:** 0 (0 critical, 0 warnings, 0 nits)');
  });
});

describe('default injectable helpers', () => {
  it('extracts deduped identifiers capped at 40', () => {
    expect(defaultIdentifiers('const foo = foo + bar; a1 x')).toEqual(['const', 'foo', 'bar']);
    const many = Array.from({ length: 100 }, (_, i) => `name${i}`).join(' ');
    expect(defaultIdentifiers(many)).toHaveLength(40);
  });

  it('formats chunks as fenced sections', () => {
    expect(defaultFormatContext([CHUNK])).toBe('### src/x.ts:1-3\n```\nexport function x() { return 1; }\n```');
    expect(defaultFormatContext([])).toBe('');
  });
});
