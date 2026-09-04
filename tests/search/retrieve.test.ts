import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type Db } from '../../src/db.js';
import type { EmbeddingProvider } from '../../src/embeddings/types.js';
import type { RetrievedChunk } from '../../src/search/types.js';
import { createRetriever, rrf, formatContext, chunksToSources, pathWeight } from '../../src/search/retrieve.js';

const REPO = 'github:acme/app';

const AUTH_CODE = `export function verifyToken(raw: string): Claims {
  // token verification: decode the jwt and check its signature
  const claims = decodeJwt(raw);
  if (!claims) throw new Error('invalid token');
  return claims;
}`;

const DB_CODE = `export function openDatabase(path: string): Handle {
  const handle = sqliteOpen(path);
  handle.pragma('journal_mode = WAL');
  return handle;
}`;

function seed(db: Db): { auth: number; database: number } {
  db.upsertRepo({ id: REPO, remote: 'https://example.com/acme/app.git', owner: 'acme', name: 'app', branch: 'main' });
  const authFile = db.upsertFile({ repo_id: REPO, path: 'src/auth.ts', blob_hash: 'a1', language: 'typescript', size: AUTH_CODE.length });
  const dbFile = db.upsertFile({ repo_id: REPO, path: 'src/storage.ts', blob_hash: 'b2', language: 'typescript', size: DB_CODE.length });
  const [auth] = db.insertChunks([
    { fileId: authFile.id, repoId: REPO, path: 'src/auth.ts', startLine: 1, endLine: 6, content: AUTH_CODE },
  ]);
  const [database] = db.insertChunks([
    { fileId: dbFile.id, repoId: REPO, path: 'src/storage.ts', startLine: 1, endLine: 5, content: DB_CODE },
  ]);
  return { auth, database };
}

function fakeEmbeddings(vector: number[]): EmbeddingProvider {
  return {
    model: 'fake',
    dimension: vector.length,
    async embed(texts: string[]) {
      return texts.map(() => vector);
    },
  };
}

describe('rrf', () => {
  it('ranks an id that is first in both lists above one first in a single list', () => {
    const scores = rrf([
      [1, 2, 3],
      [1, 4, 5],
    ]);
    expect(scores.get(1)!).toBeGreaterThan(scores.get(2)!);
    expect(scores.get(1)!).toBeGreaterThan(scores.get(4)!);
    expect(scores.get(2)).toBeCloseTo(scores.get(4)!, 10);
  });

  it('uses 1/(k+rank) with 1-based ranks', () => {
    const scores = rrf([[7]], 60);
    expect(scores.get(7)).toBeCloseTo(1 / 61, 10);
  });
});

