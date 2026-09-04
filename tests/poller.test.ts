import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { JobQueue } from '../src/jobs.js';
import type { AppDeps } from '../src/app.js';
import type { GitHubClient, PullRequest } from '../src/review/github.js';
import { pollOnce } from '../src/poller.js';
import { UsageTracker } from '../src/usage/tracker.js';

function pr(number: number, headSha: string, draft = false): PullRequest {
  return { number, title: 't', body: '', headSha, baseSha: 'b', headRef: 'f', baseRef: 'main', author: 'a', htmlUrl: '', draft, updatedAt: null };
}

const fake: AppDeps['llm'] = { name: 'fake', model: 'x', concurrency: 1, complete: async () => '{"findings":[]}' };

function makeDeps(github: Partial<GitHubClient>, env: Record<string, string> = {}): AppDeps {
  const config = loadConfig({ LLM_PROVIDER: 'claude-cli', REPOLENS_DATA_DIR: mkdtempSync(join(tmpdir(), 'repolens-poll-')), REVIEW_SETTLE_SECONDS: '0', ...env });
  const db = openDb(':memory:');
  return {
    config,
    db,
    llm: fake,
    chatLlm: fake,
    embeddings: null,
    retrieve: async () => [],
    github: github as GitHubClient,
    jobs: new JobQueue(db),
    usage: new UsageTracker({ db, pricing: null }),
  };
}

describe('pollOnce', () => {
  it('reindexes a moved branch and reviews unreviewed open pull requests', async () => {
    const deps = makeDeps({
      getBranchHead: async () => 'newsha',
      listOpenPulls: async () => [pr(1, 'h1'), pr(2, 'h2', true)],
    });
    deps.db.upsertRepo({ id: 'github:o/n', remote: 'https://github.com/o/n.git', owner: 'o', name: 'n', branch: 'main' });
    deps.db.setRepoStatus('github:o/n', 'ready', { last_commit: 'oldsha' });
    deps.db.insertReview({ repo_id: 'github:o/n', pr_number: 3, head_sha: 'h3', status: 'done', summary: null, verdict: null, comments_json: '[]', posted: 1, error: null });

    const out = await pollOnce(deps);
    expect(out.indexed).toEqual(['github:o/n']);
    expect(out.reviewed).toEqual([{ repository: 'github:o/n', prNumber: 1 }]);
    expect(out.errors).toEqual([]);
    const jobs = deps.db.listJobs();
    expect(jobs.map((j) => j.kind).sort()).toEqual(['index', 'review']);
    await deps.jobs.idle();
  });

  it('skips repos whose branch has not moved and PRs already reviewed at that sha', async () => {
    const deps = makeDeps({
      getBranchHead: async () => 'same',
      listOpenPulls: async () => [pr(7, 'h7')],
    });
    deps.db.upsertRepo({ id: 'github:o/n', remote: 'u', owner: 'o', name: 'n', branch: 'main' });
    deps.db.setRepoStatus('github:o/n', 'ready', { last_commit: 'same' });
    deps.db.insertReview({ repo_id: 'github:o/n', pr_number: 7, head_sha: 'h7', status: 'done', summary: null, verdict: null, comments_json: '[]', posted: 1, error: null });
    const out = await pollOnce(deps);
    expect(out.indexed).toEqual([]);
    expect(out.reviewed).toEqual([]);
    expect(deps.db.listJobs()).toHaveLength(0);
  });

  it('ignores local repositories and records GitHub errors per repo', async () => {
    const deps = makeDeps({
      getBranchHead: async () => {
        throw new Error('GitHub 403');
      },
      listOpenPulls: async () => [],
    });
    deps.db.upsertRepo({ id: 'local:x', remote: '/x', owner: 'local', name: 'x', branch: 'main' });
    deps.db.upsertRepo({ id: 'github:o/n', remote: 'u', owner: 'o', name: 'n', branch: 'main' });
    deps.db.setRepoStatus('github:o/n', 'ready', { last_commit: 'a' });
    const out = await pollOnce(deps);
    expect(out.errors).toEqual(['github:o/n: GitHub 403']);
    expect(deps.db.listJobs()).toHaveLength(0);
  });
});

describe('pollOnce with a settle window', () => {
  it('waits for the window before queuing and does not restart it on the next poll', async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps({ getBranchHead: async () => 'same', listOpenPulls: async () => [pr(1, 'h1')] }, { REVIEW_SETTLE_SECONDS: '300' });
      deps.db.upsertRepo({ id: 'github:o/n', remote: 'u', owner: 'o', name: 'n', branch: 'main' });
      deps.db.setRepoStatus('github:o/n', 'ready', { last_commit: 'same' });
      expect((await pollOnce(deps)).reviewed).toEqual([{ repository: 'github:o/n', prNumber: 1 }]);
      expect(deps.db.listJobs()).toEqual([]);
      vi.advanceTimersByTime(200_000);
      expect((await pollOnce(deps)).reviewed).toEqual([]);
      vi.advanceTimersByTime(101_000);
      expect(deps.db.listJobs().map((j) => [j.kind, j.pr_number])).toEqual([['review', 1]]);
    } finally {
      vi.useRealTimers();
    }
  });
});
