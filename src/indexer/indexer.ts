import type { Db } from '../db.js';
import type { EmbeddingProvider } from '../embeddings/types.js';
import type { RepoCheckout } from './git.js';
import { chunkFile } from './chunker.js';
import { detectLanguage, shouldIndex } from './language.js';

export interface IndexOptions {
  db: Db;
  checkout: RepoCheckout;
  repoId: string;
  /** When omitted or null the repo is indexed without vectors (lexical search only). */
  embeddings?: EmbeddingProvider | null;
  onProgress?: (msg: string) => void;
  /** Optional ref to check out before indexing. */
  ref?: string;
}

export interface IndexResult {
  /** Files chunked during this run (unchanged files are counted under `skipped`). */
  files: number;
  /** Chunks in the repository after this run. */
  chunks: number;
  skipped: number;
  removed: number;
  commit: string;
}

const EMBED_BATCH = 64;

interface PendingEmbedding {
  chunkId: number;
  text: string;
}

/** Incrementally index a checked-out repository into the database. */
export async function indexRepo(opts: IndexOptions): Promise<IndexResult> {
  const { db, checkout, repoId, embeddings = null } = opts;
  const progress = opts.onProgress ?? (() => {});

  db.setRepoStatus(repoId, 'indexing');
  try {
    if (opts.ref) {
      progress(`Checking out ${opts.ref}`);
      await checkout.checkout(opts.ref);
    }
    const commit = await checkout.headSha();
    progress(`Listing files at ${commit.slice(0, 8)}`);

    const entries = (await checkout.listFiles()).filter((e) => shouldIndex(e.path, e.size));
    const existing = new Map(db.listFiles(repoId).map((f) => [f.path, f]));

    let indexed = 0;
    let skipped = 0;
    let removed = 0;
    const pending: PendingEmbedding[] = [];

    for (const entry of entries) {
      const prior = existing.get(entry.path);
      existing.delete(entry.path);
      if (prior && prior.blob_hash === entry.blobHash) {
        skipped++;
        continue;
      }

      const text = await readEntry(checkout, entry.path, entry.blobHash);
      if (text.includes('\0')) {
        // Binary content that slipped past the extension filter.
        if (prior) {
          db.deleteFile(repoId, entry.path);
          removed++;
        }
        continue;
      }

      const chunks = chunkFile(entry.path, text);
      if (prior) db.deleteFile(repoId, entry.path);
      const file = db.upsertFile({
        repo_id: repoId,
        path: entry.path,
        blob_hash: entry.blobHash,
        language: detectLanguage(entry.path),
        size: entry.size,
      });
      if (chunks.length > 0) {
        const ids = db.insertChunks(
          chunks.map((c) => ({
            fileId: file.id,
            repoId,
            path: c.path,
            startLine: c.startLine,
            endLine: c.endLine,
            content: c.content,
          })),
        );
        ids.forEach((id, i) => pending.push({ chunkId: id, text: `${chunks[i].path}\n${chunks[i].content}` }));
      }
      indexed++;
      if (indexed % 50 === 0) progress(`Indexed ${indexed}/${entries.length} files`);
    }

    // Anything left in `existing` is no longer present in the tree.
    for (const path of existing.keys()) {
      db.deleteFile(repoId, path);
      removed++;
    }

    if (embeddings) {
      await embedPending(db, repoId, embeddings, pending, progress);
    }

    const fileCount = db.listFiles(repoId).length;
    const chunkCount = db.countChunks(repoId);
    db.setRepoStatus(repoId, 'ready', {
      last_commit: commit,
      indexed_at: new Date().toISOString(),
      file_count: fileCount,
      chunk_count: chunkCount,
    });
    progress(`Indexed ${indexed} file(s), skipped ${skipped}, removed ${removed}, ${chunkCount} chunks`);

    return { files: indexed, chunks: chunkCount, skipped, removed, commit };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.setRepoStatus(repoId, 'error', { error: message });
    throw err;
  }
}

/**
 * Read a tree entry from the working tree, which is already checked out at the ref
 * being indexed. Falls back to the object database when the file is absent (a
 * sparse or partial checkout), avoiding one `git cat-file` subprocess per file.
 */
async function readEntry(checkout: RepoCheckout, path: string, blobHash: string): Promise<string> {
  try {
    return await checkout.readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    return checkout.readBlob(blobHash);
  }
}

/** Embed the freshly written chunks plus any chunk in the repo still missing a vector. */
async function embedPending(
  db: Db,
  repoId: string,
  embeddings: EmbeddingProvider,
  pending: PendingEmbedding[],
  progress: (msg: string) => void,
): Promise<void> {
  const seen = new Set(pending.map((p) => p.chunkId));
  const work = [...pending];
  for (const id of db.chunkIdsWithoutVectors(repoId)) {
    if (seen.has(id)) continue;
    const chunk = db.getChunk(id);
    if (!chunk) continue;
    seen.add(id);
    work.push({ chunkId: id, text: `${chunk.path}\n${chunk.content}` });
  }
  if (work.length === 0) return;

  for (let i = 0; i < work.length; i += EMBED_BATCH) {
    const batch = work.slice(i, i + EMBED_BATCH);
    const vectors = await embeddings.embed(batch.map((b) => b.text));
    if (vectors.length !== batch.length) {
      throw new Error(`Embedding provider returned ${vectors.length} vectors for ${batch.length} inputs`);
    }
    const dim = vectors[0]?.length ?? 0;
    if (!dim) throw new Error('Embedding provider returned empty vectors');
    db.ensureVecTable(dim);
    db.insertVectors(batch.map((b, j) => ({ chunkId: b.chunkId, repoId, embedding: vectors[j] })));
    progress(`Embedded ${Math.min(i + batch.length, work.length)}/${work.length} chunks`);
  }
}
