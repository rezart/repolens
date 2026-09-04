# Review Lineage Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give each PR review the previous review of the same PR, the diff since that review, the PR's commit list, and an architecture overview from the base branch, so a re-review builds on what came before instead of starting cold.

**Architecture:** A new pure module `src/review/lineage.ts` assembles the lineage from injected fetchers (db row, GitHub compare diff, PR commits, overview docs). `reviewer.ts` calls it once per review and threads the result into `buildFileReviewMessage` and `buildSummaryMessage`, which render new prompt sections. Every fetch degrades to a warning. Findings are never carried forward mechanically; the model decides.

**Tech Stack:** TypeScript (tsx, no build), vitest, better-sqlite3, Hono. Design: `docs/plans/2026-09-04-review-lineage-design.md`.

**Conventions:** Tests never touch the network. Run one file with `npx vitest run <path>`. Typecheck with `npm run typecheck`. Commit messages end with `Claude-Session: https://claude.ai/code/session_01N6MJwSqk1k5bN3pdrC37MR`. Work in `/Users/rez/workspace/repolens-review-lineage` on branch `feat/review-lineage`.

---

### Task 1: GitHub client — `listPullCommits` and `compareDiff`

**Files:**
- Modify: `src/review/github.ts` (after `getFileContent`, around line 176)
- Test: `tests/review/github.test.ts`

**Step 1: Write the failing tests** (append to `tests/review/github.test.ts`)

```ts
describe('GitHubClient.listPullCommits', () => {
  it('returns sha and message subject, oldest first, from the pull commits endpoint', async () => {
    const { f, gh } = client([
      jsonResponse([
        { sha: 'aaaa1111', commit: { message: 'feat: first\n\nbody' } },
        { sha: 'bbbb2222', commit: { message: 'fix: second' } },
      ]),
    ]);
    const commits = await gh.listPullCommits('o', 'r', 42);
    expect(f.calls[0].url).toBe('https://api.github.com/repos/o/r/pulls/42/commits?per_page=100');
    expect(commits).toEqual([
      { sha: 'aaaa1111', message: 'feat: first' },
      { sha: 'bbbb2222', message: 'fix: second' },
    ]);
  });
});

describe('GitHubClient.compareDiff', () => {
  it('requests the diff media type for base...head', async () => {
    const { f, gh } = client([textResponse('diff --git a/x b/x\n')]);
    const diff = await gh.compareDiff('o', 'r', 'oldsha', 'newsha');
    expect(f.calls[0].url).toBe('https://api.github.com/repos/o/r/compare/oldsha...newsha');
    expect(f.calls[0].headers.Accept).toBe('application/vnd.github.v3.diff');
    expect(diff).toBe('diff --git a/x b/x\n');
  });

  it('returns null when the compare cannot be produced (404 or 422)', async () => {
    const { gh } = client([textResponse('gone', 404), textResponse('bad', 422)]);
    expect(await gh.compareDiff('o', 'r', 'a', 'b')).toBeNull();
    expect(await gh.compareDiff('o', 'r', 'a', 'b')).toBeNull();
  });

  it('still throws on other errors', async () => {
    const { gh } = client([textResponse('nope', 500)]);
    await expect(gh.compareDiff('o', 'r', 'a', 'b')).rejects.toThrow('GitHub 500');
  });
});
```

Check the exact base URL used by other tests in the file (`https://api.github.com` unless `baseUrl` is passed); match it.

**Step 2: Run to verify failure**

Run: `npx vitest run tests/review/github.test.ts`
Expected: FAIL, `gh.listPullCommits is not a function`.

**Step 3: Implement** (in `src/review/github.ts`, after `getFileContent`)

```ts
export interface PullCommit {
  sha: string;
  /** First line of the commit message. */
  message: string;
}

  /** Commits on the pull request, oldest first (first page of 100). */
  async listPullCommits(owner: string, repo: string, number: number): Promise<PullCommit[]> {
    const raw = await this.json<Array<{ sha?: string; commit?: { message?: string } }>>(
      `/repos/${owner}/${repo}/pulls/${number}/commits?per_page=100`,
    );
    return (raw ?? []).map((c) => ({ sha: c.sha ?? '', message: (c.commit?.message ?? '').split('\n')[0] }));
  }

  /**
   * Unified diff from `base` to `head`, or null when GitHub cannot compare them
   * (a force push removed the old head, or the shas are unrelated).
   */
  async compareDiff(owner: string, repo: string, base: string, head: string): Promise<string | null> {
    const res = await this.request(`/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`, {
      accept: 'application/vnd.github.v3.diff',
      allow: [404, 422],
    });
    if (res.status === 404 || res.status === 422) return null;
    return res.text;
  }
```

