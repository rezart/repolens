import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { UsageRole } from './usage/types.js';

export type RepoStatus = 'queued' | 'indexing' | 'ready' | 'error';
export type JobKind = 'index' | 'review';
export type JobStatus = 'queued' | 'running' | 'done' | 'error';

export interface RepoRow {
  id: string; // github:owner/name
  remote: string; // clone url
  owner: string;
  name: string;
  branch: string;
  status: RepoStatus;
  last_commit: string | null;
  indexed_at: string | null;
  error: string | null;
  instructions: string | null;
  review_context_generation: number;
  file_count: number;
  chunk_count: number;
  created_at: string;
}

export interface FileRow {
  id: number;
  repo_id: string;
  path: string;
  blob_hash: string;
  language: string | null;
  size: number;
}

export interface ChunkRow {
  id: number;
  file_id: number;
  repo_id: string;
  path: string;
  start_line: number;
  end_line: number;
  content: string;
  summary: string | null;
}

export interface ChunkInput {
  fileId: number;
  repoId: string;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  summary?: string | null;
}

export interface SearchHit {
  chunk: ChunkRow;
  score: number;
}

export interface ReviewRow {
  id: number;
  repo_id: string;
  pr_number: number;
  head_sha: string;
  status: 'done' | 'error';
  provider: string | null;
  model: string | null;
  cost_usd: number | null;
  summary: string | null;
  verdict: string | null;
  comments_json: string;
  posted: number;
  error: string | null;
  completion_json?: string | null;
  compatibility_key?: string | null;
  base_sha?: string | null;
  created_at: string;
}

export interface JobRow {
  id: number;
  kind: JobKind;
  repo_id: string | null;
  pr_number: number | null;
  status: JobStatus;
  progress: string | null;
  error: string | null;
  result_json: string | null;
  created_at: string;
  updated_at: string;
}

export type ReviewCheckpointState = 'active' | 'ready' | 'finalized' | 'invalidated' | 'blocked';
export interface ReviewCheckpointRow {
  id: string;
  repo_id: string;
  pr_number: number;
  head_sha: string;
  base_sha: string;
  compatibility_key: string;
  payload_version: number;
  state: ReviewCheckpointState;
  owner_token: string | null;
  owner_job_id: number | null;
  generation: number;
  inputs_json: string | null;
  progress_json: string | null;
  payload_hash: string | null;
  review_id: number | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
}
export type ReviewCallAttemptState = 'started' | 'settled' | 'interrupted';
export interface ReviewCallAttemptRow {
  id: string;
  checkpoint_id: string;
  job_id: number | null;
  unit_key: string;
  attempt_ordinal: number;
  provider: string;
  model: string;
  stage: string;
  pass: string;
  request_hash: string;
  estimated_usd: number;
  budgeted: number;
  state: ReviewCallAttemptState;
  outcome: string | null;
  error_class: string | null;
  validation_error: string | null;
  error_status: number | null;
  usage_reported: number;
  usage_complete: number;
  cost_usd: number | null;
  reservation_usd: number;
  elapsed_ms: number | null;
  started_at: string;
  settled_at: string | null;
}

export interface ReviewCheckpointInput {
  id: string;
  repo_id: string;
  pr_number: number;
  head_sha: string;
  base_sha: string;
  compatibility_key: string;
  payload_version: number;
  inputs_json?: string | null;
  progress_json?: string | null;
  payload_hash?: string | null;
}
export interface ReviewCallAttemptInput {
  id: string;
  checkpoint_id: string;
  job_id?: number | null;
  unit_key: string;
  attempt_ordinal: number;
  provider: string;
  model: string;
  stage: string;
  pass: string;
  request_hash: string;
  estimated_usd: number;
  budgeted: number;
  reservation_usd: number;
}

/** One backend call, as written by UsageTracker. */
export interface UsageInsert {
  role: UsageRole;
  provider: string;
  model: string;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  review_attempt_id?: string | null;
  review_usage_seq?: number | null;
}

/**
 * One UTC day of calls for a role/provider/model. The `unpriced_*` sums cover
 * only the calls whose backend reported no cost, so a list-price estimate can be
 * added to `reported_cost_usd` without double counting.
 */
export interface UsageDayRow {
  day: string;
  role: string;
  provider: string;
  model: string;
  calls: number;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  reported_cost_usd: number;
  unpriced_input_tokens: number;
  unpriced_cached_input_tokens: number;
  unpriced_cache_write_tokens: number;
  unpriced_output_tokens: number;
  unpriced_calls: number;
}

