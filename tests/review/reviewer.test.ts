import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type Db } from '../../src/db.js';
import type { CompleteRequest, LLMProvider } from '../../src/llm/types.js';
import type { RetrieveFn, RetrievedChunk } from '../../src/search/types.js';
import type { PullRequest, CreateReviewInput } from '../../src/review/github.js';
import { FILE_REVIEW_SYSTEM_PROMPT, SUMMARY_SYSTEM_PROMPT } from '../../src/review/prompts.js';
import {
  reviewPullRequest,
  isReviewablePath,
  buildReviewBody,
  defaultIdentifiers,
  defaultFormatContext,
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

function fakeGithub(diff = DIFF, pr: PullRequest = PR) {
  const reviews: Array<{ owner: string; repo: string; number: number; input: CreateReviewInput }> = [];
  const github: ReviewDeps['github'] = {
    async getPull() {
      return pr;
    },
    async getPullDiff() {
      return diff;
    },
    async createReview(owner: string, repo: string, number: number, input: CreateReviewInput) {
      reviews.push({ owner, repo, number, input });
      return { id: 7, htmlUrl: 'https://github.com/o/r/pull/42#pullrequestreview-7' };
    },
  };
  return { reviews, github };
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

  it('throws for an unknown repo', async () => {
    await expect(reviewPullRequest(makeDeps(db), { repoId: 'github:nope/nope', prNumber: 1 })).rejects.toThrow(/Unknown repo/);
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