Put the `PullCommit` interface next to the other exported interfaces at the top of the file.

**Step 4: Run to verify pass**

Run: `npx vitest run tests/review/github.test.ts` → PASS. Run `npm run typecheck` → clean.

**Step 5: Commit**

```bash
git add src/review/github.ts tests/review/github.test.ts
git commit -m "feat(github): list pull commits and compare diffs

Claude-Session: https://claude.ai/code/session_01N6MJwSqk1k5bN3pdrC37MR"
```

---

### Task 2: Db — `findLatestReview` and `countPrReviews`

**Files:**
- Modify: `src/db.ts` (reviews section, after `findReview` around line 445)
- Test: `tests/db.test.ts`

**Step 1: Write the failing test** (add inside the existing `describe` next to `'pages reviews newest first'`)

```ts
  it('finds the latest done review of a pull request across head shas', () => {
    seed(db);
    const row = (head: string, status: 'done' | 'error') => db.insertReview({
      repo_id: 'github:o/n', pr_number: 7, head_sha: head, status, summary: null, verdict: null,
      comments_json: '[]', posted: 0, error: null,
    });
    expect(db.findLatestReview('github:o/n', 7)).toBeUndefined();
    row('h1', 'done');
    const second = row('h2', 'done');
    row('h3', 'error');
    expect(db.findLatestReview('github:o/n', 7)?.id).toBe(second.id);
    expect(db.findLatestReview('github:o/n', 8)).toBeUndefined();
    expect(db.countPrReviews('github:o/n', 7)).toBe(2);
  });
```

**Step 2: Run** `npx vitest run tests/db.test.ts` → FAIL, `findLatestReview is not a function`.

**Step 3: Implement**

```ts
  /** Newest finished review of a pull request, whatever head it reviewed. */
  findLatestReview(repoId: string, prNumber: number): ReviewRow | undefined {
    return this.raw
      .prepare(`select * from reviews where repo_id=? and pr_number=? and status='done' order by id desc limit 1`)
      .get(repoId, prNumber) as ReviewRow | undefined;
  }

  countPrReviews(repoId: string, prNumber: number): number {
    const row = this.raw
      .prepare(`select count(*) as n from reviews where repo_id=? and pr_number=? and status='done'`)
      .get(repoId, prNumber) as { n: number };
    return row.n;
  }
```

**Step 4: Run** `npx vitest run tests/db.test.ts` → PASS.

**Step 5: Commit**

```bash
git add src/db.ts tests/db.test.ts
git commit -m "feat(db): find the latest review of a pull request

Claude-Session: https://claude.ai/code/session_01N6MJwSqk1k5bN3pdrC37MR"
```

---

### Task 3: `src/review/lineage.ts` — assemble lineage

