# RepoLens Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build RepoLens, a self-hosted Greptile clone: index git repos, answer codebase questions with citations, review GitHub PRs, with OpenRouter / Claude CLI / Codex CLI as swappable LLM backends.

**Architecture:** One Node/TypeScript process. Hono serves the API, webhook, and a static dashboard. SQLite (better-sqlite3) holds repos, files, chunks, FTS5 index, sqlite-vec vectors, reviews and jobs. An `LLMProvider` interface isolates model backends; an `EmbeddingProvider` is optional. Retrieval is hybrid BM25 + kNN fused by RRF. See `docs/plans/2026-09-03-repolens-design.md`.

**Tech Stack:** Node 23, TypeScript, tsx (dev runner), Hono, better-sqlite3, sqlite-vec, simple-git, vitest, zod.

**Conventions:**
- ESM (`"type": "module"`), `strict` TS, imports use `.js` suffix.
- Tests live in `tests/` mirroring `src/`, run with `npx vitest run`.
- Every task: write failing test, run it, implement, run green, commit.
- Commit message trailer on every commit:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01F4fDs9vj3gEwYdUWhf6LpD
  ```

---

### Task 1: Project scaffold

**Files:** `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, `src/config.ts`, `tests/config.test.ts`

- `npm init -y`; deps: `hono @hono/node-server better-sqlite3 sqlite-vec simple-git zod`; dev: `typescript tsx vitest @types/node @types/better-sqlite3`.
- Scripts: `dev: tsx watch src/cli.ts serve`, `start: tsx src/cli.ts serve`, `test: vitest run`, `typecheck: tsc --noEmit`.
- `src/config.ts` exports `loadConfig(env = process.env): Config` validated with zod. Fields per design doc env table. `LLM_PROVIDER` enum `openrouter|claude-cli|codex-cli` default `openrouter`. `EMBEDDING_MODEL` blank => `embedding: null`.
- Test: defaults load; missing `OPENROUTER_API_KEY` with provider `openrouter` throws; `claude-cli` without key succeeds.

### Task 2: Database layer

**Files:** `src/db.ts`, `tests/db.test.ts`

- `openDb(path: string | ':memory:'): Db` applies schema from design doc, loads sqlite-vec (`sqliteVec.load(db)`), enables WAL.
- Typed helpers: `upsertRepo`, `getRepo(id)`, `listRepos`, `setRepoStatus`, `upsertFile`, `deleteFile(repoId, path)` (cascades chunks, fts, vec), `insertChunks(chunks[])`, `ensureVecTable(dim)`, `insertVectors([{chunkId, embedding}])`, `ftsSearch(repoIds, query, limit)`, `vecSearch(repoIds, embedding, limit)`, `insertReview`, `listReviews`, `createJob`, `updateJob`, `getJob`.
- FTS5 table: `create virtual table chunks_fts using fts5(content, path, content='chunks', content_rowid='id', tokenize='unicode61 tokenchars \"_\"')` with insert/delete triggers.
- Vec table: `vec0(chunk_id integer primary key, repo_id integer, embedding float[dim])`; `vecSearch` filters `repo_id in (...)` via `where chunk_id in (select id from chunks where repo_id in ...)`? No: vec0 supports metadata columns; use `repo_id` as a partition key column: `repo_id integer partition key`.
- Tests: insert repo/file/chunks, ftsSearch returns matching chunk ranked; vec table created with dim 4 and nearest neighbor returned; deleteFile removes chunk from fts.

### Task 3: LLM provider interface + JSON extraction

**Files:** `src/llm/types.ts`, `src/llm/json.ts`, `tests/llm/json.test.ts`