const SCHEMA = `
create table if not exists repos (
  id text primary key,
  remote text not null,
  owner text not null,
  name text not null,
  branch text not null,
  status text not null default 'queued',
  last_commit text,
  indexed_at text,
  error text,
  instructions text,
  review_context_generation integer not null default 0,
  file_count integer not null default 0,
  chunk_count integer not null default 0,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create table if not exists files (
  id integer primary key autoincrement,
  repo_id text not null references repos(id) on delete cascade,
  path text not null,
  blob_hash text not null,
  language text,
  size integer not null default 0,
  unique(repo_id, path)
);
create table if not exists chunks (
  id integer primary key autoincrement,
  file_id integer not null references files(id) on delete cascade,
  repo_id text not null,
  path text not null,
  start_line integer not null,
  end_line integer not null,
  content text not null,
  summary text
);
create index if not exists chunks_repo on chunks(repo_id);
create index if not exists chunks_file on chunks(file_id);
create virtual table if not exists chunks_fts using fts5(
  content, path, repo_id unindexed,
  content='chunks', content_rowid='id',
  tokenize="unicode61 tokenchars '_'"
);
create trigger if not exists chunks_ai after insert on chunks begin
  insert into chunks_fts(rowid, content, path, repo_id) values (new.id, new.content, new.path, new.repo_id);
end;
create trigger if not exists chunks_ad after delete on chunks begin
  insert into chunks_fts(chunks_fts, rowid, content, path, repo_id) values ('delete', old.id, old.content, old.path, old.repo_id);
end;
create table if not exists reviews (
  id integer primary key autoincrement,
  repo_id text not null,
  pr_number integer not null,
  head_sha text not null,
  status text not null,
  cost_usd real,
  summary text,
  verdict text,
  comments_json text not null default '[]',
  posted integer not null default 0,
  error text,
  completion_json text,
  compatibility_key text,
  base_sha text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index if not exists reviews_repo on reviews(repo_id, pr_number);
create table if not exists review_checkpoints (
  id text primary key,
  repo_id text not null references repos(id) on delete cascade,
  pr_number integer not null,
  head_sha text not null,
  base_sha text not null,
  compatibility_key text not null,
  payload_version integer not null,
  state text not null check(state in ('active','ready','finalized','invalidated','blocked')),
  owner_token text,
  owner_job_id integer references jobs(id) on delete set null,
  generation integer not null default 0,
  inputs_json text,
  progress_json text,
  payload_hash text,
  review_id integer references reviews(id) on delete set null,
  last_error_code text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create unique index if not exists review_checkpoints_open on review_checkpoints(repo_id, pr_number) where state in ('active','ready','blocked');
create index if not exists review_checkpoints_state on review_checkpoints(state, updated_at);
create table if not exists review_call_attempts (
  id text primary key,
  checkpoint_id text not null references review_checkpoints(id) on delete cascade,
  job_id integer references jobs(id) on delete set null,
  unit_key text not null,
  attempt_ordinal integer not null,
  provider text not null,
  model text not null,
  stage text not null,
  pass text not null,
  request_hash text not null,
  estimated_usd real not null,
  budgeted integer not null,
  state text not null check(state in ('started','settled','interrupted')),
  outcome text,
  error_class text,
  validation_error text,
  error_status integer,
  usage_reported integer not null default 0,
  usage_complete integer not null default 0,
  cost_usd real,
  reservation_usd real not null,
  elapsed_ms integer,
  started_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  settled_at text,
  unique(checkpoint_id, unit_key, attempt_ordinal)
);
create index if not exists review_call_attempts_checkpoint on review_call_attempts(checkpoint_id);
create table if not exists jobs (
  id integer primary key autoincrement,
  kind text not null,
  repo_id text,
  pr_number integer,
  status text not null default 'queued',
  progress text,
  error text,
  result_json text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create table if not exists meta (key text primary key, value text not null);
create table if not exists llm_usage (
  id integer primary key autoincrement,
  ts text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  role text not null,
  provider text not null,
  model text not null,
  input_tokens integer not null default 0,
  cached_input_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd real,
  review_attempt_id text,
  review_usage_seq integer
);
create index if not exists llm_usage_ts on llm_usage(ts);
create unique index if not exists review_usage_unique on llm_usage(review_attempt_id, review_usage_seq) where review_attempt_id is not null and review_usage_seq is not null;
create table if not exists embedding_cache (
  model text not null,
  input_hash text not null,
  dimension integer not null,
  embedding blob not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  primary key (model, input_hash)
);
`;