**Files:**
- Create: `src/review/lineage.ts`
- Test: `tests/review/lineage.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { buildLineage, deltaForFile, type Lineage, type LineageSources } from '../../src/review/lineage.js';
import type { ReviewRow } from '../../src/db.js';

const DELTA = [
  'diff --git a/src/app.ts b/src/app.ts',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,3 @@',
  ' a',
  '-b',
  '+c',
  ' d',
  '',
].join('\n');

const PREV: ReviewRow = {
  id: 3, repo_id: 'github:o/r', pr_number: 42, head_sha: 'old-sha', status: 'done',
  summary: 'Earlier summary.', verdict: 'request_changes',
  comments_json: JSON.stringify([{ path: 'src/app.ts', line: 2, severity: 'critical', title: 'Bad thing', body: 'Fix it.' }]),
  posted: 1, error: null, created_at: '2026-09-04T00:00:00Z',
};

function sources(over: Partial<LineageSources> = {}): LineageSources {
  return {
    previousReview: () => undefined,
    reviewCount: () => 0,
    compareDiff: async () => DELTA,
    listCommits: async () => [{ sha: 'aaaa1111', message: 'feat: first' }],
    readFile: async () => null,
    ...over,
  };
}

describe('buildLineage', () => {
  it('is empty apart from commits on a first review', async () => {
    const l = await buildLineage(sources(), { baseSha: 'base', headSha: 'head' });
    expect(l.previous).toBeUndefined();
    expect(l.reviewNumber).toBe(1);
    expect(l.commits).toEqual([{ sha: 'aaaa1111', message: 'feat: first' }]);
    expect(l.overview).toBe('');
    expect(l.warnings).toEqual([]);
  });

  it('loads the previous review, its findings and the delta since its head', async () => {
    const compared: string[] = [];
    const l = await buildLineage(
      sources({ previousReview: () => PREV, reviewCount: () => 1, compareDiff: async (b, h) => { compared.push(`${b}..${h}`); return DELTA; } }),
      { baseSha: 'base', headSha: 'head' },
    );
    expect(compared).toEqual(['old-sha..head']);
    expect(l.reviewNumber).toBe(2);
    expect(l.previous?.headSha).toBe('old-sha');
    expect(l.previous?.verdict).toBe('request_changes');
    expect(l.previous?.findings).toHaveLength(1);
    expect(l.previous?.delta).toHaveLength(1);
    expect(l.previous?.commitsSince).toBe(0); // no commit with sha 'old-sha' in the list → unknown, counts commits after it as 0
  });

  it('counts commits after the previously reviewed head', async () => {
    const l = await buildLineage(
      sources({
        previousReview: () => PREV,
        reviewCount: () => 1,
        listCommits: async () => [{ sha: 'old-sha', message: 'a' }, { sha: 'x', message: 'b' }, { sha: 'head', message: 'c' }],
      }),
      { baseSha: 'base', headSha: 'head' },
    );
    expect(l.previous?.commitsSince).toBe(2);
  });

  it('reports the delta as unavailable when compare returns null', async () => {
    const l = await buildLineage(sources({ previousReview: () => PREV, reviewCount: () => 1, compareDiff: async () => null }), { baseSha: 'base', headSha: 'head' });
    expect(l.previous?.delta).toBeNull();
    expect(l.warnings).toEqual([]);
  });

  it('turns fetch failures into warnings and keeps going', async () => {
    const l = await buildLineage(
      sources({
        previousReview: () => PREV,
        reviewCount: () => 1,
        compareDiff: async () => { throw new Error('boom'); },
        listCommits: async () => { throw new Error('nope'); },
        readFile: async () => { throw new Error('bad'); },
      }),
      { baseSha: 'base', headSha: 'head' },
    );
    expect(l.previous?.delta).toBeNull();
    expect(l.commits).toEqual([]);
    expect(l.overview).toBe('');
    expect(l.warnings.join('\n')).toMatch(/boom/);
    expect(l.warnings.join('\n')).toMatch(/nope/);
    expect(l.warnings.join('\n')).toMatch(/bad/);
  });

  it('tolerates unparseable stored findings', async () => {
    const l = await buildLineage(sources({ previousReview: () => ({ ...PREV, comments_json: 'nope' }), reviewCount: () => 1 }), { baseSha: 'base', headSha: 'head' });
    expect(l.previous?.findings).toEqual([]);
  });

  it('reads overview docs from the base sha in order, skipping missing ones, under a budget', async () => {
    const reads: string[] = [];
    const docs: Record<string, string> = { 'ARCHITECTURE.md': 'arch', 'README.md': 'readme' };
    const l = await buildLineage(
      sources({ readFile: async (path, ref) => { reads.push(`${path}@${ref}`); return docs[path] ?? null; } }),
      { baseSha: 'base', headSha: 'head' },
    );
    expect(reads).toEqual(['CLAUDE.md@base', 'ARCHITECTURE.md@base', 'docs/ARCHITECTURE.md@base', 'README.md@base']);
    expect(l.overview).toBe('### ARCHITECTURE.md\narch\n\n### README.md\nreadme');
  });

  it('stops adding docs once the overview budget is spent', async () => {
    const big = 'x'.repeat(11_000);
    const l = await buildLineage(sources({ readFile: async (path) => (path === 'CLAUDE.md' ? big : 'more') }), { baseSha: 'base', headSha: 'head' });
    expect(l.overview).toContain(big);
    expect(l.overview).not.toContain('more');
  });
});

describe('deltaForFile', () => {
  const previous: NonNullable<Lineage['previous']> = {
    headSha: 'old-sha', verdict: 'comment', summary: '', findings: [], commitsSince: 1,
    delta: [],
  };

  it('returns the hunk text of the file when the delta touched it', async () => {
    const l = await buildLineage(sources({ previousReview: () => PREV, reviewCount: () => 1 }), { baseSha: 'base', headSha: 'head' });
    expect(deltaForFile(l.previous!, 'src/app.ts')).toContain('+c');
  });

  it('says the file is unchanged when the delta did not touch it', () => {
    expect(deltaForFile(previous, 'src/other.ts')).toMatch(/unchanged since/i);
  });

  it('says the delta is unavailable when compare failed', () => {
    expect(deltaForFile({ ...previous, delta: null }, 'src/app.ts')).toMatch(/unavailable/i);
  });
});
```

