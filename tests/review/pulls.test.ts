import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db.js';
import { loadConfig } from '../../src/config.js';
import { JobQueue } from '../../src/jobs.js';
import type { AppDeps } from '../../src/app.js';
import type { GitHubClient, PullRequest } from '../../src/review/github.js';
import { listPullStatuses, reviewPulls, type PullStatus } from '../../src/review/pulls.js';

const REPO_ID = 'github:o/n';

function pr(number: number, headSha: string, extra: Partial<PullRequest> = {}): PullRequest {
  return {
    number,
    title: `PR ${number}`,
    body: '',
    headSha,
    baseSha: 'base',
    headRef: 'feature',
    baseRef: 'main',
    author: 'octocat',
    htmlUrl: `https://github.com/o/n/pull/${number}`,
    draft: false,
    updatedAt: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

/** #1 draft, #2 reviewed at its head sha, #3 new, #4 has a queued review job. */
const PULLS = [pr(1, 'h1', { draft: true }), pr(2, 'h2'), pr(3, 'h3'), pr(4, 'h4')];

function makeDeps(pulls: PullRequest[] = PULLS): AppDeps {
  const config = loadConfig({ LLM_PROVIDER: 'claude-cli', REPOLENS_DATA_DIR: mkdtempSync(join(tmpdir(), 'repolens-pulls-')) });
  const db = openDb(':memory:');
  const github = {
    listOpenPulls: async () => pulls,
    getPull: async (_o: string, _r: string, n: number) => pulls.find((p) => p.number === n)!,
    getPullDiff: async () => '',
    listReviewComments: async () => [],
    createReview: async () => ({ id: 1, htmlUrl: 'https://github.com/o/n/pull/1#review-1' }),
  } as unknown as GitHubClient;
  const deps: AppDeps = {
    config,
    db,
    llm: { name: 'fake', model: 'x', concurrency: 1, complete: async () => '{"summary":"ok","verdict":"comment","findings":[]}' },
    embeddings: null,
    retrieve: async () => [],
    github,
    jobs: new JobQueue(db),
  };
  db.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/n.git', owner: 'o', name: 'n', branch: 'main' });
  return deps;
}

function seedReview(deps: AppDeps) {
  return deps.db.insertReview({
    repo_id: REPO_ID,
    pr_number: 2,
    head_sha: 'h2',
    status: 'done',
    summary: 'looks fine',
    verdict: 'comment',
    comments_json: JSON.stringify([
      { path: 'a.ts', line: 1, severity: 'nit', title: 't1', body: 'b1' },
      { path: 'b.ts', line: 2, severity: 'warning', title: 't2', body: 'b2' },
    ]),
    posted: 1,
    error: null,
  });
}

function byNumber(list: PullStatus[]): Map<number, PullStatus> {
  return new Map(list.map((p) => [p.number, p]));
}

describe('listPullStatuses', () => {
  it('reports draft, reviewed, new and pending pull requests', async () => {
    const deps = makeDeps();
    const review = seedReview(deps);
    const pending = deps.db.createJob('review', REPO_ID, 4);

    const statuses = await listPullStatuses(deps, REPO_ID);
    expect(statuses.map((s) => s.number)).toEqual([1, 2, 3, 4]);
    const by = byNumber(statuses);

    expect(by.get(1)).toMatchObject({ draft: true, title: 'PR 1', author: 'octocat', headSha: 'h1', baseRef: 'main', updatedAt: '2026-01-01T00:00:00Z' });
    expect(by.get(1)!.review).toEqual({ status: 'none' });
    expect(by.get(2)!.review).toEqual({ status: 'reviewed', reviewId: review.id, posted: true, verdict: 'comment', findings: 2 });
    expect(by.get(3)!.review).toEqual({ status: 'none' });
    expect(by.get(4)!.review).toEqual({ status: 'pending', jobId: pending.id });
  });

  it('reports the error of the last failed review job when nothing was stored', async () => {
    const deps = makeDeps();
    const job = deps.db.createJob('review', REPO_ID, 3);
    deps.db.updateJob(job.id, { status: 'error', error: 'GitHub 502' });
    const by = byNumber(await listPullStatuses(deps, REPO_ID));
    expect(by.get(3)!.review).toEqual({ status: 'error', jobId: job.id, error: 'GitHub 502' });
    // a review job for another repo must not leak into this one
    expect(by.get(2)!.review.status).toBe('none');
  });

  it('rejects unknown and local repositories', async () => {
    const deps = makeDeps();
    await expect(listPullStatuses(deps, 'github:no/pe')).rejects.toThrow(/Unknown repository/);
    deps.db.upsertRepo({ id: 'local:x', remote: '/x', owner: 'local', name: 'x', branch: 'main' });
    await expect(listPullStatuses(deps, 'local:x')).rejects.toThrow(/GitHub repository/);
  });
});

describe('reviewPulls', () => {
  it('reviews only the unreviewed non-draft pull requests', async () => {
    const deps = makeDeps();
    seedReview(deps);
    deps.db.createJob('review', REPO_ID, 4);
    const pulls = await listPullStatuses(deps, REPO_ID);

    const out = reviewPulls(deps, REPO_ID, { pulls, post: false });
    expect(out.jobs.map((j) => j.prNumber)).toEqual([3]);
    expect(typeof out.jobs[0].jobId).toBe('number');
    expect(out.skipped).toEqual([
      { prNumber: 1, reason: 'draft' },
      { prNumber: 2, reason: 'already reviewed' },
      { prNumber: 4, reason: 'already queued' },
    ]);
    await deps.jobs.idle();
  });

  it('re-reviews already reviewed pull requests with force, but never the pending one', async () => {
    const deps = makeDeps();
    seedReview(deps);
    deps.db.createJob('review', REPO_ID, 4);
    const pulls = await listPullStatuses(deps, REPO_ID);

    const out = reviewPulls(deps, REPO_ID, { pulls, post: false, force: true });
    expect(out.jobs.map((j) => j.prNumber)).toEqual([2, 3]);
    expect(out.skipped).toEqual([
      { prNumber: 1, reason: 'draft' },
      { prNumber: 4, reason: 'already queued' },
    ]);
    await deps.jobs.idle();
  });

  it('skips an explicitly requested pull request that is already queued', async () => {
    const deps = makeDeps();
    const pending = deps.db.createJob('review', REPO_ID, 4);
    const pulls = await listPullStatuses(deps, REPO_ID);

    const out = reviewPulls(deps, REPO_ID, { pulls, prNumbers: [4], post: false });
    expect(out.jobs).toEqual([]);
    expect(out.skipped).toEqual([{ prNumber: 4, reason: 'already queued' }]);
    expect(deps.db.getJob(pending.id)?.status).toBe('queued');
  });

  it('reviews explicitly requested drafts and re-reviews with force', async () => {
    const deps = makeDeps();
    seedReview(deps);
    const pulls = await listPullStatuses(deps, REPO_ID);

    const skip = reviewPulls(deps, REPO_ID, { pulls, prNumbers: [1, 2], post: false });
    expect(skip.jobs.map((j) => j.prNumber)).toEqual([1]);
    expect(skip.skipped).toEqual([{ prNumber: 2, reason: 'already reviewed' }]);

    const forced = reviewPulls(deps, REPO_ID, { pulls, prNumbers: [2], post: false, force: true });
    expect(forced.jobs.map((j) => j.prNumber)).toEqual([2]);
    expect(forced.skipped).toEqual([]);
    await deps.jobs.idle();
  });

  it('records the pull request number on the job it enqueues', async () => {
    const deps = makeDeps();
    const pulls = await listPullStatuses(deps, REPO_ID);
    const out = reviewPulls(deps, REPO_ID, { pulls, prNumbers: [3], post: false });
    expect(deps.db.getJob(out.jobs[0].jobId)?.pr_number).toBe(3);
    expect(deps.db.listReviewJobsForRepo(REPO_ID).map((j) => j.pr_number)).toEqual([3]);
    await deps.jobs.idle();
  });
});