export class Db {
  readonly raw: Database.Database;
  private vecDim: number | null = null;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new Database(path);
    sqliteVec.load(this.raw);
    this.raw.pragma('journal_mode = WAL');
    this.raw.pragma('foreign_keys = ON');
    this.raw.exec(SCHEMA);
    migrate(this.raw);
    const dim = this.getMeta('vec_dim');
    if (dim) this.vecDim = Number(dim);
  }

  close() {
    this.raw.close();
  }

  // ---- repos ----
  upsertRepo(r: Pick<RepoRow, 'id' | 'remote' | 'owner' | 'name' | 'branch'> & Partial<RepoRow>): RepoRow {
    this.raw
      .prepare(
        `insert into repos (id, remote, owner, name, branch, status, instructions)
         values (@id, @remote, @owner, @name, @branch, @status, @instructions)
         on conflict(id) do update set remote=excluded.remote, branch=excluded.branch,
           instructions=coalesce(excluded.instructions, repos.instructions)`,
      )
      .run({ status: 'queued', instructions: null, ...r });
    return this.getRepo(r.id)!;
  }

  getRepo(id: string): RepoRow | undefined {
    return this.raw.prepare(`select * from repos where id=?`).get(id) as RepoRow | undefined;
  }

  listRepos(): RepoRow[] {
    return this.raw.prepare(`select * from repos order by created_at desc`).all() as RepoRow[];
  }

  deleteRepo(id: string) {
    const tx = this.raw.transaction(() => {
      if (this.vecDim) this.raw.prepare(`delete from chunk_vec where repo_id=?`).run(id);
      this.raw.prepare(`delete from chunks where repo_id=?`).run(id);
      this.raw.prepare(`delete from files where repo_id=?`).run(id);
      this.raw.prepare(`delete from reviews where repo_id=?`).run(id);
      this.raw.prepare(`delete from repos where id=?`).run(id);
    });
    tx();
  }

  setRepoStatus(id: string, status: RepoStatus, extra: Partial<Pick<RepoRow, 'error' | 'last_commit' | 'indexed_at' | 'file_count' | 'chunk_count'>> = {}) {
    const sets = ['status=@status', 'error=@error'];
    const params: Record<string, unknown> = { id, status, error: extra.error ?? null };
    for (const k of ['last_commit', 'indexed_at', 'file_count', 'chunk_count'] as const) {
      if (extra[k] !== undefined) {
        sets.push(`${k}=@${k}`);
        params[k] = extra[k];
      }
    }
    this.raw.prepare(`update repos set ${sets.join(', ')} where id=@id`).run(params);
  }

  /** Record the branch once it is known (rows start with `''` for "the remote default"). */
  setRepoBranch(id: string, branch: string) {
    this.raw.prepare(`update repos set branch=? where id=?`).run(branch, id);
  }

  setRepoInstructions(id: string, instructions: string | null) {
    this.raw.prepare(`update repos set instructions=? where id=?`).run(instructions, id);
  }

  // ---- files ----
  listFiles(repoId: string): FileRow[] {
    return this.raw.prepare(`select * from files where repo_id=?`).all(repoId) as FileRow[];
  }

  getFile(repoId: string, path: string): FileRow | undefined {
    return this.raw.prepare(`select * from files where repo_id=? and path=?`).get(repoId, path) as FileRow | undefined;
  }

  upsertFile(f: Omit<FileRow, 'id'>): FileRow {
    this.raw
      .prepare(
        `insert into files (repo_id, path, blob_hash, language, size) values (@repo_id, @path, @blob_hash, @language, @size)
         on conflict(repo_id, path) do update set blob_hash=excluded.blob_hash, language=excluded.language, size=excluded.size`,
      )
      .run(f);
    return this.getFile(f.repo_id, f.path)!;
  }

  /** Remove a file and its chunks, FTS rows and vectors. */
  deleteFile(repoId: string, path: string) {
    const tx = this.raw.transaction(() => {
      const file = this.getFile(repoId, path);
      if (!file) return;
      if (this.vecDim) {
        this.raw.prepare(`delete from chunk_vec where chunk_id in (select id from chunks where file_id=?)`).run(file.id);
      }
      this.raw.prepare(`delete from chunks where file_id=?`).run(file.id);
      this.raw.prepare(`delete from files where id=?`).run(file.id);
    });
    tx();
  }

  // ---- chunks ----
  insertChunks(chunks: ChunkInput[]): number[] {
    const stmt = this.raw.prepare(
      `insert into chunks (file_id, repo_id, path, start_line, end_line, content, summary)
       values (@fileId, @repoId, @path, @startLine, @endLine, @content, @summary)`,
    );
    const ids: number[] = [];
    const tx = this.raw.transaction((rows: ChunkInput[]) => {
      for (const c of rows) {
        const res = stmt.run({ summary: null, ...c });
        ids.push(Number(res.lastInsertRowid));
      }
    });
    tx(chunks);
    return ids;
  }

  getChunk(id: number): ChunkRow | undefined {
    return this.raw.prepare(`select * from chunks where id=?`).get(id) as ChunkRow | undefined;
  }

  getChunksForPath(repoId: string, path: string): ChunkRow[] {
    return this.raw.prepare(`select * from chunks where repo_id=? and path=? order by start_line`).all(repoId, path) as ChunkRow[];
  }

  countChunks(repoId: string): number {
    return (this.raw.prepare(`select count(*) c from chunks where repo_id=?`).get(repoId) as { c: number }).c;
  }

  // ---- search ----
  /** BM25 search. `ftsQuery` must already be valid FTS5 syntax (see search/tokenize.ts). */
  ftsSearch(repoIds: string[], ftsQuery: string, limit: number): SearchHit[] {
    if (repoIds.length === 0 || !ftsQuery.trim()) return [];
    const placeholders = repoIds.map(() => '?').join(',');
    const rows = this.raw
      .prepare(
        `select c.*, bm25(chunks_fts, 1.0, 2.0) as rank
         from chunks_fts join chunks c on c.id = chunks_fts.rowid
         where chunks_fts match ? and c.repo_id in (${placeholders})
         order by rank limit ?`,
      )
      .all(ftsQuery, ...repoIds, limit) as Array<ChunkRow & { rank: number }>;
    return rows.map(({ rank, ...chunk }) => ({ chunk, score: -rank }));
  }

  get vectorDimension(): number | null {
    return this.vecDim;
  }

  ensureVecTable(dim: number) {
    if (this.vecDim === dim) return;
    if (this.vecDim !== null && this.vecDim !== dim) {
      throw new Error(`Vector table already has dimension ${this.vecDim}; got ${dim}. Delete the database or keep the same embedding model.`);
    }
    this.raw.exec(
      `create virtual table if not exists chunk_vec using vec0(
         chunk_id integer primary key,
         repo_id text partition key,
         embedding float[${dim}]
       )`,
    );
    this.setMeta('vec_dim', String(dim));
    this.vecDim = dim;
  }

  insertVectors(rows: Array<{ chunkId: number; repoId: string; embedding: number[] }>) {
    if (!this.vecDim) throw new Error('ensureVecTable() must be called before insertVectors()');
    const stmt = this.raw.prepare(`insert or replace into chunk_vec (chunk_id, repo_id, embedding) values (?, ?, ?)`);
    const tx = this.raw.transaction((items: typeof rows) => {
      for (const r of items) {
        if (!isDenseFiniteVector(r.embedding)) throw new Error('Cannot insert an invalid embedding');
        stmt.run(BigInt(r.chunkId), r.repoId, new Float32Array(r.embedding));
      }
    });
    tx(rows);
  }

  getEmbeddingCache(model: string, inputHashes: string[]): Map<string, { dimension: number; embedding: number[] }> {
    if (inputHashes.length === 0) return new Map();
    const placeholders = inputHashes.map(() => '?').join(',');
    const rows = this.raw
      .prepare(`select input_hash, dimension, embedding from embedding_cache where model=? and input_hash in (${placeholders})`)
      .all(model, ...inputHashes) as Array<{ input_hash: string; dimension: number; embedding: Buffer }>;
    const result = new Map<string, { dimension: number; embedding: number[] }>();
    for (const row of rows) {
      if (!Number.isInteger(row.dimension) || row.dimension <= 0 || !Buffer.isBuffer(row.embedding)) continue;
      if (row.embedding.byteLength !== row.dimension * Float32Array.BYTES_PER_ELEMENT) continue;
      const view = new DataView(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength);
      const embedding = Array.from({ length: row.dimension }, (_, i) => view.getFloat32(i * Float32Array.BYTES_PER_ELEMENT, true));
      if (!isDenseFiniteVector(embedding)) continue;
      result.set(row.input_hash, { dimension: row.dimension, embedding });
    }
    return result;
  }

  insertEmbeddingCache(model: string, rows: Array<{ inputHash: string; embedding: number[] }>) {
    if (rows.length === 0) return;
    const stmt = this.raw.prepare(
      `insert or replace into embedding_cache (model, input_hash, dimension, embedding) values (?, ?, ?, ?)`,
    );
    const tx = this.raw.transaction((items: typeof rows) => {
      for (const row of items) {
        if (!isDenseFiniteVector(row.embedding)) {
          throw new Error('Cannot cache an invalid embedding');
        }
        const vector = new Float32Array(row.embedding);
        if (!isDenseFiniteVector(vector)) throw new Error('Cannot cache an invalid embedding');
        stmt.run(model, row.inputHash, vector.length, Buffer.from(vector.buffer));
      }
    });
    tx(rows);
  }

  vecSearch(repoIds: string[], embedding: number[], limit: number): SearchHit[] {
    if (!this.vecDim || repoIds.length === 0) return [];
    const placeholders = repoIds.map(() => '?').join(',');
    const rows = this.raw.prepare(`select v.chunk_id as chunk_id, v.distance as distance from chunk_vec v where v.embedding match ? and k = ? and v.repo_id in (${placeholders})`).all(new Float32Array(embedding), limit, ...repoIds) as Array<{ chunk_id: number | bigint; distance: number }>;
    const hits: SearchHit[] = [];
    for (const r of rows) {
      const chunk = this.getChunk(Number(r.chunk_id));
      if (chunk) hits.push({ chunk, score: 1 / (1 + r.distance) });
    }
    return hits;
  }

  /** Chunk ids in a repo that have no vector yet (used to backfill embeddings). */
  chunkIdsWithoutVectors(repoId: string): number[] {
    if (!this.vecDim) return (this.raw.prepare(`select id from chunks where repo_id=?`).all(repoId) as { id: number }[]).map((r) => r.id);
    return (this.raw.prepare(`select id from chunks where repo_id=? and id not in (select chunk_id from chunk_vec where repo_id=?)`).all(repoId, repoId) as { id: number }[]).map((r) => r.id);
  }
  bumpReviewContextGeneration(repoId: string): number {
    this.raw.prepare(`update repos set review_context_generation=review_context_generation+1 where id=?`).run(repoId);
    const row = this.raw.prepare(`select review_context_generation from repos where id=?`).get(repoId) as { review_context_generation: number } | undefined;
    if (!row) throw new Error(`repository not found: ${repoId}`);
    return row.review_context_generation;
  }

  // ---- reviews ----
  insertReview(r: Omit<ReviewRow, 'id' | 'created_at' | 'cost_usd' | 'provider' | 'model' | 'completion_json' | 'compatibility_key' | 'base_sha'> & { cost_usd?: number | null; provider?: string | null; model?: string | null; completion_json?: string | null; compatibility_key?: string | null; base_sha?: string | null }): ReviewRow {
    const res = this.raw.prepare(`insert into reviews (repo_id,pr_number,head_sha,status,summary,verdict,comments_json,posted,error,cost_usd,provider,model,completion_json,compatibility_key,base_sha) values (@repo_id,@pr_number,@head_sha,@status,@summary,@verdict,@comments_json,@posted,@error,@cost_usd,@provider,@model,@completion_json,@compatibility_key,@base_sha)`).run({ cost_usd: null, provider: null, model: null, completion_json: null, compatibility_key: null, base_sha: null, ...r });
    return this.getReview(Number(res.lastInsertRowid))!;
  }

  // ---- durable review execution ----
  getReviewCheckpoint(id: string): ReviewCheckpointRow | undefined {
    return this.raw.prepare(`select * from review_checkpoints where id=?`).get(id) as ReviewCheckpointRow | undefined;
  }

  findOpenReviewCheckpoint(repoId: string, prNumber: number): ReviewCheckpointRow | undefined {
    return this.raw.prepare(`select * from review_checkpoints where repo_id=? and pr_number=? and state in ('active','ready','blocked') order by updated_at desc limit 1`).get(repoId, prNumber) as ReviewCheckpointRow | undefined;
  }

  createReviewCheckpoint(input: ReviewCheckpointInput): ReviewCheckpointRow {
    this.raw.prepare(`insert into review_checkpoints (id,repo_id,pr_number,head_sha,base_sha,compatibility_key,payload_version,state,inputs_json,progress_json,payload_hash) values (@id,@repo_id,@pr_number,@head_sha,@base_sha,@compatibility_key,@payload_version,'active',@inputs_json,@progress_json,@payload_hash)`).run({ inputs_json: null, progress_json: null, payload_hash: null, ...input });
    return this.getReviewCheckpoint(input.id)!;
  }

  /** Atomically claim an unowned checkpoint; a different owner never gets to overwrite it. */
  claimReviewCheckpoint(input: ReviewCheckpointInput, ownerToken: string, ownerJobId: number): { kind: 'claimed'; row: ReviewCheckpointRow } | { kind: 'busy'; jobId: number | null } | { kind: 'incompatible'; row: ReviewCheckpointRow } | { kind: 'blocked'; row: ReviewCheckpointRow } {
    const tx = this.raw.transaction(() => {
      let row = this.getReviewCheckpoint(input.id);
      if (!row) {
        try { row = this.createReviewCheckpoint(input); } catch (err) {
          if (!(err instanceof Error) || !String(err.message).includes('UNIQUE')) throw err;
          row = this.findOpenReviewCheckpoint(input.repo_id, input.pr_number);
        }
      }
      if (!row) throw new Error('checkpoint disappeared while claiming');
      if (row.head_sha !== input.head_sha || row.base_sha !== input.base_sha || row.compatibility_key !== input.compatibility_key || row.payload_version !== input.payload_version) return { kind: 'incompatible', row } as const;
      if (row.state === 'blocked') return { kind: 'blocked', row } as const;
      if (row.owner_token && row.owner_token !== ownerToken) return { kind: 'busy', jobId: row.owner_job_id } as const;
      this.raw.prepare(`update review_checkpoints set owner_token=?, owner_job_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') where id=?`).run(ownerToken, ownerJobId, row.id);
      return { kind: 'claimed', row: this.getReviewCheckpoint(row.id)! } as const;
    });
    return tx();
  }

  updateReviewCheckpoint(id: string, ownerToken: string, expectedGeneration: number, patch: Partial<Pick<ReviewCheckpointRow, 'state'|'inputs_json'|'progress_json'|'payload_hash'|'last_error_code'>>): ReviewCheckpointRow {
    const allowed = ['state', 'inputs_json', 'progress_json', 'payload_hash', 'last_error_code'] as const;
    const keys = allowed.filter((key) => patch[key] !== undefined);
    if (!keys.length) return this.getReviewCheckpoint(id)!;
    const sets = keys.map((key) => `${key}=@${key}`);
    sets.push('generation=generation+1', "updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    const params: Record<string, unknown> = { id, owner_token: ownerToken, generation: expectedGeneration };
    for (const key of keys) params[key] = patch[key];
    const result = this.raw.prepare(`update review_checkpoints set ${sets.join(',')} where id=@id and owner_token=@owner_token and generation=@generation`).run(params);
    if (result.changes !== 1) throw new Error('review checkpoint ownership conflict');
    return this.getReviewCheckpoint(id)!;
  }

  releaseReviewCheckpoint(id: string, ownerToken: string): boolean {
    return this.raw.prepare(`update review_checkpoints set owner_token=null, owner_job_id=null, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') where id=? and owner_token=?`).run(id, ownerToken).changes === 1;
  }

  invalidateReviewCheckpoint(id: string, ownerToken: string | null, expectedGeneration: number, reason: string): ReviewCheckpointRow {
    const ownerClause = ownerToken === null ? 'owner_token is null' : 'owner_token=@owner_token';
    const result = this.raw.prepare(`update review_checkpoints set state='invalidated', inputs_json=null, progress_json=null, last_error_code=@reason, generation=generation+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') where id=@id and generation=@generation and ${ownerClause}`).run({ id, generation: expectedGeneration, owner_token: ownerToken, reason });
    if (result.changes !== 1) throw new Error('review checkpoint ownership conflict');
    return this.getReviewCheckpoint(id)!;
  }

  reserveReviewCall(input: ReviewCallAttemptInput): ReviewCallAttemptRow {
    this.raw.prepare(`insert into review_call_attempts (id,checkpoint_id,job_id,unit_key,attempt_ordinal,provider,model,stage,pass,request_hash,estimated_usd,budgeted,state,reservation_usd) values (@id,@checkpoint_id,@job_id,@unit_key,@attempt_ordinal,@provider,@model,@stage,@pass,@request_hash,@estimated_usd,@budgeted,'started',@reservation_usd)`).run({ job_id: null, ...input });
    return this.getReviewCallAttempt(input.id)!;
  }

  getReviewCallAttempt(id: string): ReviewCallAttemptRow | undefined { return this.raw.prepare(`select * from review_call_attempts where id=?`).get(id) as ReviewCallAttemptRow | undefined; }
  listReviewCallAttempts(checkpointId: string): ReviewCallAttemptRow[] { return this.raw.prepare(`select * from review_call_attempts where checkpoint_id=? order by started_at,id`).all(checkpointId) as ReviewCallAttemptRow[]; }

  settleReviewCallAttempt(id: string, settlement: Pick<ReviewCallAttemptRow, 'state'|'outcome'|'error_class'|'validation_error'|'error_status'|'usage_complete'|'cost_usd'|'elapsed_ms'>): ReviewCallAttemptRow {
    this.raw.prepare(`update review_call_attempts set state=@state,outcome=@outcome,error_class=@error_class,validation_error=@validation_error,error_status=@error_status,usage_complete=@usage_complete,cost_usd=@cost_usd,elapsed_ms=@elapsed_ms,settled_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') where id=@id`).run({ id, ...settlement });
    return this.getReviewCallAttempt(id)!;
  }

  finalizeReviewCheckpoint(id: string, ownerToken: string, expectedGeneration: number, review: Omit<ReviewRow, 'id'|'created_at'|'completion_json'|'compatibility_key'|'base_sha'> & Pick<ReviewRow, 'completion_json'|'compatibility_key'|'base_sha'>): ReviewRow {
    const tx = this.raw.transaction(() => {
      const checkpoint = this.getReviewCheckpoint(id);
      if (!checkpoint) throw new Error('review checkpoint not found');
      if (checkpoint.state === 'finalized' && checkpoint.review_id) return this.getReview(checkpoint.review_id)!;
      const res = this.raw.prepare(`insert into reviews (repo_id,pr_number,head_sha,status,cost_usd,summary,verdict,comments_json,posted,error,completion_json,compatibility_key,base_sha,provider,model) values (@repo_id,@pr_number,@head_sha,@status,@cost_usd,@summary,@verdict,@comments_json,@posted,@error,@completion_json,@compatibility_key,@base_sha,@provider,@model)`).run(review);
      const reviewId = Number(res.lastInsertRowid);
      const update = this.raw.prepare(`update review_checkpoints set review_id=?,state='finalized',inputs_json=null,progress_json=null,owner_token=null,owner_job_id=null,generation=generation+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') where id=? and owner_token=? and generation=?`).run(reviewId,id,ownerToken,expectedGeneration);
      if (update.changes !== 1) throw new Error('review checkpoint ownership conflict');
      return this.getReview(reviewId)!;
    });
    return tx();
  }

  reserveReviewCalls(checkpointId: string, ownerToken: string, expectedGeneration: number, inputs: ReviewCallAttemptInput[], ceiling = Number.POSITIVE_INFINITY, heldFutureReserve = 0): ReviewCallAttemptRow[] {
    const tx = this.raw.transaction(() => {
      const checkpoint = this.getReviewCheckpoint(checkpointId);
      if (!checkpoint || checkpoint.owner_token !== ownerToken || checkpoint.generation !== expectedGeneration) throw new Error('review checkpoint ownership conflict');
      const existing = this.listReviewCallAttempts(checkpointId).reduce((sum, call) => sum + call.reservation_usd, 0);
      const requested = inputs.reduce((sum, call) => sum + call.reservation_usd, 0);
      if (existing + requested + heldFutureReserve > ceiling) throw new Error('review stage exceeds remaining budget');
      const rows = inputs.map((input) => this.reserveReviewCall({ ...input, checkpoint_id: checkpointId }));
      this.raw.prepare(`update review_checkpoints set generation=generation+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') where id=? and owner_token=? and generation=?`).run(checkpointId, ownerToken, expectedGeneration);
      return rows;
    });
    return tx();
  }

  recordReviewCallUsage(attemptId: string, seq: number, usage: UsageInsert): void {
    const tx = this.raw.transaction(() => {
      if (this.raw.prepare(`select id from llm_usage where review_attempt_id=? and review_usage_seq=?`).get(attemptId, seq)) return;
      this.raw.prepare(`insert into llm_usage (role,provider,model,input_tokens,cached_input_tokens,cache_write_tokens,output_tokens,cost_usd,review_attempt_id,review_usage_seq) values (@role,@provider,@model,@input_tokens,@cached_input_tokens,@cache_write_tokens,@output_tokens,@cost_usd,@attempt_id,@seq)`).run({ ...usage, attempt_id: attemptId, seq });
      this.raw.prepare(`update review_call_attempts set usage_reported=1 where id=?`).run(attemptId);
    });
    tx();
  }

  settleReviewCall(checkpointId: string, ownerToken: string, attemptId: string, settlement: Pick<ReviewCallAttemptRow, 'state'|'outcome'|'error_class'|'validation_error'|'error_status'|'usage_complete'|'cost_usd'|'elapsed_ms'>, progressJson?: string): ReviewCallAttemptRow {
    const tx = this.raw.transaction(() => {
      const checkpoint = this.getReviewCheckpoint(checkpointId);
      if (!checkpoint || checkpoint.owner_token !== ownerToken) throw new Error('review checkpoint ownership conflict');
      const attempt = this.getReviewCallAttempt(attemptId);
      if (!attempt || attempt.checkpoint_id !== checkpointId) throw new Error('review call attempt not found');
      if (progressJson !== undefined) validateReviewProgressJson(progressJson);
      const row = this.settleReviewCallAttempt(attemptId, settlement);
      if (settlement.state === 'settled' && settlement.cost_usd !== null && settlement.cost_usd !== undefined) {
        this.raw.prepare(`update review_call_attempts set reservation_usd=? where id=?`).run(settlement.cost_usd, attemptId);
      }
      if (progressJson !== undefined) this.raw.prepare(`update review_checkpoints set progress_json=?,generation=generation+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') where id=? and owner_token=?`).run(progressJson, checkpointId, ownerToken);
      return row;
    });
    return tx();
  }

  getReview(id: number): ReviewRow | undefined {
    return this.raw.prepare(`select * from reviews where id=?`).get(id) as ReviewRow | undefined;
  }

  findReview(repoId: string, prNumber: number, headSha: string): ReviewRow | undefined {
    return this.raw
      .prepare(`select * from reviews where repo_id=? and pr_number=? and head_sha=? and status='done' order by id desc limit 1`)
      .get(repoId, prNumber, headSha) as ReviewRow | undefined;
  }

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

  listReviews(repoId?: string, limit = 50, offset = 0): ReviewRow[] {
    if (repoId) {
      return this.raw
        .prepare(`select * from reviews where repo_id=? order by id desc limit ? offset ?`)
        .all(repoId, limit, offset) as ReviewRow[];
    }
    return this.raw.prepare(`select * from reviews order by id desc limit ? offset ?`).all(limit, offset) as ReviewRow[];
  }

  countReviews(repoId?: string): number {
    const row = repoId
      ? this.raw.prepare(`select count(*) as n from reviews where repo_id=?`).get(repoId)
      : this.raw.prepare(`select count(*) as n from reviews`).get();
    return (row as { n: number }).n;
  }

  markReviewPosted(id: number) {
    this.raw.prepare(`update reviews set posted=1 where id=?`).run(id);
  }

  // ---- jobs ----
  createJob(kind: JobKind, repoId: string | null, prNumber: number | null = null): JobRow {
    const res = this.raw.prepare(`insert into jobs (kind, repo_id, pr_number) values (?, ?, ?)`).run(kind, repoId, prNumber);
    return this.getJob(Number(res.lastInsertRowid))!;
  }

  listJobs(limit = 50): JobRow[] {
    return this.raw.prepare(`select * from jobs order by id desc limit ?`).all(limit) as JobRow[];
  }

  getJob(id: number): JobRow | undefined {
    return this.raw.prepare(`select * from jobs where id=?`).get(id) as JobRow | undefined;
  }

  updateJob(id: number, patch: Partial<Pick<JobRow, 'status' | 'progress' | 'error' | 'result_json'>>) {
    const sets = Object.keys(patch).map((k) => `${k}=@${k}`);
    sets.push(`updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
    this.raw.prepare(`update jobs set ${sets.join(', ')} where id=@id`).run({ id, ...patch });
  }

  insertUsage(row: UsageInsert) {
    const insert = this.raw.prepare(
      `insert into llm_usage (role, provider, model, input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, cost_usd, review_attempt_id, review_usage_seq)
       values (@role, @provider, @model, @input_tokens, @cached_input_tokens, @cache_write_tokens, @output_tokens, @cost_usd, @review_attempt_id, @review_usage_seq)`,
    );
    try {
      insert.run({ review_attempt_id: null, review_usage_seq: null, ...row });
    } catch (err) {
      if (!row.review_attempt_id || !(err instanceof Error) || !String(err.message).includes('UNIQUE')) throw err;
    }
    if (row.review_attempt_id) {
      this.raw.prepare(`update review_call_attempts set usage_reported=1 where id=?`).run(row.review_attempt_id);
    }
  }

  /** Per UTC day, role, provider and model since `sinceIso` (inclusive), newest day first. */
  usageByDay(sinceIso: string): UsageDayRow[] {
    return this.raw
      .prepare(
        `select substr(ts, 1, 10) as day, role, provider, model, count(*) as calls,
           sum(input_tokens) as input_tokens, sum(cached_input_tokens) as cached_input_tokens,
           sum(cache_write_tokens) as cache_write_tokens, sum(output_tokens) as output_tokens,
           coalesce(sum(cost_usd), 0) as reported_cost_usd,
           sum(case when cost_usd is null then input_tokens else 0 end) as unpriced_input_tokens,
           sum(case when cost_usd is null then cached_input_tokens else 0 end) as unpriced_cached_input_tokens,
           sum(case when cost_usd is null then cache_write_tokens else 0 end) as unpriced_cache_write_tokens,
           sum(case when cost_usd is null then output_tokens else 0 end) as unpriced_output_tokens,
           sum(case when cost_usd is null then 1 else 0 end) as unpriced_calls
         from llm_usage where ts >= ?
         group by day, role, provider, model
         order by day desc, provider, model, role`,
      )
      .all(sinceIso) as UsageDayRow[];
  }

  // ---- meta ----
  getMeta(key: string): string | undefined {
    const r = this.raw.prepare(`select value from meta where key=?`).get(key) as { value: string } | undefined;
    return r?.value;
  }

  setMeta(key: string, value: string) {
    this.raw.prepare(`insert into meta (key, value) values (?, ?) on conflict(key) do update set value=excluded.value`).run(key, value);
  }

  /** Startup-only recovery: conservatively account for calls left in flight. */
  recoverInterruptedReviewExecutions(): void {
    const tx = this.raw.transaction(() => {
      this.raw.prepare(`update jobs set status='error', error=coalesce(error,'interrupted by process restart'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') where kind='review' and status in ('queued','running')`).run();
      this.raw.prepare(`update review_call_attempts set state='interrupted', outcome='interrupted', settled_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') where state='started'`).run();
      this.raw.prepare(`update review_checkpoints set owner_token=null, owner_job_id=null, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') where state in ('active','ready','blocked')`).run();
    });
    tx();
  }

  pruneReviewCheckpointPayloads(beforeIso: string): number {
    const result = this.raw.prepare(`update review_checkpoints set state='invalidated', inputs_json=null, progress_json=null, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') where owner_token is null and state in ('active','ready') and updated_at < ?`).run(beforeIso);
    return result.changes;
  }
  /** Review jobs of one repository, latest first. */
  listReviewJobsForRepo(repoId: string, limit = 200): JobRow[] {
    return this.raw
      .prepare(`select * from jobs where kind='review' and repo_id=? order by id desc limit ?`)
      .all(repoId, limit) as JobRow[];
  }
}