**Step 2: Run** `npx vitest run tests/review/lineage.test.ts` → FAIL, cannot resolve module.

**Step 3: Implement `src/review/lineage.ts`**

```ts
import type { ReviewRow } from '../db.js';
import type { Finding } from './reviewer.js';
import type { PullCommit } from './github.js';
import { parseUnifiedDiff, hunkText, type DiffFile } from './diff.js';

/** Overview docs read from the base sha, first match wins, in this order. */
export const OVERVIEW_PATHS = ['CLAUDE.md', 'ARCHITECTURE.md', 'docs/ARCHITECTURE.md', 'README.md'];
export const OVERVIEW_CHARS_MAX = 12_000;

export interface PreviousReview {
  headSha: string;
  verdict: string;
  summary: string;
  findings: Finding[];
  /** Commits in the PR after the previously reviewed head (0 when the head is not in the list). */
  commitsSince: number;
  /** Parsed diff from the previous head to the current one; null when GitHub could not compare them. */
  delta: DiffFile[] | null;
}

export interface Lineage {
  /** 1 for the first review of this PR. */
  reviewNumber: number;
  commits: PullCommit[];
  previous?: PreviousReview;
  /** Concatenated overview docs, '' when none exist. */
  overview: string;
  warnings: string[];
}

/** Everything buildLineage needs, injected so tests use fakes. */
export interface LineageSources {
  previousReview: () => ReviewRow | undefined;
  reviewCount: () => number;
  compareDiff: (base: string, head: string) => Promise<string | null>;
  listCommits: () => Promise<PullCommit[]>;
  readFile: (path: string, ref: string) => Promise<string | null>;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function buildLineage(src: LineageSources, refs: { baseSha: string; headSha: string }): Promise<Lineage> {
  const warnings: string[] = [];

  let commits: PullCommit[] = [];
  try {
    commits = await src.listCommits();
  } catch (err) {
    warnings.push(`lineage: listing PR commits failed: ${errMessage(err)}`);
  }

  let overview = '';
  const parts: string[] = [];
  let used = 0;
  for (const path of OVERVIEW_PATHS) {
    if (used >= OVERVIEW_CHARS_MAX) break;
    try {
      const text = await src.readFile(path, refs.baseSha);
      if (text === null || !text.trim()) continue;
      const room = OVERVIEW_CHARS_MAX - used;
      const body = text.length > room ? `${text.slice(0, room)}\n... (truncated)` : text;
      parts.push(`### ${path}\n${body}`);
      used += text.length;
    } catch (err) {
      warnings.push(`lineage: reading ${path} at base failed: ${errMessage(err)}`);
    }
  }
  overview = parts.join('\n\n');

  const row = src.previousReview();
  let previous: PreviousReview | undefined;
  if (row) {
    let findings: Finding[] = [];
    try {
      const parsed = JSON.parse(row.comments_json) as unknown;
      if (Array.isArray(parsed)) findings = parsed as Finding[];
    } catch {
      findings = [];
    }
    let delta: DiffFile[] | null = null;
    try {
      const text = await src.compareDiff(row.head_sha, refs.headSha);
      if (text !== null) delta = parseUnifiedDiff(text);
    } catch (err) {
      warnings.push(`lineage: comparing ${row.head_sha.slice(0, 7)}...${refs.headSha.slice(0, 7)} failed: ${errMessage(err)}`);
    }
    const at = commits.findIndex((c) => c.sha === row.head_sha);
    previous = {
      headSha: row.head_sha,
      verdict: row.verdict ?? 'comment',
      summary: row.summary ?? '',
      findings,
      commitsSince: at >= 0 ? commits.length - at - 1 : 0,
      delta,
    };
  }

  return { reviewNumber: src.reviewCount() + 1, commits, previous, overview, warnings };
}

/** Text for the "changes since the previous review" prompt section of one file. */
export function deltaForFile(previous: PreviousReview, path: string): string {
  if (previous.delta === null) {
    return `Delta unavailable: GitHub could not compare ${previous.headSha.slice(0, 7)} with the current head (the previous head was probably force-pushed away). Treat the previous findings as possibly stale.`;
  }
  const file = previous.delta.find((f) => f.newPath === path);
  if (!file) return `This file is unchanged since the previous review at ${previous.headSha.slice(0, 7)}.`;
  return `Diff of this file from ${previous.headSha.slice(0, 7)} to the current head, with new-file line numbers:\n\n${hunkText(file)}`;
}
```

Note `Finding` is imported as a type from `reviewer.ts`; `reviewer.ts` will import `buildLineage` from `lineage.ts`. Type-only imports do not create a runtime cycle. If `npm run typecheck` complains, move `Finding`/`Severity` to `lineage.ts`... no: keep them in `reviewer.ts`; a `import type` cycle is fine in TypeScript.

**Step 4: Run** `npx vitest run tests/review/lineage.test.ts` → PASS. `npm run typecheck` → clean.

**Step 5: Commit**

```bash
git add src/review/lineage.ts tests/review/lineage.test.ts
git commit -m "feat(review): assemble review lineage from prior reviews, commits and base docs

