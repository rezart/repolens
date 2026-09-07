import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../../src/db.js';
import { RepoCheckout } from '../../src/indexer/git.js';
import { indexRepo } from '../../src/indexer/indexer.js';
import type { EmbeddingProvider } from '../../src/embeddings/types.js';

const exec = promisify(execFile);
const REPO_ID = 'github:o/n';

async function git(args: string[], cwd: string) {
  await exec('git', args, { cwd });
}

async function commitAll(cwd: string, message: string) {
  await git(['add', '-A'], cwd);
  await git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message], cwd);
}

function fakeEmbeddings(model = 'fake'): EmbeddingProvider & { calls: number; inputs: string[][] } {
  return {
    model,
    dimension: 4,
    calls: 0,
    inputs: [],
    async embed(texts: string[]) {
      this.calls++;
      this.inputs.push(texts);
      return texts.map((t) => [t.length % 7, 1, 0, 0]);
    },
  };
}

const FILE_A = ['// alpha', 'export function alpha() {', '  return 1;', '}'].join('\n') + '\n';
const FILE_B = ['// beta', 'export function beta() {', '  return 2;', '}'].join('\n') + '\n';

describe('indexRepo', () => {
  let root: string;
  let repoDir: string;
  let db: Db;
  let checkout: RepoCheckout;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'repolens-idx-'));
    repoDir = join(root, 'repo');
    mkdirSync(repoDir, { recursive: true });
    await git(['init', '-q', '-b', 'main', '.'], repoDir);
    writeFileSync(join(repoDir, 'a.ts'), FILE_A);
    writeFileSync(join(repoDir, 'b.ts'), FILE_B);
    await commitAll(repoDir, 'one');

    db = openDb(':memory:');
    db.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/n', owner: 'o', name: 'n', branch: 'main' });
    checkout = new RepoCheckout({ dir: repoDir, url: 'https://github.com/o/n.git' });
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('indexes every file and embeds every chunk', async () => {
    const embeddings = fakeEmbeddings();
    const res = await indexRepo({ db, checkout, repoId: REPO_ID, embeddings });
    expect(res.files).toBe(2);
    expect(res.chunks).toBeGreaterThan(0);
    expect(res.skipped).toBe(0);
    expect(res.removed).toBe(0);
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(db.countChunks(REPO_ID)).toBe(res.chunks);
    expect(db.vectorDimension).toBe(4);
    expect(db.chunkIdsWithoutVectors(REPO_ID)).toEqual([]);

    const repo = db.getRepo(REPO_ID)!;
    expect(repo.status).toBe('ready');
    expect(repo.last_commit).toBe(res.commit);
    expect(repo.file_count).toBe(2);
    expect(repo.chunk_count).toBe(res.chunks);
    expect(repo.indexed_at).toBeTruthy();
  });

  it('skips unchanged files on re-index', async () => {
    const embeddings = fakeEmbeddings();
    const first = await indexRepo({ db, checkout, repoId: REPO_ID, embeddings });
    const second = await indexRepo({ db, checkout, repoId: REPO_ID, embeddings });
    expect(second.skipped).toBe(2);
    expect(second.files).toBe(0);
    expect(second.removed).toBe(0);
    expect(db.countChunks(REPO_ID)).toBe(first.chunks);
  });

  it('reuses embeddings across different repository ids', async () => {
    const embeddings = fakeEmbeddings();
    await indexRepo({ db, checkout, repoId: REPO_ID, embeddings });

    const otherRepo = 'github:other/n';
    db.upsertRepo({ id: otherRepo, remote: 'https://github.com/other/n', owner: 'other', name: 'n', branch: 'main' });
    await indexRepo({ db, checkout, repoId: otherRepo, embeddings });

    expect(embeddings.calls).toBe(1);
    expect(embeddings.inputs).toHaveLength(1);
    expect(db.chunkIdsWithoutVectors(otherRepo)).toEqual([]);
    expect(db.vecSearch([otherRepo], [1, 1, 0, 0], 1)).toHaveLength(1);
  });

  it('does not reuse embeddings from a different model', async () => {
    await indexRepo({ db, checkout, repoId: REPO_ID, embeddings: fakeEmbeddings('model-a') });

    const otherRepo = 'github:other/n';
    db.upsertRepo({ id: otherRepo, remote: 'https://github.com/other/n', owner: 'other', name: 'n', branch: 'main' });
    const modelB = fakeEmbeddings('model-b');
    await indexRepo({ db, checkout, repoId: otherRepo, embeddings: modelB });

    expect(modelB.calls).toBe(1);
    expect(modelB.inputs[0]).toHaveLength(db.countChunks(otherRepo));
  });

  it('sends only cache misses while preserving vectors for mixed hit and miss batches', async () => {
    const first = fakeEmbeddings();
    await indexRepo({ db, checkout, repoId: REPO_ID, embeddings: first });

    writeFileSync(join(repoDir, 'c.ts'), 'export function gamma() { return 3; }\n');
    await commitAll(repoDir, 'two');

    const otherRepo = 'github:other/n';
    db.upsertRepo({ id: otherRepo, remote: 'https://github.com/other/n', owner: 'other', name: 'n', branch: 'main' });
    const second = fakeEmbeddings();
    await indexRepo({ db, checkout, repoId: otherRepo, embeddings: second });

    expect(second.calls).toBe(1);
    expect(second.inputs[0]).toEqual(['c.ts\nexport function gamma() { return 3; }\n']);
    expect(db.chunkIdsWithoutVectors(otherRepo)).toEqual([]);
    expect(db.vecSearch([otherRepo], [1, 1, 0, 0], 3)).toHaveLength(3);
  });

  it('looks up large indexes in embedding-cache batches', async () => {
    const count = 1_024;
    const entries = Array.from({ length: count }, (_, i) => ({
      path: `src/file-${i}.ts`,
      blobHash: i.toString(16).padStart(40, '0'),
      size: 32,
    }));
    const largeCheckout = {
      async headSha() { return 'a'.repeat(40); },
      async listFiles() { return entries; },
      async readFile(path: string) { return `export const value = '${path}';\n`; },
      async readBlob() { throw new Error('unexpected blob read'); },
    } as unknown as RepoCheckout;
    const lookupSizes: number[] = [];
    const lookup = db.getEmbeddingCache.bind(db);
    db.getEmbeddingCache = (model, hashes) => {
      lookupSizes.push(hashes.length);
      return lookup(model, hashes);
    };
    db.upsertRepo({ id: 'github:large/n', remote: 'https://github.com/large/n', owner: 'large', name: 'n', branch: 'main' });

    const res = await indexRepo({ db, checkout: largeCheckout, repoId: 'github:large/n', embeddings: fakeEmbeddings() });

    expect(res.chunks).toBe(count);
    expect(Math.max(...lookupSizes)).toBeLessThanOrEqual(64);
    expect(lookupSizes).toHaveLength(Math.ceil(count / 64));
  });

  it('packs sparse cache misses across lookup windows and preserves vector mapping', async () => {
    const count = 130;
    const entries = Array.from({ length: count }, (_, i) => ({
      path: `src/file-${i}.ts`,
      blobHash: i.toString(16).padStart(40, '0'),
      size: 32,
    }));
    const largeCheckout = {
      async headSha() { return 'a'.repeat(40); },
      async listFiles() { return entries; },
      async readFile(path: string) { return `export const value = '${path}';\n`; },
      async readBlob() { throw new Error('unexpected blob read'); },
    } as unknown as RepoCheckout;
    const embeddings = fakeEmbeddings();
    const missIndexes = new Set([1, 65, 129]);
    for (let i = 0; i < count; i++) {
      if (missIndexes.has(i)) continue;
      const text = `src/file-${i}.ts\nexport const value = 'src/file-${i}.ts';\n`;
      db.insertEmbeddingCache(embeddings.model, [{
        inputHash: createHash('sha256').update(text).digest('hex'),
        embedding: [100 + i, 1, 0, 0],
      }]);
    }
    db.upsertRepo({ id: 'github:large/n', remote: 'https://github.com/large/n', owner: 'large', name: 'n', branch: 'main' });

    await indexRepo({ db, checkout: largeCheckout, repoId: 'github:large/n', embeddings });

    expect(embeddings.calls).toBe(1);
    expect(embeddings.inputs[0]).toEqual([...missIndexes].map((i) => `src/file-${i}.ts\nexport const value = 'src/file-${i}.ts';\n`));
    const chunks = db.getChunksForPath('github:large/n', 'src/file-0.ts');
    expect(db.vecSearch(['github:large/n'], [100, 1, 0, 0], 1)[0]?.chunk.id).toBe(chunks[0].id);
    expect(db.chunkIdsWithoutVectors('github:large/n')).toEqual([]);
  });

  it('sends 128-plus cache misses as 64, 64, and a tail', async () => {
    const count = 192;
    const missIndexes = new Set([
      ...Array.from({ length: 43 }, (_, i) => i),
      ...Array.from({ length: 43 }, (_, i) => 64 + i),
      ...Array.from({ length: 44 }, (_, i) => 128 + i),
    ]);
    const entries = Array.from({ length: count }, (_, i) => ({
      path: `src/file-${i}.ts`,
      blobHash: i.toString(16).padStart(40, '0'),
      size: 32,
    }));
    const largeCheckout = {
      async headSha() { return 'a'.repeat(40); },
      async listFiles() { return entries; },
      async readFile(path: string) { return `export const value = '${path}';\n`; },
      async readBlob() { throw new Error('unexpected blob read'); },
    } as unknown as RepoCheckout;
    const embeddings = fakeEmbeddings();
    db.upsertRepo({ id: 'github:large/n', remote: 'https://github.com/large/n', owner: 'large', name: 'n', branch: 'main' });

    for (let i = 0; i < count; i++) {
      if (missIndexes.has(i)) continue;
      const text = `src/file-${i}.ts\nexport const value = 'src/file-${i}.ts';\n`;
      db.insertEmbeddingCache(embeddings.model, [{
        inputHash: createHash('sha256').update(text).digest('hex'),
        embedding: [100 + i, 1, 0, 0],
      }]);
    }
    await indexRepo({ db, checkout: largeCheckout, repoId: 'github:large/n', embeddings });

    expect(embeddings.inputs.map((inputs) => inputs.length)).toEqual([64, 64, 2]);
  });

  it('keeps completed packed groups on failure so retry embeds only remaining misses', async () => {
    const count = 192;
    const missIndexes = new Set([
      ...Array.from({ length: 43 }, (_, i) => i),
      ...Array.from({ length: 43 }, (_, i) => 64 + i),
      ...Array.from({ length: 44 }, (_, i) => 128 + i),
    ]);
    const entries = Array.from({ length: count }, (_, i) => ({
      path: `src/file-${i}.ts`,
      blobHash: i.toString(16).padStart(40, '0'),
      size: 32,
    }));
    const largeCheckout = {
      async headSha() { return 'a'.repeat(40); },
      async listFiles() { return entries; },
      async readFile(path: string) { return `export const value = '${path}';\n`; },
      async readBlob() { throw new Error('unexpected blob read'); },
    } as unknown as RepoCheckout;
    let failTail = true;
    const embeddings = fakeEmbeddings();
    embeddings.embed = async function (texts: string[]) {
      this.calls++;
      this.inputs.push(texts);
      if (failTail && this.calls === 3) throw new Error('tail failed');
      return texts.map((t) => [t.length % 7, 1, 0, 0]);
    };
    for (let i = 0; i < count; i++) {
      if (missIndexes.has(i)) continue;
      const text = `src/file-${i}.ts\nexport const value = 'src/file-${i}.ts';\n`;
      db.insertEmbeddingCache(embeddings.model, [{
        inputHash: createHash('sha256').update(text).digest('hex'),
        embedding: [100 + i, 1, 0, 0],
      }]);
    }
    db.upsertRepo({ id: 'github:large/n', remote: 'https://github.com/large/n', owner: 'large', name: 'n', branch: 'main' });

    await expect(indexRepo({ db, checkout: largeCheckout, repoId: 'github:large/n', embeddings })).rejects.toThrow('tail failed');
    expect(db.chunkIdsWithoutVectors('github:large/n')).toHaveLength(2);
    failTail = false;
    await indexRepo({ db, checkout: largeCheckout, repoId: 'github:large/n', embeddings });

    expect(embeddings.inputs.map((inputs) => inputs.length)).toEqual([64, 64, 2, 2]);
    expect(db.chunkIdsWithoutVectors('github:large/n')).toEqual([]);
  });

  it('rejects inconsistent cached dimensions before creating the vector table', async () => {
    const inputHash = createHash('sha256').update(`a.ts\n${FILE_A}`).digest('hex');
    db.raw
      .prepare(`insert into embedding_cache (model, input_hash, dimension, embedding) values (?, ?, ?, ?)`)
      .run('unknown-dimension', inputHash, 2, Buffer.from(new Float32Array([1, 2]).buffer));
    const embeddings: EmbeddingProvider = {
      model: 'unknown-dimension',
      dimension: null,
      async embed(texts) { return texts.map(() => [1, 0, 0, 0]); },
    };

    await expect(indexRepo({ db, checkout, repoId: REPO_ID, embeddings })).rejects.toThrow(/dimensions differ/);
    expect(db.vectorDimension).toBeNull();
    expect(db.chunkIdsWithoutVectors(REPO_ID)).not.toEqual([]);
  });

  it('leaves chunks unvectored when cache persistence fails', async () => {
    db.insertEmbeddingCache = () => { throw new Error('cache write failed'); };

    await expect(indexRepo({ db, checkout, repoId: REPO_ID, embeddings: fakeEmbeddings('cache-failure') })).rejects.toThrow(/cache write failed/);
    expect(db.chunkIdsWithoutVectors(REPO_ID)).not.toEqual([]);
  });

  it('rejects sparse provider vectors before writing cache or vectors', async () => {
    const embeddings: EmbeddingProvider = {
      model: 'sparse-vectors',
      dimension: null,
      async embed(texts) { return texts.map(() => new Array(4)); },
    };

    await expect(indexRepo({ db, checkout, repoId: REPO_ID, embeddings })).rejects.toThrow(/inconsistent/);
    expect(db.vectorDimension).toBeNull();
    expect(db.chunkIdsWithoutVectors(REPO_ID)).not.toEqual([]);
    expect(db.raw.prepare(`select count(*) as n from embedding_cache`).get()).toEqual({ n: 0 });
  });

  it('re-chunks only the modified file', async () => {
    await indexRepo({ db, checkout, repoId: REPO_ID, embeddings: fakeEmbeddings() });
    const bBefore = db.getChunksForPath(REPO_ID, 'b.ts').map((c) => c.id);
    const aBefore = db.getChunksForPath(REPO_ID, 'a.ts').map((c) => c.id);

    writeFileSync(join(repoDir, 'a.ts'), FILE_A.replace('return 1;', 'return 42;'));
    await commitAll(repoDir, 'two');

    const res = await indexRepo({ db, checkout, repoId: REPO_ID, embeddings: fakeEmbeddings() });
    expect(res.skipped).toBe(1);
    expect(res.files).toBe(1);
    expect(db.getChunksForPath(REPO_ID, 'b.ts').map((c) => c.id)).toEqual(bBefore);
    expect(db.getChunksForPath(REPO_ID, 'a.ts').map((c) => c.id)).not.toEqual(aBefore);
    expect(db.getChunksForPath(REPO_ID, 'a.ts')[0].content).toContain('return 42;');
    expect(db.chunkIdsWithoutVectors(REPO_ID)).toEqual([]);
  });

  it('removes files deleted from the repo', async () => {
    await indexRepo({ db, checkout, repoId: REPO_ID, embeddings: fakeEmbeddings() });
    unlinkSync(join(repoDir, 'b.ts'));
    await commitAll(repoDir, 'three');

    const res = await indexRepo({ db, checkout, repoId: REPO_ID, embeddings: fakeEmbeddings() });
    expect(res.removed).toBe(1);
    expect(db.getFile(REPO_ID, 'b.ts')).toBeUndefined();
    expect(db.getChunksForPath(REPO_ID, 'b.ts')).toEqual([]);
    expect(db.listFiles(REPO_ID).map((f) => f.path)).toEqual(['a.ts']);
  });

  it('reads content from the working tree instead of one git process per file', async () => {
    let blobReads = 0;
    const readBlob = checkout.readBlob.bind(checkout);
    checkout.readBlob = async (hash: string) => {
      blobReads++;
      return readBlob(hash);
    };
    const res = await indexRepo({ db, checkout, repoId: REPO_ID });
    expect(res.files).toBe(2);
    expect(blobReads).toBe(0);
  });

  it('falls back to the object database when a tracked file is absent from the working tree', async () => {
    // tracked in HEAD but deleted on disk (a partial or sparse checkout)
    unlinkSync(join(repoDir, 'b.ts'));
    const res = await indexRepo({ db, checkout, repoId: REPO_ID });
    expect(res.files).toBe(2);
    expect(db.getChunksForPath(REPO_ID, 'b.ts')[0].content).toContain('beta');
  });

  it('works without an embedding provider', async () => {
    const res = await indexRepo({ db, checkout, repoId: REPO_ID });
    expect(res.files).toBe(2);
    expect(res.chunks).toBeGreaterThan(0);
    expect(db.vectorDimension).toBeNull();
  });

  it('reports progress and marks the repo as errored on failure', async () => {
    const messages: string[] = [];
    const broken = new RepoCheckout({
      dir: repoDir,
      url: 'x',
      git: async () => {
        throw new Error('boom');
      },
    });
    await expect(indexRepo({ db, checkout: broken, repoId: REPO_ID, onProgress: (m) => messages.push(m) })).rejects.toThrow(/boom/);
    const repo = db.getRepo(REPO_ID)!;
    expect(repo.status).toBe('error');
    expect(repo.error).toContain('boom');

    await indexRepo({ db, checkout, repoId: REPO_ID, embeddings: fakeEmbeddings(), onProgress: (m) => messages.push(m) });
    expect(messages.length).toBeGreaterThan(0);
    expect(db.getRepo(REPO_ID)!.status).toBe('ready');
  });
});