function isDenseFiniteVector(vector: ArrayLike<number>): boolean {
  return vector.length > 0 && Array.from(vector).every((n) => typeof n === 'number' && Number.isFinite(n));
}

/**
 * Additive migrations for databases created by an older RepoLens. Every step must be
 * safe to re-run: the schema above already contains the result for fresh databases.
 */
function validateReviewProgressJson(value: string): void {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('invalid review progress JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid review progress payload');
  const p = parsed as Record<string, unknown>;
  const phases: Record<string, true> = { preparation: true, discovery: true, escalation: true, rule_validation: true, verification: true, arbitration: true, evidence: true, reconciliation: true, final: true };
  if (p.version !== 1 || typeof p.phase !== 'string' || phases[p.phase] !== true || !Array.isArray(p.completedUnits) || !Number.isInteger(p.activeProviderIndex) || !Number.isInteger(p.retryAttemptsUsed) || !Number.isInteger(p.followupRetryAttemptsUsed) || typeof p.followupReserve !== 'number' || !Number.isFinite(p.followupReserve) || typeof p.usedUsd !== 'number' || !Number.isFinite(p.usedUsd) || typeof p.reservedUsd !== 'number' || !Number.isFinite(p.reservedUsd) || !Array.isArray(p.warnings)) throw new Error('invalid review progress payload');
}