Claude-Session: https://claude.ai/code/session_01N6MJwSqk1k5bN3pdrC37MR"
```

---

### Task 4: Prompts — lineage sections and rules

**Files:**
- Modify: `src/review/prompts.ts`
- Test: `tests/review/prompts.test.ts` (create if it does not exist; check first with `ls tests/review`)

**Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { buildFileReviewMessage, buildSummaryMessage, FILE_REVIEW_SYSTEM_PROMPT, SUMMARY_SYSTEM_PROMPT } from '../../src/review/prompts.js';
import type { Lineage } from '../../src/review/lineage.js';

const LINEAGE: Lineage = {
  reviewNumber: 2,
  commits: [{ sha: 'aaaa1111', message: 'feat: first' }, { sha: 'bbbb2222', message: 'fix: address review' }],
  previous: {
    headSha: 'aaaa1111', verdict: 'request_changes', summary: 'Earlier summary.',
    findings: [
      { path: 'src/app.ts', line: 2, severity: 'critical', title: 'Bad thing', body: 'Fix it.' },
      { path: 'src/other.ts', line: 9, severity: 'warning', title: 'Other thing', body: 'Hm.' },
    ],
    commitsSince: 1,
    delta: [],
  },
  overview: '### CLAUDE.md\nOne Node process.',
  warnings: [],
};

const base = { prTitle: 'T', prBody: 'B', path: 'src/app.ts', status: 'modified', hunkText: '@@ -1 +1 @@\n+x', context: '' };

describe('buildFileReviewMessage lineage', () => {
  it('renders overview, commits, previous findings for this file only, and the delta', () => {
    const msg = buildFileReviewMessage({ ...base, lineage: LINEAGE, delta: 'This file is unchanged since the previous review at aaaa111.' });
    expect(msg).toContain('## Repository overview');
    expect(msg).toContain('One Node process.');
    expect(msg).toContain('## Commits in this pull request (2)');
    expect(msg).toContain('- aaaa111 feat: first');
    expect(msg).toContain('## Previous RepoLens review of this pull request (review 1 at aaaa111, verdict request_changes)');
    expect(msg).toContain('- [critical] src/app.ts:2 — Bad thing');
    expect(msg).not.toContain('Other thing');
    expect(msg).toContain('## Changes to this file since the previous review');
    expect(msg).toContain('unchanged since the previous review');
    expect(msg.indexOf('## Repository overview')).toBeLessThan(msg.indexOf('## Commits in this pull request'));
    expect(msg.indexOf('## Previous RepoLens review')).toBeLessThan(msg.indexOf('## File under review'));
  });

  it('says the previous review had no findings on this file', () => {
    const msg = buildFileReviewMessage({ ...base, path: 'src/new.ts', lineage: LINEAGE, delta: 'd' });
    expect(msg).toContain('(no findings on this file)');
  });

  it('omits every lineage section on a first review with no overview', () => {
    const msg = buildFileReviewMessage({ ...base, lineage: { reviewNumber: 1, commits: [], overview: '', warnings: [] } });
    expect(msg).not.toContain('## Repository overview');
    expect(msg).not.toContain('## Commits in this pull request');
    expect(msg).not.toContain('## Previous RepoLens review');
    expect(msg).not.toContain('## Changes to this file');
  });

  it('is unchanged when no lineage is given', () => {
    expect(buildFileReviewMessage(base)).not.toContain('lineage');
  });
});

describe('buildSummaryMessage lineage', () => {
  it('renders commits and the whole previous review', () => {
    const msg = buildSummaryMessage({ prTitle: 'T', prBody: 'B', files: [], findings: [], lineage: LINEAGE });
    expect(msg).toContain('## Commits in this pull request (2)');
    expect(msg).toContain('## Previous RepoLens review of this pull request (review 1 at aaaa111, verdict request_changes)');
    expect(msg).toContain('Earlier summary.');
    expect(msg).toContain('- [warning] src/other.ts:9 — Other thing');
    expect(msg).toContain('1 commit since that review');
  });
});

describe('system prompts', () => {
  it('tell the model how to treat the previous review', () => {
    expect(FILE_REVIEW_SYSTEM_PROMPT).toMatch(/previous RepoLens review/i);
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/previous review/i);
  });
});
```

