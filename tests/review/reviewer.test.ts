import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type Db } from '../../src/db.js';
import type { CompleteRequest, LLMProvider } from '../../src/llm/types.js';
import type { RetrieveFn, RetrievedChunk } from '../../src/search/types.js';
import type {
  PullRequest,
  CreateReviewInput,
  ExistingReviewComment,
  CommitStatusInput,
} from '../../src/review/github.js';
import { FILE_REVIEW_SYSTEM_PROMPT, SUMMARY_SYSTEM_PROMPT } from '../../src/review/prompts.js';
import {
  reviewPullRequest,
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
  const github: ReviewDeps['github'] = {
    async getPull() {
      return pr;
    },
    async getPullDiff() {
      if (opts.diffError) throw opts.diffError;
      return diff;
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
  return { reviews, listCalls, statuses, github };
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

  it('keeps findings on changed lines and drops the rest', async () => {
    const llm = fakeLlm({
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
    const res = await reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, {
      repoId: REPO_ID,
      prNumber: 42,
    });

    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]).toEqual({
      path: 'src/app.ts',
      line: 4,
      severity: 'critical',
      title: 'Assignment in condition',
      body: 'Use `===`.',
    });
    expect(res.verdict).toBe('request_changes');
    expect(res.warnings).toEqual([]);
  });

  it('reviews only reviewable files and reports the rest as skipped', async () => {
    const llm = fakeLlm();
    const gh = fakeGithub();
    const res = await reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, {
      repoId: REPO_ID,
      prNumber: 42,
    });
    expect(llm.fileCalls()).toHaveLength(1);
    expect(llm.fileCalls()[0]!.messages[0]!.content).toContain('src/app.ts');
    expect(res.skippedFiles.sort()).toEqual(['assets/logo.png', 'package-lock.json', 'src/gone.ts']);
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

  it('records a warning and no findings when a file review returns garbage', async () => {
    const llm = fakeLlm({ file: 'I am not JSON at all.' });
    const gh = fakeGithub();
    const res = await reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, {
      repoId: REPO_ID,
      prNumber: 42,
    });
    expect(res.findings).toEqual([]);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain('src/app.ts');
    expect(res.summary).toBeTruthy();
    expect(gh.reviews).toHaveLength(1);
  });

  it('falls back to a generated summary when the summary call fails', async () => {
    const llm = fakeLlm({
      file: JSON.stringify({ findings: [{ line: 4, severity: 'warning', title: 'Hmm', body: 'check' }] }),
      summary: 'not json',
    });
    const gh = fakeGithub();
    const res = await reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, {
      repoId: REPO_ID,
      prNumber: 42,
    });
    expect(res.summary).toBe('Reviewed 1 files, 1 findings.');
    expect(res.verdict).toBe('comment');
    expect(res.warnings.some((w) => w.startsWith('summary:'))).toBe(true);
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
      expect(req.excludePath).toBe('src/app.ts');
      expect(req.limit).toBe(8);
      expect(req.repoIds).toEqual([REPO_ID]);
      return [];
    };
    const llm = fakeLlm();
    await reviewPullRequest({ db, llm: llm.provider, retrieve, github: fakeGithub().github }, { repoId: REPO_ID, prNumber: 42 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('src/app.ts');
    expect(seen[0]).toContain('run');
    expect(seen[0]).toContain('number');
  });

  it('honours maxFiles by skipping the overflow', async () => {
    const llm = fakeLlm();
    const gh = fakeGithub();
    const res = await reviewPullRequest(
      { db, llm: llm.provider, retrieve: retrieveOne, github: gh.github, maxFiles: 0 },
      { repoId: REPO_ID, prNumber: 42 },
    );
    expect(llm.fileCalls()).toHaveLength(0);
    expect(res.skippedFiles).toContain('src/app.ts');
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