describe('createRetriever', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(() => db.close());

  it('returns the lexically relevant chunk first', async () => {
    const { auth } = seed(db);
    const retrieve = createRetriever({ db });
    const hits = await retrieve({ repoIds: [REPO], query: 'how does token verification work' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].chunkId).toBe(auth);
    expect(hits[0].path).toBe('src/auth.ts');
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it('returns nothing when the query has no usable tokens', async () => {
    seed(db);
    const retrieve = createRetriever({ db });
    expect(await retrieve({ repoIds: [REPO], query: 'how is it?' })).toEqual([]);
  });

  it('fuses lexical and vector signals', async () => {
    const { auth, database } = seed(db);
    db.ensureVecTable(3);
    db.insertVectors([
      { chunkId: auth, repoId: REPO, embedding: [1, 0, 0] },
      { chunkId: database, repoId: REPO, embedding: [0, 1, 0] },
    ]);
    // The query embedding points at the storage chunk while the lexical query points at auth.
    const retrieve = createRetriever({ db, embeddings: fakeEmbeddings([0, 1, 0]) });
    const hits = await retrieve({ repoIds: [REPO], query: 'token verification' });
    const ids = hits.map((h) => h.chunkId);
    expect(ids).toContain(auth);
    expect(ids).toContain(database);
  });

  it('falls back to lexical results when embedding fails', async () => {
    const { auth } = seed(db);
    db.ensureVecTable(3);
    const broken: EmbeddingProvider = {
      model: 'broken',
      dimension: 3,
      async embed() {
        throw new Error('boom');
      },
    };
    const retrieve = createRetriever({ db, embeddings: broken });
    const hits = await retrieve({ repoIds: [REPO], query: 'token verification' });
    expect(hits.map((h) => h.chunkId)).toContain(auth);
  });

  it('honours excludePath and limit', async () => {
    const { database } = seed(db);
    const retrieve = createRetriever({ db });
    const hits = await retrieve({ repoIds: [REPO], query: 'verifyToken openDatabase handle', excludePath: 'src/auth.ts' });
    expect(hits.map((h) => h.path)).not.toContain('src/auth.ts');
    expect(hits.map((h) => h.chunkId)).toContain(database);

    const one = await retrieve({ repoIds: [REPO], query: 'verifyToken openDatabase handle', limit: 1 });
    expect(one).toHaveLength(1);
  });

  it('does not buy query embeddings for lexical-only reviews', async () => {
    const { auth } = seed(db);
    db.ensureVecTable(3);
    let calls = 0;
    const embeddings = fakeEmbeddings([1, 0, 0]);
    embeddings.embed = async () => { calls++; return [[1, 0, 0]]; };
    const hits = await createRetriever({ db, embeddings })({ repoIds: [REPO], query: 'token verification', lexicalOnly: true });
    expect(hits.map((h) => h.chunkId)).toContain(auth);
    expect(calls).toBe(0);
  });

  it('honours excludePaths, on top of excludePath', async () => {
    seed(db);
    const retrieve = createRetriever({ db });
    const query = 'verifyToken openDatabase handle';

    const hits = await retrieve({ repoIds: [REPO], query, excludePaths: ['src/auth.ts'] });
    expect(hits.map((h) => h.path)).toEqual(['src/storage.ts']);

    const none = await retrieve({ repoIds: [REPO], query, excludePaths: ['src/auth.ts', 'src/storage.ts'] });
    expect(none).toEqual([]);

    const both = await retrieve({ repoIds: [REPO], query, excludePath: 'src/storage.ts', excludePaths: ['src/auth.ts'] });
    expect(both).toEqual([]);
  });
});

describe('formatContext', () => {
  const chunks: RetrievedChunk[] = [
    { chunkId: 1, repoId: REPO, path: 'src/auth.ts', startLine: 1, endLine: 6, content: 'const a = 1;', score: 1 },
    { chunkId: 2, repoId: REPO, path: 'src/storage.py', startLine: 10, endLine: 12, content: 'x = 2', score: 0.5 },
  ];

  it('renders a header and fenced block per chunk with the language from the extension', () => {
    const out = formatContext(chunks);
    expect(out).toContain(`### ${REPO} src/auth.ts:1-6`);
    expect(out).toContain('```typescript\nconst a = 1;\n```');
    expect(out).toContain('```python\nx = 2\n```');
  });

  it('stops before exceeding the budget', () => {
    const out = formatContext(chunks, 80);
    expect(out).toContain('src/auth.ts');
    expect(out).not.toContain('src/storage.py');
    expect(out.length).toBeLessThanOrEqual(80);
  });

  it('always includes at least one chunk, truncating its content', () => {
    const big: RetrievedChunk[] = [{ ...chunks[0], content: 'y'.repeat(5000) }];
    const out = formatContext(big, 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).toContain('src/auth.ts');
    expect(out).toContain('y');
  });

  it('returns an empty string for no chunks', () => {
    expect(formatContext([])).toBe('');
  });
});

describe('chunksToSources', () => {
  it('maps chunks and summarises with the first non-empty line', () => {
    const sources = chunksToSources([
      { chunkId: 3, repoId: REPO, path: 'src/auth.ts', startLine: 4, endLine: 9, content: '\n\n  export function verifyToken() {\n  ...\n', score: 1 },
    ]);
    expect(sources).toEqual([
      { repository: REPO, filepath: 'src/auth.ts', linestart: 4, lineend: 9, summary: 'export function verifyToken() {' },
    ]);
  });

  it('trims the summary to 120 characters', () => {
    const [s] = chunksToSources([
      { chunkId: 4, repoId: REPO, path: 'a.ts', startLine: 1, endLine: 2, content: 'z'.repeat(500), score: 1 },
    ]);
    expect(s.summary).toHaveLength(120);
  });
});

describe('pathWeight', () => {
  it('demotes changelog-style files', () => {
    expect(pathWeight('History.md')).toBeLessThan(1);
    expect(pathWeight('docs/CHANGELOG.md')).toBeLessThan(1);
    expect(pathWeight('src/history.ts')).toBe(1);
    expect(pathWeight('lib/router/index.js')).toBe(1);
  });
  it('ranks source above tests and docs, and boosts path matches', () => {
    expect(pathWeight('tests/llm/claude-cli.test.ts')).toBeLessThan(pathWeight('src/llm/claude-cli.ts'));
    expect(pathWeight('docs/plans/design.md')).toBeLessThan(pathWeight('src/db.ts'));
    expect(pathWeight('src/llm/claude-cli.ts', ['claude', 'cli'])).toBeGreaterThan(pathWeight('src/llm/openrouter.ts', ['claude', 'cli']));
    expect(pathWeight('src/a.ts', ['zz'])).toBe(1);
  });
});