**Step 2: Run** `npx vitest run tests/review/prompts.test.ts` → FAIL (sections missing).

**Step 3: Implement** in `src/review/prompts.ts`

Add `import type { Lineage } from './lineage.js';` at the top.

Add to `FILE_REVIEW_SYSTEM_PROMPT`, after the paragraph that starts "Context comes in two kinds":

```
When a "Previous RepoLens review of this pull request" section is present, this is a re-review: build on it instead of starting over. Re-report a previous finding that still applies, at its current line number. Drop a previous finding that the "Changes to this file since the previous review" resolved. Drop a previous finding you now judge was wrong; do not keep it alive out of consistency. On a file that is unchanged since the previous review, the previous review read the same lines and raised nothing else, so add a new finding there only when you are certain. Use the "Commits in this pull request" list to understand how the change was built and which commits responded to the previous review, and the "Repository overview" to judge whether the change fits the architecture it lands in.
```

Add to `SUMMARY_SYSTEM_PROMPT`, after the first sentence of the summary instructions:

```
When a previous review of this pull request is present, say in one sentence what changed since it and which of its findings were resolved, dropped, or still open; the verdict is decided by the current findings alone.
```

Add these helpers after `prBlock`:

```ts
const short = (sha: string) => sha.slice(0, 7);

function commitsSection(l: Lineage): string | null {
  if (!l.commits.length) return null;
  return section(`Commits in this pull request (${l.commits.length})`, l.commits.map((c) => `- ${short(c.sha)} ${c.message}`).join('\n'));
}

function previousHeading(l: Lineage): string {
  const p = l.previous!;
  return `Previous RepoLens review of this pull request (review ${l.reviewNumber - 1} at ${short(p.headSha)}, verdict ${p.verdict})`;
}

function findingLines(findings: Lineage['commits'] extends never ? never : NonNullable<Lineage['previous']>['findings']): string {
  return findings.map((f) => `- [${f.severity}] ${f.path}:${f.line} — ${f.title}`).join('\n');
}
```

(Write `findingLines` with a plain `Finding[]` parameter: `import type { Finding } from './reviewer.js'`. The odd conditional type above is a placeholder, do not copy it.)

In `buildFileReviewMessage`, add optional inputs `lineage?: Lineage` and `delta?: string`, and insert after the repository-instructions section and before the head-context section:

```ts
  if (input.lineage) {
    const l = input.lineage;
    if (l.overview.trim()) parts.push(section('Repository overview (from the base branch, before this pull request)', l.overview.trim()));
    const commits = commitsSection(l);
    if (commits) parts.push(commits);
    if (l.previous) {
      const mine = l.previous.findings.filter((f) => f.path === input.path);
      parts.push(section(previousHeading(l), mine.length ? findingLines(mine) : '(no findings on this file)'));
      if (input.delta) parts.push(section('Changes to this file since the previous review', input.delta));
    }
  }
```

The test expects the overview heading to be exactly `## Repository overview` at the start; `section('Repository overview (from the base branch, before this pull request)', …)` satisfies `toContain('## Repository overview')`.

In `buildSummaryMessage`, add optional `lineage?: Lineage` and insert after the PR block:

```ts
  if (input.lineage) {
    const l = input.lineage;
    const commits = commitsSection(l);
    if (commits) parts.push(commits);
    if (l.previous) {
      const n = l.previous.commitsSince;
      const body = [
        l.previous.summary.trim() || '(no summary)',
        '',
        `${n} commit${n === 1 ? '' : 's'} since that review.`,
        '',
        l.previous.findings.length ? findingLines(l.previous.findings) : '(no findings)',
      ].join('\n');
      parts.push(section(previousHeading(l), body));
    }
  }
```

**Step 4: Run** `npx vitest run tests/review` → PASS (existing prompt-dependent tests must still pass). `npm run typecheck` → clean.

**Step 5: Commit**

```bash
git add src/review/prompts.ts tests/review/prompts.test.ts
git commit -m "feat(review): lineage sections and re-review rules in the prompts

Claude-Session: https://claude.ai/code/session_01N6MJwSqk1k5bN3pdrC37MR"
```

---

### Task 5: Wire lineage into `reviewPullRequest`

**Files:**
- Modify: `src/review/reviewer.ts` (`ReviewDeps.github` Pick; `runReview`; `buildReviewBody`; `postReview`)
- Modify: `tests/review/reviewer.test.ts` (fake github gains `listPullCommits` and `compareDiff`)

