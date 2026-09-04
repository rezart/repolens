# RepoLens

A self-hosted [Greptile](https://greptile.com) clone. Index your git repositories, ask questions about them with cited sources, and get AI code reviews posted as comments on your GitHub pull requests.

The LLM backend is pluggable:

| `LLM_PROVIDER` | What it uses | Needs |
| --- | --- | --- |
| `openrouter` | Any model on [OpenRouter](https://openrouter.ai) via its OpenAI-compatible API | `OPENROUTER_API_KEY`, `LLM_MODEL` |
| `claude-cli` | Your **Claude Pro/Max subscription** through the `claude` CLI (`claude -p`) | `claude` installed and logged in |
| `codex-cli` | Your **ChatGPT subscription** through the `codex` CLI (`codex exec`) | `codex` installed and logged in |

Everything runs in one Node process with a SQLite database (FTS5 for lexical search, sqlite-vec for vectors). No external services.

## Features

- **Repository indexing**: clone, chunk by language-aware boundaries, index incrementally by git blob hash.
- **Codebase Q&A**: hybrid retrieval (BM25 + optional embeddings, fused with reciprocal rank fusion), answers in Markdown with `path:start-end` citations.
- **PR review**: triggered by a GitHub webhook or the API. Reviews each changed file with related code pulled from the index, then posts a GitHub review with a summary and inline comments on the changed lines.
- **PR chat**: mention the bot handle in a PR comment (`@repolens why does this change X?`) to get an answer posted back.
- **REST API** modeled on Greptile's (`/api/repositories`, `/api/query`, `/api/search`, `/api/reviews`).
- **Dashboard** at `/` for adding repos, chatting, running reviews, and setting per-repo review instructions.
- **CLI** for indexing, asking, and reviewing from the terminal.

## Quick start

Requirements: Node 20+ and `git` on the PATH.

```bash
git clone <this repo> repolens && cd repolens
npm install
cp .env.example .env   # edit it
npm start              # http://localhost:3000
```

### Option A: OpenRouter (any model)

```env
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-...
LLM_MODEL=anthropic/claude-sonnet-4.5     # or openai/gpt-5, google/gemini-2.5-pro, deepseek/deepseek-chat, ...
EMBEDDING_API_KEY=sk-or-...               # optional, enables vector search
EMBEDDING_MODEL=openai/text-embedding-3-small
```

### Option B: Claude subscription

```bash
claude login            # once, on the machine that runs RepoLens
```

```env
LLM_PROVIDER=claude-cli
LLM_MODEL=              # blank = CLI default; or e.g. sonnet / opus
```

No API key is needed. Leave `EMBEDDING_MODEL` blank to run fully key-free with lexical retrieval, or point `EMBEDDING_BASE_URL` at any OpenAI-compatible embeddings server (OpenRouter, OpenAI, Ollama's `/v1`, LM Studio) for vector search.

### Option C: Codex subscription

```bash
codex login
```

```env
LLM_PROVIDER=codex-cli
LLM_MODEL=              # blank = CLI default
```

CLI providers run one completion at a time to stay within subscription rate limits. Reviews of large PRs take a few minutes.

## Using it

Set `REPOLENS_API_TOKEN` in `.env`; the API and dashboard use it as a bearer token.

```bash
# index a repository
curl -X POST localhost:3000/api/repositories \
  -H "Authorization: Bearer $REPOLENS_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"remote":"github","repository":"owner/name","branch":"main"}'

# ask a question
curl -X POST localhost:3000/api/query \
  -H "Authorization: Bearer $REPOLENS_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"How is authentication implemented?"}],"repositories":["github:owner/name"]}'

# review a PR and post the comments to GitHub
curl -X POST localhost:3000/api/reviews \
  -H "Authorization: Bearer $REPOLENS_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"repository":"github:owner/name","prNumber":42,"post":true}'
```

Or from the terminal:

```bash
npm run cli -- index owner/name --branch main
npm run cli -- ask github:owner/name "Where are webhooks verified?"
npm run cli -- review github:owner/name 42 --post
```

### GitHub setup

1. Create a token with `repo` scope (classic PAT) or a fine-grained token with *Contents: read* and *Pull requests: read & write*. Put it in `GITHUB_TOKEN`. Private repos are cloned with this token.
2. In the repository (or org) settings add a webhook:
   - Payload URL: `https://<your host>/webhooks/github`
   - Content type: `application/json`
   - Secret: the value of `GITHUB_WEBHOOK_SECRET`
   - Events: *Pull requests* and *Issue comments*
3. Index the repository (API, CLI, or dashboard). New and updated PRs are then reviewed automatically and the review is posted to the PR. Comments that mention `REVIEW_BOT_HANDLE` (default `@repolens`) get an answer.

Per-repository review instructions (coding standards, what to ignore) can be set in the dashboard's Settings tab or via `PUT /api/repositories/:id/instructions`.

## API

All `/api/*` routes except `/api/health` require `Authorization: Bearer <REPOLENS_API_TOKEN>`. Repository ids are `github:owner/name`.

| Method | Path | Body / notes |
| --- | --- | --- |
| GET | `/api/health` | provider, model, embeddings |
| GET | `/api/repositories` | list |
| POST | `/api/repositories` | `{ remote: "github", repository: "owner/name", branch? }` → 202 with `jobId` |
| GET | `/api/repositories/:id` | status, counts |
| POST | `/api/repositories/:id/reindex` | → `jobId` |
| PUT | `/api/repositories/:id/instructions` | `{ instructions }` |
| DELETE | `/api/repositories/:id` | |
| POST | `/api/query` | `{ messages, repositories, stream? }` → `{ message, sources }` (SSE when `stream: true`) |
| POST | `/api/search` | `{ query, repositories, limit? }` → chunks |
| POST | `/api/reviews` | `{ repository, prNumber, post? (default true), force? }` → 202 with `jobId` |
| GET | `/api/reviews?repository=` | past reviews with findings |
| GET | `/api/jobs/:id` | job status and progress |
| POST | `/webhooks/github` | GitHub webhook (HMAC verified) |

## Configuration

See `.env.example` for every variable. The important ones:

| Variable | Default | Purpose |
| --- | --- | --- |
| `REPOLENS_DATA_DIR` | `./data` | SQLite database and repository clones |
| `REPOLENS_API_TOKEN` | empty | Bearer token for the API. Empty disables auth (local use only) |
| `REPOLENS_PORT` | `3000` | |
| `LLM_PROVIDER` | `openrouter` | `openrouter`, `claude-cli`, `codex-cli` |
| `LLM_MODEL` | | Model id (OpenRouter) or model name (CLIs, optional) |
| `LLM_TIMEOUT_MS` | `300000` | Per-completion timeout |
| `EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY` / `EMBEDDING_MODEL` | OpenRouter / empty / empty | OpenAI-compatible embeddings. Blank model = lexical only |
| `GITHUB_TOKEN` | | Clone private repos, read PRs, post reviews |
| `GITHUB_WEBHOOK_SECRET` | | Verifies webhook payloads |
| `REVIEW_BOT_HANDLE` | `@repolens` | Mention that triggers PR chat |

## Docker

```bash
docker compose up --build
```

The Docker image works with `LLM_PROVIDER=openrouter`. The CLI providers need the `claude`/`codex` binaries and their login state, so for those run `npm start` directly on the host.

## Development

```bash
npm test          # vitest
npm run typecheck
npm run dev       # server with reload
```

Design notes live in `docs/plans/`.
