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
  id: 3, repo_id: 'github:o/r', pr_number: 42, head_sha: 'old-sha', status: 'done', cost_usd: null,
  provider: null, model: null,
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
    const big = 'x'.repeat(12_000);
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
    // hunkText renders `<line> + <content>`, so the added line reads `+ c`.
    expect(deltaForFile(l.previous!, 'src/app.ts')).toContain('+ c');
  });

  it('says the file is unchanged when the delta did not touch it', () => {
    expect(deltaForFile(previous, 'src/other.ts')).toMatch(/unchanged since/i);
  });

  it('says the delta is unavailable when compare failed', () => {
    expect(deltaForFile({ ...previous, delta: null }, 'src/app.ts')).toMatch(/unavailable/i);
  });
});