**Step 1: Write the failing tests**

First extend `FakeGithubOptions` and `fakeGithub` in `tests/review/reviewer.test.ts`:

```ts
  /** Commits returned by listPullCommits. */
  commits?: Array<{ sha: string; message: string }>;
  /** Diff returned by compareDiff (null = GitHub cannot compare). */
  compare?: string | null;
```

and in the `github` object:

```ts
    async listPullCommits() {
      return opts.commits ?? [];
    },
    async compareDiff(_owner: string, _repo: string, base: string, head: string) {
      compareCalls.push({ base, head });
      return opts.compare === undefined ? null : opts.compare;
    },
```

with `const compareCalls: Array<{ base: string; head: string }> = [];` returned alongside the others.

Add a new `describe('reviewPullRequest lineage', …)` block:

```ts
describe('reviewPullRequest lineage', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
    db.upsertRepo({ id: REPO_ID, kind: 'github', owner: 'o', name: 'r', branch: 'main', last_commit: 'base-sha-1' } as never);
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
    const file = llm.fileCalls()[0].messages[0].content as string;
    expect(file).toContain('review 1 at head-sh');
    expect(file).toContain('- [critical] src/app.ts:5 — Assignment in condition');
    expect(file).toContain('+  if (n === 0) return;');
    expect(file).toContain('- head-sh fix: compare');
    const summary = llm.calls.find((c) => c.system === SUMMARY_SYSTEM_PROMPT)!.messages[0].content as string;
    expect(summary).toContain('First pass.');
    expect(summary).toContain('1 commit since that review');
    expect(gh.reviews[0].input.body).toContain('Review 2 of this pull request; 1 commit since head-sh');
    expect(result.warnings).toEqual([]);
  });

  it('reads overview docs at the base sha and puts them in the file prompt', async () => {
    const llm = fakeLlm();
    const gh = fakeGithub(DIFF, PR, { headFiles: { 'CLAUDE.md': 'One Node process, no external services.' } });
    await reviewPullRequest(makeDeps(db, { llm: llm.provider, github: gh.github }), { repoId: REPO_ID, prNumber: 42 });
    expect(gh.contentCalls).toContainEqual({ path: 'CLAUDE.md', ref: 'base-sha-1' });
    expect(llm.fileCalls()[0].messages[0].content).toContain('One Node process, no external services.');
  });

  it('carries no previous review on a first review and does not call compare', async () => {
    const llm = fakeLlm();
    const gh = fakeGithub();
    await reviewPullRequest(makeDeps(db, { llm: llm.provider, github: gh.github }), { repoId: REPO_ID, prNumber: 42 });
    expect(gh.compareCalls).toEqual([]);
    expect(llm.fileCalls()[0].messages[0].content).not.toContain('Previous RepoLens review');
    expect(gh.reviews[0].input.body).not.toContain('Review 1 of');
  });

  it('warns and still reviews when lineage fetches fail', async () => {
    db.insertReview({ repo_id: REPO_ID, pr_number: 42, head_sha: 'head-sha-0', status: 'done', summary: 's', verdict: 'comment', comments_json: '[]', posted: 1, error: null });
    const llm = fakeLlm();
    const gh = fakeGithub(DIFF, PR, {});
    gh.github.listPullCommits = async () => { throw new Error('commits down'); };
    const result = await reviewPullRequest(makeDeps(db, { llm: llm.provider, github: gh.github }), { repoId: REPO_ID, prNumber: 42 });
    expect(result.warnings.join('\n')).toContain('commits down');
    expect(llm.fileCalls()[0].messages[0].content).toContain('Delta unavailable');
  });
});
```

Check how existing tests in the file seed the repo (look at the `beforeEach` around line 177) and copy that exactly instead of the `upsertRepo(… as never)` guess above. Note `fakeGithub`'s `getFileContent` ignores `ref`; that is fine, the test asserts on `contentCalls` for the ref.

**Step 2: Run** `npx vitest run tests/review/reviewer.test.ts` → FAIL (typecheck errors on the Pick, missing sections).

**Step 3: Implement**

In `ReviewDeps.github` Pick add `'listPullCommits' | 'compareDiff'`.

In `reviewer.ts` import `{ buildLineage, deltaForFile, type Lineage } from './lineage.js'`.

In `runReview`, right after `const parsed = parseUnifiedDiff(diffText);` and the `warnings` declaration:

