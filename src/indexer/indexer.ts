import { createHash } from 'node:crypto';
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

  const remote: Array<{ chunkId: number; text: string; inputHash: string }> = [];
  const deferredCacheHits: Array<Array<{ chunkId: number; inputHash: string }>> = [];
  const expectedDim = embeddings.dimension ?? db.vectorDimension;
  let cacheDim = expectedDim;
  for (let offset = 0; offset < work.length; offset += EMBED_BATCH) {
    const batch = work.slice(offset, offset + EMBED_BATCH);
    const hashes = batch.map((b) => embeddingInputHash(b.text));
    const cached = db.getEmbeddingCache(embeddings.model, hashes);
    const hits: Array<{ chunkId: number; inputHash: string; embedding: number[] }> = [];
    for (let i = 0; i < batch.length; i++) {
      const entry = cached.get(hashes[i]);
      if (entry && cacheDim === null) cacheDim = entry.embedding.length;
      if (entry && isValidVector(entry.embedding, cacheDim)) {
        hits.push({ chunkId: batch[i].chunkId, inputHash: hashes[i], embedding: entry.embedding });
      } else {
        remote.push({ chunkId: batch[i].chunkId, text: batch[i].text, inputHash: hashes[i] });
      }
    }
    if (hits.length > 0) {
      if (expectedDim !== null) {
        db.ensureVecTable(expectedDim);
        db.insertVectors(hits.map(({ chunkId, embedding }) => ({ chunkId, repoId, embedding })));
      } else {
        deferredCacheHits.push(hits.map(({ chunkId, inputHash }) => ({ chunkId, inputHash })));
      }
    }
  }
  if (remote.length === 0) {
    if (deferredCacheHits.length > 0) {
      const dim = db.getEmbeddingCache(embeddings.model, deferredCacheHits[0].map((h) => h.inputHash)).values().next().value?.embedding.length;
      if (!dim) throw new Error('Embedding provider returned empty vectors');
      db.ensureVecTable(dim);
      for (const refs of deferredCacheHits) {
        const cached = db.getEmbeddingCache(embeddings.model, refs.map((h) => h.inputHash));
        db.insertVectors(refs.map(({ chunkId, inputHash }) => ({ chunkId, repoId, embedding: cached.get(inputHash)!.embedding })));
      }
    }
    progress(`Embedded ${work.length}/${work.length} chunks`);
    return;
  }

  let completed = work.length - remote.length;
  for (let offset = 0; offset < remote.length; offset += EMBED_BATCH) {
    const batch = remote.slice(offset, offset + EMBED_BATCH);
    const inputs = batch.map((b) => b.text);
    let batchDim = embeddings.dimension ?? db.vectorDimension;
    const vectors = await embeddings.embed(inputs);
    if (vectors.length !== inputs.length) {
      throw new Error(`Embedding provider returned ${vectors.length} vectors for ${inputs.length} inputs`);
    }
    const providerDim = vectors[0]?.length ?? 0;
    if (!providerDim) throw new Error('Embedding provider returned empty vectors');
    if (batchDim !== null && batchDim !== providerDim) {
      throw new Error(`Embedding dimensions differ within a batch: cached ${batchDim}, provider ${providerDim}`);
    }
    batchDim ??= providerDim;
    for (const vector of vectors) {
      if (!isValidVector(vector, batchDim)) throw new Error('Embedding provider returned vectors with inconsistent dimensions');
    }
    const cacheRows: Array<{ inputHash: string; embedding: number[] }> = [];
    vectors.forEach((embedding, i) => cacheRows.push({ inputHash: batch[i].inputHash, embedding }));
    for (const refs of deferredCacheHits) {
      const cached = db.getEmbeddingCache(embeddings.model, refs.map((h) => h.inputHash));
      for (const { inputHash } of refs) {
        const embedding = cached.get(inputHash)?.embedding;
        if (!isValidVector(embedding, batchDim)) {
          throw new Error(`Embedding dimensions differ within a batch: cached ${cached.get(inputHash)?.dimension ?? 0}, provider ${batchDim}`);
        }
      }
    }
    db.ensureVecTable(batchDim);
    db.insertEmbeddingCache(embeddings.model, cacheRows);
    for (const refs of deferredCacheHits) {
      const cached = db.getEmbeddingCache(embeddings.model, refs.map((h) => h.inputHash));
      db.insertVectors(refs.map(({ chunkId, inputHash }) => ({ chunkId, repoId, embedding: cached.get(inputHash)!.embedding })));
    }
    db.insertVectors(batch.map((item, i) => ({ chunkId: item.chunkId, repoId, embedding: vectors[i] })));
    deferredCacheHits.length = 0;
    completed += batch.length;
    progress(`Embedded ${completed}/${work.length} chunks`);
  }
}

function embeddingInputHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function isValidVector(vector: number[] | undefined, expectedDim: number | null): vector is number[] {
  return vector !== undefined && vector.length > 0 && (expectedDim === null || vector.length === expectedDim) && Array.from(vector).every((n) => typeof n === 'number' && Number.isFinite(n));
}