- `ChatMessage {role:'system'|'user'|'assistant', content:string}`; `CompleteRequest {system?, messages, json?, maxTokens?, temperature?}`; `interface LLMProvider { name; model; complete(req): Promise<string> }`.
- `extractJson(text): unknown` finds first balanced `{...}` or `[...]`, strips ``` fences, throws `JsonExtractError` with the raw text.
- Tests: fenced JSON, prose-wrapped JSON, nested braces in strings, no JSON throws.

### Task 4: OpenRouter provider

**Files:** `src/llm/openrouter.ts`, `tests/llm/openrouter.test.ts`

- `new OpenRouterProvider({apiKey, model, baseUrl = 'https://openrouter.ai/api/v1', fetch = globalThis.fetch})`.
- POST `/chat/completions` with `messages` (system first), `response_format: {type:'json_object'}` when `json`, headers `HTTP-Referer` + `X-Title: RepoLens`. Retry 3x on 429/5xx with backoff. Throw `ProviderError(name, status, body)`.
- Tests with injected fake fetch: request shape; 429 then 200 succeeds; 400 throws.

### Task 5: Claude CLI provider

**Files:** `src/llm/claude-cli.ts`, `src/llm/spawn.ts`, `tests/llm/claude-cli.test.ts`

- `src/llm/spawn.ts`: `runProcess(cmd, args, {stdin, cwd, timeoutMs, env}) => {stdout, stderr, code}`; kills on timeout. Exported `Semaphore` class (limit 1) used by CLI providers.
- `ClaudeCliProvider({model?, bin='claude', timeoutMs=300000, run=runProcess})`. Args: `-p --output-format json --tools "" --bare --no-session-persistence --permission-mode dontAsk` plus `--model` if set plus `--system-prompt <system>` if present. Prompt = messages flattened (`User: …`/`Assistant: …`, last user message last). Stdin carries the prompt. Parse stdout JSON `{result, is_error}`; if `is_error` throw ProviderError. cwd = empty temp dir.
- Tests with injected fake `run`: args contain `-p`, `--output-format json`, `--tools ""`; result extracted; non-zero exit throws.

### Task 6: Codex CLI provider

**Files:** `src/llm/codex-cli.ts`, `tests/llm/codex-cli.test.ts`

- `CodexCliProvider({model?, bin='codex', timeoutMs, run})`. Args: `exec --ephemeral --skip-git-repo-check -s read-only --color never -o <tmpfile> -` (prompt on stdin), `-m <model>` if set, `-C <emptyTempDir>`. Read `<tmpfile>` for the last message. System prompt is prepended to the stdin text under a `# System instructions` heading.
- Tests: args, output file read, failure throws.

### Task 7: Provider factory + embeddings

**Files:** `src/llm/index.ts`, `src/embeddings/index.ts`, `tests/embeddings.test.ts`

- `createProvider(config): LLMProvider` switch on `config.llm.provider`.
- `OpenAIEmbeddings({baseUrl, apiKey, model, fetch})` with `embed(texts: string[]): Promise<number[][]>` batching 64 at a time; `dimension` learned from first response. `createEmbeddings(config): EmbeddingProvider | null`.
- Tests: batch split, dimension set, request body shape.

### Task 8: Chunker

**Files:** `src/indexer/chunker.ts`, `src/indexer/language.ts`, `tests/indexer/chunker.test.ts`

- `detectLanguage(path): string | null` by extension map (ts, tsx, js, jsx, py, go, rs, java, kt, rb, php, cs, c, cpp, h, swift, scala, sh, sql, md, yaml, json, toml, html, css, ...). Return null for binary/unknown.
- `shouldIndex(path, size): boolean` — skip > 512 KB, `node_modules/`, `vendor/`, `dist/`, `build/`, `.git/`, `*.min.js`, lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `go.sum`, `poetry.lock`), images, fonts, archives.
- `chunkFile(path, text, {maxLines=80, overlap=8}): Chunk[]` where `Chunk {path, startLine, endLine, content}`. Split at boundary lines matching top-level definition regexes (`^(export\s+)?(async\s+)?(function|class|interface|type|enum|const|let|var)\b`, `^(def|class)\s`, `^func\s`, `^(pub\s+)?(fn|struct|enum|impl|trait)\b`, `^\s*(public|private|protected|static).*\(`, `^#+\s` for md, etc). Build segments between boundaries; merge small adjacent segments up to `maxLines`; split segments longer than `maxLines` into windows with `overlap`. Never emit an empty or whitespace-only chunk. Lines are 1-based inclusive.
- Tests: TS file with 3 functions produces chunks aligned to function starts; a 300-line file with no boundaries produces windows of 80 with 8 overlap; empty file => []; markdown splits at headings.

### Task 9: Git operations

**Files:** `src/indexer/git.ts`, `tests/indexer/git.test.ts`