```ts
    const lineage = await buildLineage(
      {
        previousReview: () => db.findLatestReview(opts.repoId, opts.prNumber),
        reviewCount: () => db.countPrReviews(opts.repoId, opts.prNumber),
        compareDiff: (base, head) => github.compareDiff(repo.owner, repo.name, base, head),
        listCommits: () => github.listPullCommits(repo.owner, repo.name, opts.prNumber),
        readFile: (path, ref) => github.getFileContent(repo.owner, repo.name, path, ref),
      },
      { baseSha: pr.baseSha, headSha: pr.headSha },
    );
    warnings.push(...lineage.warnings);
```

Note: with `opts.force`, `findLatestReview` may return the review of this same head. That is acceptable: the model is told it is a re-review of an identical head. Do not special-case it.

In the per-file `buildFileReviewMessage` call add:

```ts
                lineage,
                delta: lineage.previous ? deltaForFile(lineage.previous, path) : undefined,
```

In the `buildSummaryMessage` call add `lineage,`.

Thread the lineage into the posted body: add an optional `lineage?: Pick<Lineage, 'reviewNumber' | 'previous'>` to `buildReviewBody`'s input and, before the `Generated by` line:

```ts
  if (input.lineage?.previous) {
    const n = input.lineage.previous.commitsSince;
    parts.push(`<sub>Review ${input.lineage.reviewNumber} of this pull request; ${n} commit${n === 1 ? '' : 's'} since ${shortSha(input.lineage.previous.headSha)}.</sub>`);
    parts.push('');
  }
```

`postReview` receives `result`; add an optional `lineage?: Lineage` field to `ReviewResult`... no. Simpler: add `lineage?: Pick<Lineage, 'reviewNumber' | 'previous'>` to `PostContext` and set it in `runReview` before calling `postReview` (`postCtx.lineage = lineage` requires `PostContext.lineage` to be mutable; declare it `lineage?: …`). The cached-review path never sets it, which is right: a re-post of a stored review keeps its original body semantics.

Check `shortSha` exists in `reviewer.ts` (it is used in `postReview`); reuse it.

**Step 4: Run** `npx vitest run` (all) → PASS. `npm run typecheck` → clean.

**Step 5: Commit**

```bash
git add src/review/reviewer.ts tests/review/reviewer.test.ts
git commit -m "feat(review): re-reviews build on the previous review, the delta and the PR commits

Claude-Session: https://claude.ai/code/session_01N6MJwSqk1k5bN3pdrC37MR"
```

---

### Task 6: Docs

**Files:**
- Modify: `CLAUDE.md` (the **Review pipeline** paragraph)

**Step 1:** Append to the review pipeline paragraph:

```
Each review also carries lineage (`src/review/lineage.ts`): the PR's commit list, an overview read from `CLAUDE.md`/`ARCHITECTURE.md`/`README.md` at the base sha, and, on a re-review, the previous review's findings plus the compare diff from its head to the current one. Findings are never carried forward mechanically; the prompt tells the model to re-report what still applies, drop what the delta fixed, and retract what it now judges wrong. Every lineage fetch degrades to a warning.
```

**Step 2:** `npm test && npm run typecheck` → both pass.

**Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: describe review lineage

Claude-Session: https://claude.ai/code/session_01N6MJwSqk1k5bN3pdrC37MR"
```

---

### Task 7: Push and open the PR

```bash
git push -u origin feat/review-lineage
gh pr create --title "Review lineage: previous review, delta, commits and base overview in every review" --body "$(cat <<'EOF'
## Summary
- Re-reviews of a PR receive the previous RepoLens review's findings and the compare diff from its head to the current head. The prompt tells the model to re-report what still applies, drop what the delta fixed, and retract what it now judges wrong. Nothing is carried forward mechanically.
- Every review receives the PR's commit list and an overview read from CLAUDE.md / ARCHITECTURE.md / README.md at the base sha.
- The posted body says which review of the PR this is and how many commits landed since the last one.
- New: `GitHubClient.listPullCommits`, `GitHubClient.compareDiff`, `Db.findLatestReview`, `Db.countPrReviews`, `src/review/lineage.ts`.

Motivation: on #9 the second review re-read the whole diff cold, contradicted the first review on the same line, and raised new warnings on a file that had not changed. Design: docs/plans/2026-09-04-review-lineage-design.md.

## Test plan
- [x] `npm test`, `npm run typecheck`
- [x] New tests: github client methods, db lookup, lineage assembly and degradation, prompt sections, reviewer wiring

https://claude.ai/code/session_01N6MJwSqk1k5bN3pdrC37MR
EOF
)"
```

Then watch the `repolens/review` status on the PR and fix criticals until green.
