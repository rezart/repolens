import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate, type Db } from '../src/db.js';

function seed(db: Db) {
  db.upsertRepo({ id: 'github:o/n', remote: 'https://github.com/o/n', owner: 'o', name: 'n', branch: 'main' });
  const f = db.upsertFile({ repo_id: 'github:o/n', path: 'src/auth.ts', blob_hash: 'abc', language: 'typescript', size: 10 });
  const g = db.upsertFile({ repo_id: 'github:o/n', path: 'src/db.ts', blob_hash: 'def', language: 'typescript', size: 10 });
  const ids = db.insertChunks([
    { fileId: f.id, repoId: 'github:o/n', path: 'src/auth.ts', startLine: 1, endLine: 5, content: 'export function verifyToken(token: string) { return jwt.verify(token) }' },
    { fileId: g.id, repoId: 'github:o/n', path: 'src/db.ts', startLine: 1, endLine: 5, content: 'export function openDatabase(path: string) { return new Database(path) }' },
  ]);
  return { f, g, ids };
}

describe('Db', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('upserts repos and reads them back', () => {
    const r = db.upsertRepo({ id: 'github:o/n', remote: 'u', owner: 'o', name: 'n', branch: 'main' });
    expect(r.status).toBe('queued');
    db.setRepoStatus('github:o/n', 'ready', { last_commit: 'sha', file_count: 3 });
    expect(db.getRepo('github:o/n')?.last_commit).toBe('sha');
    expect(db.getRepo('github:o/n')?.file_count).toBe(3);
  });

  it('records a branch resolved after the clone', () => {
    db.upsertRepo({ id: 'github:o/n', remote: 'u', owner: 'o', name: 'n', branch: '' });
    expect(db.getRepo('github:o/n')?.branch).toBe('');
    db.setRepoBranch('github:o/n', 'trunk');
    expect(db.getRepo('github:o/n')?.branch).toBe('trunk');
  });

  it('full-text searches chunks with bm25 ranking', () => {
    seed(db);
    const hits = db.ftsSearch(['github:o/n'], '"verifyToken" OR "jwt"', 10);
    expect(hits).toHaveLength(1);
    expect(hits[0].chunk.path).toBe('src/auth.ts');
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it('scopes search to the given repos', () => {
    seed(db);
    expect(db.ftsSearch(['github:other/x'], '"verifyToken"', 10)).toHaveLength(0);
  });

  it('deletes a file with its chunks and fts rows', () => {
    seed(db);
    db.deleteFile('github:o/n', 'src/auth.ts');
    expect(db.ftsSearch(['github:o/n'], '"verifyToken"', 10)).toHaveLength(0);
    expect(db.listFiles('github:o/n')).toHaveLength(1);
  });

  it('stores vectors and finds nearest neighbours per repo', () => {
    const { ids } = seed(db);
    db.ensureVecTable(4);
    db.insertVectors([
      { chunkId: ids[0], repoId: 'github:o/n', embedding: [1, 0, 0, 0] },
      { chunkId: ids[1], repoId: 'github:o/n', embedding: [0, 1, 0, 0] },
    ]);
    const hits = db.vecSearch(['github:o/n'], [0.9, 0.1, 0, 0], 2);
    expect(hits[0].chunk.id).toBe(ids[0]);
    expect(hits[1].chunk.id).toBe(ids[1]);
    expect(db.vecSearch(['github:none/x'], [1, 0, 0, 0], 2)).toHaveLength(0);
    expect(db.chunkIdsWithoutVectors('github:o/n')).toEqual([]);
    db.deleteFile('github:o/n', 'src/auth.ts');
    expect(db.vecSearch(['github:o/n'], [1, 0, 0, 0], 2).map((h) => h.chunk.id)).toEqual([ids[1]]);
  });

  it('refuses a different vector dimension', () => {
    db.ensureVecTable(4);
    expect(() => db.ensureVecTable(8)).toThrow(/dimension/);
  });

  it('tracks jobs and reviews', () => {
    seed(db);
    const job = db.createJob('index', 'github:o/n');
    db.updateJob(job.id, { status: 'done', progress: '3 files' });
    expect(db.getJob(job.id)?.status).toBe('done');
    const review = db.insertReview({
      repo_id: 'github:o/n', pr_number: 7, head_sha: 'h', status: 'done', summary: 's', verdict: 'comment',
      comments_json: '[]', posted: 0, error: null,
    });
    expect(db.findReview('github:o/n', 7, 'h')?.id).toBe(review.id);
    db.markReviewPosted(review.id);
    expect(db.getReview(review.id)?.posted).toBe(1);
  });

  it('tags review jobs with their pull request number', () => {
    seed(db);
    db.createJob('index', 'github:o/n');
    const first = db.createJob('review', 'github:o/n', 7);
    const second = db.createJob('review', 'github:o/n', 8);
    db.createJob('review', 'github:other/x', 9);
    expect(db.getJob(first.id)?.pr_number).toBe(7);
    // latest first, this repo's review jobs only
    expect(db.listReviewJobsForRepo('github:o/n').map((j) => j.id)).toEqual([second.id, first.id]);
  });

  it('adds pr_number to a jobs table created before the column existed', () => {
    const hasPrNumber = () => (db.raw.pragma('table_info(jobs)') as Array<{ name: string }>).some((c) => c.name === 'pr_number');
    expect(hasPrNumber()).toBe(true);
    db.raw.exec('alter table jobs drop column pr_number');
    expect(hasPrNumber()).toBe(false);
    migrate(db.raw);
    expect(hasPrNumber()).toBe(true);
    // running it again on an up-to-date database is a no-op
    migrate(db.raw);
    expect(hasPrNumber()).toBe(true);
  });
});

describe('llm_usage', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
  });

  const row = (over: Partial<Parameters<Db['insertUsage']>[0]> = {}) => ({
    role: 'review' as const,
    provider: 'codex-cli',
    model: 'gpt-5.6-terra',
    input_tokens: 100,
    cached_input_tokens: 50,
    cache_write_tokens: 0,
    output_tokens: 20,
    cost_usd: null,
    ...over,
  });

  it('aggregates per day, provider, model and role, splitting priced from unpriced calls', () => {
    db.insertUsage(row());
    db.insertUsage(row({ cost_usd: 0.5, input_tokens: 10, output_tokens: 1 }));
    db.insertUsage(row({ role: 'chat', provider: 'claude-cli', model: 'claude-haiku-4-5', cost_usd: 0.01 }));
    // An old row on another day, backdated by hand.
    db.raw.prepare(`update llm_usage set ts='2020-01-01T00:00:00.000Z' where id=1`).run();

    const all = db.usageByDay('2019-01-01');
    expect(all).toHaveLength(3);
    const today = db.usageByDay('2021-01-01');
    expect(today).toHaveLength(2);
    const codex = today.find((r) => r.provider === 'codex-cli')!;
    expect(codex.calls).toBe(1);
    expect(codex.reported_cost_usd).toBeCloseTo(0.5);
    expect(codex.unpriced_calls).toBe(0);
    expect(codex.input_tokens).toBe(10);
    const oldCodex = all.find((r) => r.day === '2020-01-01')!;
    expect(oldCodex.unpriced_calls).toBe(1);
    expect(oldCodex.unpriced_input_tokens).toBe(100);
    expect(oldCodex.reported_cost_usd).toBe(0);
    // Newest day first.
    expect(all[0]!.day > all[all.length - 1]!.day).toBe(true);
  });

  it('stores and reads meta values', () => {
    expect(db.getMeta('x')).toBeUndefined();
    db.setMeta('x', '1');
    db.setMeta('x', '2');
    expect(db.getMeta('x')).toBe('2');
  });
});
