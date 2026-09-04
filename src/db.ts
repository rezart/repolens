import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
  summary: string | null;
  verdict: string | null;
  comments_json: string;
  posted: number;
  error: string | null;
  created_at: string;
}

export interface JobRow {
  id: number;
  kind: JobKind;
  repo_id: string | null;
  status: JobStatus;
  progress: string | null;
  error: string | null;
  result_json: string | null;
  created_at: string;
  updated_at: string;
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
  summary text,
  verdict text,
  comments_json text not null default '[]',
  posted integer not null default 0,
  error text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index if not exists reviews_repo on reviews(repo_id, pr_number);
create table if not exists jobs (
  id integer primary key autoincrement,
  kind text not null,
  repo_id text,
  status text not null default 'queued',
  progress text,
  error text,
  result_json text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create table if not exists meta (key text primary key, value text not null);
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
    const dim = this.raw.prepare(`select value from meta where key='vec_dim'`).get() as { value: string } | undefined;
    if (dim) this.vecDim = Number(dim.value);
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
    this.raw.prepare(`insert or replace into meta (key, value) values ('vec_dim', ?)`).run(String(dim));
    this.vecDim = dim;
  }

  insertVectors(rows: Array<{ chunkId: number; repoId: string; embedding: number[] }>) {
    if (!this.vecDim) throw new Error('ensureVecTable() must be called before insertVectors()');
    const stmt = this.raw.prepare(`insert or replace into chunk_vec (chunk_id, repo_id, embedding) values (?, ?, ?)`);
    const tx = this.raw.transaction((items: typeof rows) => {
      for (const r of items) stmt.run(BigInt(r.chunkId), r.repoId, new Float32Array(r.embedding));
    });
    tx(rows);
  }

  vecSearch(repoIds: string[], embedding: number[], limit: number): SearchHit[] {
    if (!this.vecDim || repoIds.length === 0) return [];
    const placeholders = repoIds.map(() => '?').join(',');
    const rows = this.raw
      .prepare(
        `select v.chunk_id as chunk_id, v.distance as distance
         from chunk_vec v
         where v.embedding match ? and k = ? and v.repo_id in (${placeholders})`,
      )
      .all(new Float32Array(embedding), limit, ...repoIds) as Array<{ chunk_id: number | bigint; distance: number }>;
    const hits: SearchHit[] = [];
    for (const r of rows) {
      const chunk = this.getChunk(Number(r.chunk_id));
      if (chunk) hits.push({ chunk, score: 1 / (1 + r.distance) });
    }
    return hits;
  }

  /** Chunk ids in a repo that have no vector yet (used to backfill embeddings). */
  chunkIdsWithoutVectors(repoId: string): number[] {
    if (!this.vecDim) {
      return (this.raw.prepare(`select id from chunks where repo_id=?`).all(repoId) as { id: number }[]).map((r) => r.id);
    }
    return (
      this.raw
        .prepare(`select id from chunks where repo_id=? and id not in (select chunk_id from chunk_vec where repo_id=?)`)
        .all(repoId, repoId) as { id: number }[]
    ).map((r) => r.id);
  }

  // ---- reviews ----
  insertReview(r: Omit<ReviewRow, 'id' | 'created_at'>): ReviewRow {
    const res = this.raw
      .prepare(
        `insert into reviews (repo_id, pr_number, head_sha, status, summary, verdict, comments_json, posted, error)
         values (@repo_id, @pr_number, @head_sha, @status, @summary, @verdict, @comments_json, @posted, @error)`,
      )
      .run(r);
    return this.getReview(Number(res.lastInsertRowid))!;
  }

  getReview(id: number): ReviewRow | undefined {
    return this.raw.prepare(`select * from reviews where id=?`).get(id) as ReviewRow | undefined;
  }

  findReview(repoId: string, prNumber: number, headSha: string): ReviewRow | undefined {
    return this.raw
      .prepare(`select * from reviews where repo_id=? and pr_number=? and head_sha=? and status='done' order by id desc limit 1`)
      .get(repoId, prNumber, headSha) as ReviewRow | undefined;
  }

  listReviews(repoId?: string, limit = 50): ReviewRow[] {
    if (repoId) {
      return this.raw.prepare(`select * from reviews where repo_id=? order by id desc limit ?`).all(repoId, limit) as ReviewRow[];
    }
    return this.raw.prepare(`select * from reviews order by id desc limit ?`).all(limit) as ReviewRow[];
  }

  markReviewPosted(id: number) {
    this.raw.prepare(`update reviews set posted=1 where id=?`).run(id);
  }

  // ---- jobs ----
  createJob(kind: JobKind, repoId: string | null): JobRow {
    const res = this.raw.prepare(`insert into jobs (kind, repo_id) values (?, ?)`).run(kind, repoId);
    return this.getJob(Number(res.lastInsertRowid))!;
  }

  updateJob(id: number, patch: Partial<Pick<JobRow, 'status' | 'progress' | 'error' | 'result_json'>>) {
    const sets = Object.keys(patch).map((k) => `${k}=@${k}`);
    sets.push(`updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
    this.raw.prepare(`update jobs set ${sets.join(', ')} where id=@id`).run({ id, ...patch });
  }

  getJob(id: number): JobRow | undefined {
    return this.raw.prepare(`select * from jobs where id=?`).get(id) as JobRow | undefined;
  }

  listJobs(limit = 50): JobRow[] {
    return this.raw.prepare(`select * from jobs order by id desc limit ?`).all(limit) as JobRow[];
  }
}

export function openDb(path: string): Db {
  return new Db(path);
}
