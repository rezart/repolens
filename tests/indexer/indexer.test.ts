import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

function fakeEmbeddings(): EmbeddingProvider & { calls: number } {
  return {
    model: 'fake',
    dimension: 4,
    calls: 0,
    async embed(texts: string[]) {
      this.calls++;
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