- `parseRemote(remote: string): {host:'github', owner, name}` for `https://github.com/o/n(.git)`, `git@github.com:o/n.git`, `o/n`.
- `RepoCheckout` class: `ensureClone(remoteUrl, dir, {token?})` clones (token embedded as `x-access-token:<token>@` in URL, never logged) or fetches; `checkout(ref)`; `headSha()`; `listFiles(): {path, blobHash, size}[]` via `git ls-files -s` + `git ls-files --stage`? Use `git ls-tree -r -l HEAD` which gives mode, type, hash, size, path. `readFile(path)`; `fetchPr(number)` fetches `pull/N/head` into `refs/remotes/pr/N`; `diff(base, head)` returns unified diff with `-U3`.
- Tests build a real temp git repo with two commits (init + modify), assert listFiles hashes and sizes, and that a second file's hash changes after edit.

### Task 10: Indexer

**Files:** `src/indexer/indexer.ts`, `tests/indexer/indexer.test.ts`

- `indexRepo({db, checkout, repoId, embeddings, onProgress})`: list files, filter with `shouldIndex` + `detectLanguage`, compare `blobHash` to `files` rows; for changed/new: read, chunk, `deleteFile` then `upsertFile` + `insertChunks`; for removed: `deleteFile`. If embeddings: embed new chunks in batches (`path + "\n" + content`), `ensureVecTable(dim)`, `insertVectors`. Update repo `last_commit`, `indexed_at`, `status='ready'`. Returns `{files, chunks, skipped}`.
- Tests: temp git repo + in-memory db + fake embeddings (deterministic vectors, dim 4). First index creates chunks; re-index with no change skips all; modify a file, re-index re-chunks only that file; delete file removes rows.

### Task 11: Retrieval

**Files:** `src/search/retrieve.ts`, `src/search/tokenize.ts`, `tests/search/retrieve.test.ts`

- `tokenizeQuery(q): string[]`: split on non-word, split camelCase and snake_case, lowercase, drop stopwords and tokens < 2 chars, dedupe, keep original identifiers too. `buildFtsQuery(tokens)`: `"tok1" OR "tok2" ...` (quoted to avoid FTS syntax errors).
- `rrf(rankings: number[][], k=60): Map<id, score>`.
- `retrieve({db, repoIds, query, embeddings, limit=12}): Promise<RetrievedChunk[]>` combining `ftsSearch` (limit*3) and `vecSearch` (limit*3) when available. `RetrievedChunk {chunkId, repoId, path, startLine, endLine, content, score}`.
- Tests: tokenizer cases; rrf ordering; retrieve with fts-only db returns the relevant chunk first; with fake embeddings both lists fuse.

### Task 12: Query / answer

**Files:** `src/query/answer.ts`, `src/query/prompts.ts`, `tests/query/answer.test.ts`

- `answerQuestion({db, llm, embeddings, repoIds, messages, limit}) => {message, sources}`. If >1 message, call llm to rewrite last question standalone (plain text). Retrieve, build context blocks `### <repo> <path>:<start>-<end>\n```<lang>\n…\n```` under a 24k-char budget, system prompt from `prompts.ts` instructing Markdown answer with citations like `path:start-end`. Sources = retrieved chunks used.
- Tests with fake LLM capturing the prompt: context contains the chunk path; sources map correctly; multi-turn triggers rewrite call first.

### Task 13: Diff parser

**Files:** `src/review/diff.ts`, `tests/review/diff.test.ts`

- `parseUnifiedDiff(text): DiffFile[]` where `DiffFile {oldPath, newPath, status:'added'|'modified'|'deleted'|'renamed', binary, hunks: Hunk[]}`, `Hunk {oldStart, oldLines, newStart, newLines, lines: {type:'add'|'del'|'ctx', content, newLine?: number, oldLine?: number}[]}`.
- `changedNewLines(file): Set<number>` (lines eligible for comments). `hunkText(file): string` renders the diff for a prompt with new-line numbers prefixed on add/ctx lines.
- Tests: two-file fixture diff; renamed file; binary file; line numbering matches.

### Task 14: GitHub client

**Files:** `src/review/github.ts`, `tests/review/github.test.ts`