export function migrate(raw: Database.Database) {
  const reviewColumns = raw.pragma('table_info(reviews)') as Array<{ name: string }>;
  const repoColumns = raw.pragma('table_info(repos)') as Array<{ name: string }>;
  if (!repoColumns.some((c) => c.name === 'review_context_generation')) raw.exec(`alter table repos add column review_context_generation integer not null default 0`);
  if (!reviewColumns.some((c) => c.name === 'cost_usd')) raw.exec(`alter table reviews add column cost_usd real`);
  for (const column of ['provider', 'model', 'compatibility_key', 'base_sha'] as const) {
    if (!reviewColumns.some((c) => c.name === column)) raw.exec(`alter table reviews add column ${column} text`);
  }
  if (!reviewColumns.some((c) => c.name === 'completion_json')) raw.exec(`alter table reviews add column completion_json text`);
  if (reviewColumns.some((c) => c.name === 'envelope_json')) raw.exec(`update reviews set completion_json=envelope_json where completion_json is null`);
  const columns = raw.pragma('table_info(jobs)') as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'pr_number')) raw.exec(`alter table jobs add column pr_number integer`);
  const usageColumns = raw.pragma('table_info(llm_usage)') as Array<{ name: string }>;
  if (!usageColumns.some((c) => c.name === 'review_attempt_id')) raw.exec(`alter table llm_usage add column review_attempt_id text`);
  if (!usageColumns.some((c) => c.name === 'review_usage_seq')) raw.exec(`alter table llm_usage add column review_usage_seq integer`);
  raw.exec(`create unique index if not exists review_usage_unique on llm_usage(review_attempt_id, review_usage_seq) where review_attempt_id is not null and review_usage_seq is not null`);
  raw.exec(`create table if not exists review_checkpoints (id text primary key, repo_id text not null references repos(id) on delete cascade, pr_number integer not null, head_sha text not null, base_sha text not null, compatibility_key text not null, payload_version integer not null, state text not null check(state in ('active','ready','finalized','invalidated','blocked')), owner_token text, owner_job_id integer references jobs(id) on delete set null, generation integer not null default 0, inputs_json text, progress_json text, payload_hash text, review_id integer references reviews(id) on delete set null, last_error_code text, created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
  raw.exec(`create unique index if not exists review_checkpoints_open on review_checkpoints(repo_id,pr_number) where state in ('active','ready','blocked')`);
  raw.exec(`create index if not exists review_checkpoints_identity on review_checkpoints(repo_id,pr_number,head_sha,compatibility_key)`);
  raw.exec(`create index if not exists review_checkpoints_state on review_checkpoints(state,updated_at)`);

  raw.exec(`create table if not exists review_call_attempts (id text primary key, checkpoint_id text not null references review_checkpoints(id) on delete cascade, job_id integer references jobs(id) on delete set null, unit_key text not null, attempt_ordinal integer not null, provider text not null, model text not null, stage text not null, pass text not null, request_hash text not null, estimated_usd real not null, budgeted integer not null, state text not null check(state in ('started','settled','interrupted')), outcome text, error_class text, validation_error text, error_status integer, usage_reported integer not null default 0, usage_complete integer not null default 0, cost_usd real, reservation_usd real not null, elapsed_ms integer, started_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')), settled_at text, unique(checkpoint_id,unit_key,attempt_ordinal))`);
  raw.exec(`create index if not exists review_call_attempts_checkpoint on review_call_attempts(checkpoint_id)`);
}

export function openDb(path: string): Db {
  return new Db(path);
}
