# RepoLens: self-hosted Greptile clone — design

Date: 2026-09-03

## Goal

A self-hosted service that does what greptile.com does for a team:

1. Index git repositories so an LLM can answer questions about them with citations.
2. Review pull requests automatically with full-codebase context and post comments to GitHub.
3. Expose a REST API (modeled on Greptile's) plus a small web dashboard.

The LLM backend is pluggable. Three backends ship:

- **OpenRouter**: any model behind OpenRouter's OpenAI-compatible chat API.
- **Claude subscription**: shells out to the `claude` CLI in print mode, so a Claude Pro/Max login is used and no API key is needed.
- **Codex subscription**: shells out to `codex exec`, so a ChatGPT login is used.

## Non-goals (v1)

- Multi-tenant auth and billing. A single shared bearer token protects the API.
- GitLab and Bitbucket. GitHub only, via a personal access token. The git host layer is an interface so GitLab can be added.
- Learning from thumbs-up/down feedback. Reviews accept a per-repo custom instructions file instead.
- Tree-sitter parsing. Chunking is heuristic and language-aware by regex.

## Architecture

Single Node process. No external services.

```
src/
  config.ts            env-driven config (provider, model, tokens, data dir)
  db.ts                SQLite schema (better-sqlite3 + FTS5 + sqlite-vec)
  llm/
    types.ts           LLMProvider interface: complete(messages, opts) -> text
    openrouter.ts      HTTP client, OpenAI chat-completions shape
    claude-cli.ts      spawn `claude -p --output-format json --tools ""`
    codex-cli.ts       spawn `codex exec --ephemeral -s read-only -o <tmp>`
    index.ts           factory from config
  embeddings/
    index.ts           EmbeddingProvider: OpenAI-compatible /embeddings, or null
  indexer/
    git.ts             clone / fetch / checkout / list files / read diff
    chunker.ts         file text -> chunks (language-aware split, size cap)
    indexer.ts         walk repo, chunk, embed, upsert; incremental by blob hash
  search/
    retrieve.ts        hybrid retrieval: FTS5 BM25 + vector kNN, RRF fusion
  query/
    answer.ts          retrieval -> prompt -> LLM -> answer + sources
  review/
    diff.ts            unified diff parser -> hunks with new-file line numbers
    reviewer.ts        per-file review with retrieved context -> comments
    github.ts          GitHub REST: get PR, get diff, post review, post comment
    webhook.ts         verify HMAC, dispatch pull_request / issue_comment events
  jobs.ts              in-process job queue (index, review) with status
  server.ts            Hono app: API routes, webhook, static dashboard
  cli.ts               `repolens serve`, `repolens index <url>`, `repolens ask`
web/
  index.html, app.js, style.css   dashboard: repos, index status, chat, reviews
```

## Data model (SQLite)

- `repos(id, remote, owner, name, branch, default_branch, status, last_commit, indexed_at, error, instructions)`
- `files(id, repo_id, path, blob_hash, language, size)`
- `chunks(id, file_id, repo_id, path, start_line, end_line, content, summary)`
- `chunks_fts` FTS5 virtual table over `content` and `path`, external content on `chunks`
- `chunk_vec` sqlite-vec virtual table `vec0(chunk_id integer primary key, embedding float[N])`, created lazily once the embedding dimension is known
- `reviews(id, repo_id, pr_number, head_sha, status, summary, comments_json, created_at, posted)`
- `jobs(id, kind, repo_id, status, progress, error, created_at, updated_at)`

Indexing is incremental: files whose blob hash is unchanged are skipped; deleted files are removed along with their chunks and vectors.

## LLM provider interface

```ts
interface LLMProvider {
  name: string;
  model: string;
  complete(req: { system?: string; messages: ChatMessage[]; json?: boolean; maxTokens?: number }): Promise<string>;
}
```

`json: true` asks for a JSON object. OpenRouter uses `response_format`. CLI providers append an instruction and the caller extracts the first JSON object from the text with a tolerant parser.

CLI providers run with tools disabled and a scratch cwd so they behave as a plain completion. Concurrency is capped at one process per CLI provider to respect subscription rate limits.

## Retrieval

1. Lexical: FTS5 with BM25 over chunk content and path; query terms are tokenized from the question with identifier splitting (camelCase, snake_case).
2. Vector: if an embedding provider is configured, embed the question and take kNN from sqlite-vec.
3. Fuse with reciprocal rank fusion, dedupe by chunk, take top K (default 12), then pack into the prompt under a token budget with file path and line range headers.

Without embeddings the system still works with lexical retrieval alone. This keeps the "CLI subscription, no API keys" setup viable.

## Query flow

`POST /api/query` with `{ messages, repositories, stream? }`:

1. Take the last user message as the retrieval query. If there is prior conversation, ask the LLM for a one-line standalone rewrite first.
2. Retrieve top chunks across the named repos.
3. Prompt the LLM with the chunks and ask for an answer in Markdown that cites `path:start-end`.
4. Return `{ message, sources: [{ repository, filepath, linestart, lineend, summary }] }`.

## Review flow

Triggered by a `pull_request` webhook (opened, synchronize, reopened) or `POST /api/reviews`:

1. Fetch PR metadata and unified diff from GitHub. Fetch the head ref into the local clone.
2. Parse the diff into files and hunks. Skip binary, lockfiles, generated, and vendored paths.
3. For each changed file (up to a cap), retrieve related chunks from the index using the file's changed identifiers and path, then ask the LLM for findings as JSON: `{ path, line, severity, title, body }`. The line must be a new-file line inside a hunk; anything else is dropped.
4. Ask the LLM for a short PR summary from the diff and file findings.
5. Post one GitHub review with the summary as body and the findings as inline comments. Re-runs on `synchronize` are deduped by head sha.

An `issue_comment` on a PR that mentions the configured bot handle is answered with the query flow using the diff as extra context.

## API

Auth: `Authorization: Bearer <REPOLENS_API_TOKEN>` on `/api/*`. Webhooks use HMAC.

- `GET  /api/health`
- `GET  /api/repositories` / `POST /api/repositories { remote, repository, branch }` / `GET /api/repositories/:id`
- `POST /api/repositories/:id/reindex`
- `POST /api/query { messages, repositories, stream }`
- `POST /api/search { query, repositories, limit }`
- `POST /api/reviews { repository, prNumber, post }` / `GET /api/reviews?repository=`
- `GET  /api/jobs/:id`
- `POST /webhooks/github`

Repository ids are `github:owner/name` as in Greptile.

## Configuration (env)

```
REPOLENS_DATA_DIR=./data
REPOLENS_API_TOKEN=change-me
REPOLENS_PORT=3000

LLM_PROVIDER=openrouter | claude-cli | codex-cli
LLM_MODEL=anthropic/claude-sonnet-4.5          # openrouter model id, or claude/codex model name
OPENROUTER_API_KEY=

EMBEDDING_BASE_URL=https://openrouter.ai/api/v1  # any OpenAI-compatible /embeddings
EMBEDDING_API_KEY=
EMBEDDING_MODEL=openai/text-embedding-3-small   # blank disables vector search

GITHUB_TOKEN=
GITHUB_WEBHOOK_SECRET=
REVIEW_BOT_HANDLE=@repolens
```

## Error handling

- Provider errors carry the provider name and are surfaced in job status and API responses; they never crash the server.
- CLI providers time out (default 300 s) and are killed.
- Indexing errors mark the repo `status=error` with the message; a reindex retries.
- Webhook handler acknowledges within the request and does the work in the job queue.

## Testing

Vitest. Unit tests for chunker, tokenizer, RRF fusion, diff parser, JSON extraction, and the three providers (mocked `fetch` and mocked child process). Integration tests for indexing a fixture repo into a temp SQLite database and running a query with a fake LLM, and for the review pipeline end to end with a recorded diff and a fake GitHub client.