- `GitHubClient({token, fetch, baseUrl='https://api.github.com'})`: `getPull(owner, repo, n)` → `{number,title,body,headSha,baseSha,headRef,baseRef,user}`; `getPullDiff` (Accept `application/vnd.github.v3.diff`); `createReview(owner, repo, n, {commitId, body, event:'COMMENT', comments:[{path, line, side:'RIGHT', body}]})`; `createIssueComment`; `listReviewComments` (for dedupe). `verifyWebhookSignature(secret, body, signatureHeader)` HMAC sha256 constant-time.
- Tests: fake fetch asserts URL/headers/bodies; signature verify positive and negative.

### Task 15: Reviewer

**Files:** `src/review/reviewer.ts`, `src/review/prompts.ts`, `tests/review/reviewer.test.ts`

- `reviewPullRequest({db, llm, embeddings, repo, checkout, github, prNumber, post}) => Review`.
  1. `pr = github.getPull`, `diffText = github.getPullDiff`, `files = parseUnifiedDiff` filtered by `shouldIndex(newPath)` and not deleted/binary; cap 40 files.
  2. Per file: context = `retrieve` with query = `path + identifiers from added lines` (limit 8) excluding chunks from the same path; prompt with repo `instructions`, PR title/body, hunk text, context; ask JSON `{findings:[{line, severity:'critical'|'warning'|'nit', title, body}]}`. Keep findings whose `line ∈ changedNewLines`. Run up to 4 files concurrently for HTTP providers, 1 for CLI (`llm.concurrency` hint; default 4).
  3. Summary: prompt with PR title, list of files, all findings → JSON `{summary, verdict:'approve'|'comment'|'request_changes'}`.
  4. Persist `reviews` row. If `post`, `github.createReview` with body = summary + verdict badge + finding count, comments = findings; mark `posted`.
- Tests with fake llm/github/retrieval: findings outside the hunk are dropped; posted comments have path/line/body; no post when `post=false`.

### Task 16: Jobs, webhook, server

**Files:** `src/jobs.ts`, `src/review/webhook.ts`, `src/server.ts`, `src/app.ts`, `tests/server.test.ts`

- `JobQueue` runs one job at a time per kind (`index`, `review`); `enqueue(kind, repoId, fn)` returns job id and records status in `jobs` table.
- `createApp(deps): Hono` with routes from the design doc. Bearer auth middleware on `/api/*` (skips `/api/health`). `POST /api/repositories` parses remote, upserts repo with status `queued`, enqueues index. `POST /api/query` supports `stream: true` via SSE by sending the final message in one event (providers are non-streaming). Webhook: verify signature, on `pull_request` (`opened|synchronize|reopened`) enqueue review with `post=true`; on `issue_comment` containing the bot handle on a PR, answer via query flow and post comment.
- `src/server.ts`: `startServer(config)` builds deps and calls `serve`.
- Tests via `app.request()`: unauthenticated 401; add repo returns id `github:o/n` and job id; query with fake llm returns message.

### Task 17: CLI

**Files:** `src/cli.ts`

- Subcommands: `serve`, `index <remote> [--branch b]`, `ask <repo> "<question>"`, `review <repo> <pr> [--post]`. Uses the same deps as the server; prints JSON or Markdown.

### Task 18: Dashboard

**Files:** `web/index.html`, `web/app.js`, `web/style.css`, served by Hono `serveStatic` at `/`.

- Token entry (stored in localStorage), repos list with status and reindex button, add-repo form, chat panel per repo showing answer Markdown (use `marked` from cdnjs) and sources, reviews list with a "run review" form. Plain JS, fetch API.

### Task 19: Docs and Docker

**Files:** `README.md`, `Dockerfile`, `docker-compose.yml`

- README: what it is, quick start for each provider (OpenRouter key; Claude: `claude login` on host and run outside Docker or mount `~/.claude`; Codex: `codex login`), GitHub webhook setup, API reference, env table.
- Dockerfile: node:22-slim, `apt-get install git`, `npm ci`, `CMD ["npx","tsx","src/cli.ts","serve"]`.

### Task 20: End-to-end smoke

- `npm run typecheck && npm test` green.
- Start server with `LLM_PROVIDER=claude-cli`, index this repo itself via the API, ask "how is retrieval implemented?", confirm cited paths are real.
