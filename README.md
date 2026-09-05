# RepoLens

A self-hosted [Greptile](https://greptile.com) clone. Index your git repositories, ask questions about them with cited sources, and get AI code reviews posted as comments on your GitHub pull requests.

The LLM backend is pluggable:

| `LLM_PROVIDER` | What it uses | Needs |
| --- | --- | --- |
| `openrouter` | Any model on [OpenRouter](https://openrouter.ai) via its OpenAI-compatible API | `OPENROUTER_API_KEY`, `LLM_MODEL` |
| `claude-cli` | Your **Claude Pro/Max subscription** through the `claude` CLI (`claude -p`) | `claude` installed and logged in |

`codex-cli` is temporarily disabled because its tools can read host files and credentials while processing untrusted repository content. Set both `LLM_PROVIDER` and `CHAT_PROVIDER` to supported providers; startup rejects Codex selections instead of silently switching providers.

Everything runs in one Node process with a SQLite database (FTS5 for lexical search, sqlite-vec for vectors). No external services.

## Features

- **Repository indexing**: clone, chunk by language-aware boundaries, index incrementally by git blob hash.
- **Codebase Q&A**: hybrid retrieval (BM25 + optional embeddings, fused with reciprocal rank fusion), answers in Markdown with `path:start-end` citations.
- **PR review**: triggered by a GitHub webhook or the API. Reviews each changed file with related code pulled from the index, then posts a GitHub review with a summary and inline comments on the changed lines.
- **Historical PR context**: traces recent commits for changed files on the PR's base to related merged PRs. Reviews can use their descriptions and available stored RepoLens findings, with PR and commit links, to check for regressions. Looks back at three commits per path for up to eight paths, with at most twelve commit-to-PR lookups and three historical PRs. History is treated as potentially outdated context and fetched on demand without a separate embedding index; lookup failures do not block a review.
- **PR chat**: owners, members, and collaborators can mention the bot handle in a PR comment (`@repolens why does this change X?`) to get an answer posted back.
- **REST API** modeled on Greptile's (`/api/repositories`, `/api/query`, `/api/search`, `/api/reviews`).
- **Dashboard** at `/` for adding repos, chatting, running reviews, and setting per-repo review instructions.
- **Usage and cost**: every LLM and embedding call is recorded; the dashboard's Usage page shows tokens per day, provider and model with a dollar figure priced from OpenRouter's public model list (exact where the backend reports a cost, estimated for the subscription CLIs).
- **CLI** for indexing, asking, and reviewing from the terminal.

## Quick start

Requirements: Node 20+ and `git` on the PATH.

```bash
git clone <this repo> repolens && cd repolens
npm install
cp .env.example .env   # edit it
npm start              # http://localhost:3000
```

Set `REPOLENS_API_TOKEN` to a random secret before starting (for example, generate one with `openssl rand -hex 32`). Empty tokens and the example `change-me` value are rejected. The server binds to `127.0.0.1` by default; use `REPOLENS_HOST` to change it deliberately, and terminate HTTPS at your reverse proxy when exposing the service.

### Option A: OpenRouter (any model)

```env
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-...
LLM_MODEL=anthropic/claude-sonnet-4.5     # or openai/gpt-5, google/gemini-2.5-pro, deepseek/deepseek-chat, ...
EMBEDDING_API_KEY=sk-or-...               # optional, enables vector search
EMBEDDING_MODEL=openai/text-embedding-3-small   # or qwen/qwen3-embedding-8b, etc.
```

If OpenRouter returns a 401 from the embeddings endpoint while chat works, check the account's BYOK (bring-your-own-key) settings for that upstream provider, or pick an embedding model from a different provider. The embedding model must stay the same for the life of a database; changing it requires deleting `data/repolens.db` and reindexing.

### Option B: Claude subscription

```bash
claude login            # once, on the machine that runs RepoLens
```

```env
LLM_PROVIDER=claude-cli
LLM_MODEL=              # blank = CLI default; or e.g. sonnet / opus
```

No API key is needed. Leave `EMBEDDING_MODEL` blank to run fully key-free with lexical retrieval, or point `EMBEDDING_BASE_URL` at any OpenAI-compatible embeddings server (OpenRouter, OpenAI, Ollama's `/v1`, LM Studio) for vector search.

CLI providers run one completion at a time to stay within subscription rate limits. Reviews of large PRs take a few minutes.

### Chat vs. review backends

Reviews want depth; chat wants first tokens on screen fast. RepoLens runs them on separate backends when you ask it to:

```env
LLM_PROVIDER=claude-cli         # reviews
LLM_MODEL=sonnet
LLM_REASONING_EFFORT=medium     # reviews only; chat never inherits this
CHAT_PROVIDER=claude-cli        # chat (blank = same as LLM_PROVIDER)
CHAT_MODEL=haiku                # blank = same as LLM_MODEL
```

`CHAT_MODEL` takes whatever the chat provider understands: `haiku` for the Claude CLI, `openai/gpt-4o-mini` or `anthropic/claude-haiku-4.5` for OpenRouter. `GET /api/health` reports both backends. Chat always runs at low reasoning effort: on the Claude CLI the default thinking budget costs about 17 s before the first token.

### Streaming answers

`POST /api/query` with `"stream": true` returns `text/event-stream`:

| event | payload | when |
| --- | --- | --- |
| `sources` | `Source[]` | retrieval finished (about 0.1 s) |
| `delta` | `{ "text": "…" }` | repeatedly, as the model writes |
| `message` | `{ "content": "…" }` | the complete answer, authoritative |
| `done` | `{}` | end of stream |
| `error` | `{ "error": "…" }` | failure; the response stays 200 |

Prefer the authoritative `message` over concatenating deltas. The dashboard streams by default and `repolens ask` writes deltas straight to stdout. Providers without streaming support fall back to one completion emitted as a single delta, so the SSE shape never changes.

## Using it

With `LLM_PROVIDER=openrouter` and `LLM_MODEL=qwen/qwen3-coder`, a review uses one request for all files and the summary. Shared context is sent once, and retrieval uses the local lexical index without paid query embeddings. Other models keep the per-file pipeline.

Qwen review requests reserve at most **$0.245**, below the $0.25 per-run limit: UTF-8 bytes conservatively bound input tokens (plus message overhead), output is limited to 8,000 tokens, and OpenRouter routing is capped at $0.40/M input and $2/M output with no per-request fee. Retries and provider fallbacks are disabled to avoid duplicate charges after an ambiguous failure. If no provider meets those prices, the run fails rather than exceeding the budget. This covers review inference, not separate repository indexing jobs.

The dashboard’s past-review list shows the reported inference cost for each new review, summed across its calls. Historical reviews and reviews with missing cost reports show “Cost unavailable”; cached reviews retain their original cost. This excludes chat and repository indexing costs.

All selected file diffs are included in full; optional post-change and indexed context is added only while it fits. Reviews exceeding the budget or the 40-file limit fail with an explicit error asking for a smaller PR. Truncated responses or responses missing a reviewed path also fail without posting or caching a clean review.

Run the opt-in paid check with `node --env-file=.env --import tsx scripts/check-review-cost.ts`. It sends only generated synthetic code, reviews 40 files, checks for a planted authorization bug in the last file, asserts the reported cost is at most $0.25, and never posts to GitHub. A run on 2026-09-04 cost **$0.00608** (23,749 input tokens, 509 output tokens), with a conservative reservation of $0.04278.

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
npm run cli -- pulls github:owner/name              # open PRs and their review status
npm run cli -- review github:owner/name 42 --post
npm run cli -- review github:owner/name --all --post  # every unreviewed open PR (--force re-reviews)
```

### GitHub setup

RepoLens can learn about new changes two ways. **Polling** (default, every 5 minutes) needs no inbound network access: it reindexes when the tracked branch moves and reviews any open, non-draft PR whose head commit hasn't been reviewed. **Webhooks** react instantly but need the server reachable from the internet (a reverse proxy or a Cloudflare Tunnel). Both can be on at once; reviews are deduped by head commit.

1. For a dedicated bot identity, [configure a GitHub App](docs/INTEGRATION.md#github-app-authentication). Alternatively, create a token with `repo` scope (classic PAT) or a fine-grained token with *Contents: read*, *Pull requests: read & write* and *Commit statuses: read & write* (the last one for the [blocking check](#blocking-merges-on-the-review)). Put it in `GITHUB_TOKEN`. Private repos are cloned with this token.
2. (Webhooks only) In the repository (or org) settings add a webhook:
   - Payload URL: `https://<your host>/webhooks/github`
   - Content type: `application/json`
   - Secret: the value of `GITHUB_WEBHOOK_SECRET` (required; the endpoint returns 503 without it)
   - Events: *Pull requests*, *Issue comments* and *Pushes*
3. Index the repository (API, CLI, or dashboard). New and updated PRs are then reviewed automatically and the review is posted to the PR. Comments that mention `REVIEW_BOT_HANDLE` (default `@repolens`) get an answer.

Per-repository review instructions (coding standards, what to ignore) can be set in the dashboard's Settings tab or via `PUT /api/repositories/:id/instructions`.

## API

All `/api/*` routes except `/api/health` require `Authorization: Bearer <REPOLENS_API_TOKEN>`. Repository ids are `github:owner/name`.

| Method | Path | Body / notes |
| --- | --- | --- |
| GET | `/api/health` | provider, model, embeddings |
| GET | `/api/repositories` | list |
| POST | `/api/repositories` | `{ remote: "github", repository: "owner/name", branch? }` → 202 with `jobId`. Branch defaults to the repository's default branch |
| GET | `/api/repositories/:id` | status, counts |
| POST | `/api/repositories/:id/reindex` | → `jobId` |
| PUT | `/api/repositories/:id/instructions` | `{ instructions }` |
| DELETE | `/api/repositories/:id` | |
| POST | `/api/query` | `{ messages, repositories, stream? }` → `{ message, sources }` (SSE when `stream: true`) |
| POST | `/api/search` | `{ query, repositories, limit? }` → chunks |
| GET | `/api/repositories/:id/pulls` | open pull requests with their review status (`none`, `pending`, `reviewed`, `error`). 400 for local repos, 502 when GitHub fails |
| POST | `/api/repositories/:id/pulls/review` | `{ prNumbers?, post? (default true), force? }` → 202 with `{ jobs, skipped }`. Without `prNumbers`, reviews every open non-draft PR that has no review for its head commit |
| POST | `/api/reviews` | `{ repository, prNumber, post? (default true), force? }` → 202 with `jobId` |
| GET | `/api/reviews?repository=` | past reviews with findings |
| GET | `/api/jobs/:id` | job status and progress |
| GET | `/api/usage?days=` | tokens and cost per day, provider and model (default 30 days, max 365). `costUsd` is the reported cost plus an OpenRouter list-price estimate for calls that reported none; `null` when the model has no price |
| POST | `/webhooks/github` | GitHub webhook (HMAC verified) |

## Configuration

See `.env.example` for every variable. The important ones:

| Variable | Default | Purpose |
| --- | --- | --- |
| `REPOLENS_DATA_DIR` | `./data` | SQLite database and repository clones |
| `REPOLENS_API_TOKEN` | empty | Required bearer token for the server; empty and placeholder values are rejected |
| `REPOLENS_PORT` | `3000` | |
| `REPOLENS_HOST` | `127.0.0.1` | Interface to listen on; Docker Compose binds all container interfaces but publishes only host loopback |
| `LLM_PROVIDER` | `openrouter` | `openrouter`, `claude-cli`; `codex-cli` is temporarily disabled |
| `LLM_MODEL` | | Model id (OpenRouter) or model name (CLIs, optional) |
| `LLM_TIMEOUT_MS` | `300000` | Per-completion timeout |
| `EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY` / `EMBEDDING_MODEL` | OpenRouter / empty / empty | OpenAI-compatible embeddings. Blank model = lexical only |
| `GITHUB_TOKEN` | | Clone private repos, read PRs, post reviews (PAT fallback) |
| `GITHUB_APP_ID` | | GitHub App ID; App authentication takes precedence over the PAT |
| `GITHUB_APP_INSTALLATION_ID` | | Installation ID for this instance's account |
| `GITHUB_APP_PRIVATE_KEY_PATH` | | Path to the App's RSA PEM private key; all three App fields are required |
| `GITHUB_WEBHOOK_SECRET` | | Verifies webhook payloads. The webhook endpoint refuses requests until this is set |
| `REVIEW_BOT_HANDLE` | `@repolens` | Mention that triggers PR chat |
| `REPOLENS_POLL_INTERVAL` | `300` | Seconds between GitHub polls for new commits and PRs. `0` disables polling |
| `CHAT_MODEL` | empty | Model for chat answers, e.g. `haiku` on the Claude CLI; blank = `LLM_MODEL` |
| `REVIEW_STATUS_CONTEXT` | `repolens/review` | Name of the commit status reported on the PR head. Blank disables statuses |
| `REVIEW_FAIL_ON` | `critical` | Which findings make that status fail: `critical`, `warning`, or `never` |

## Docker

```bash
docker compose up --build
```

The Docker image works with `LLM_PROVIDER=openrouter`. Claude CLI needs the `claude` binary and its login state, so for that provider run `npm start` directly on the host.

## How review works

1. A poll, a webhook, or an API call queues a review job. Jobs run one at a time. A push to the tracked branch queues an incremental reindex first, so reviews see current code.
2. The PR diff is fetched from GitHub and split into files and hunks. Lockfiles, vendored, generated and binary files are skipped.
3. For every reviewable changed file, including deletions, related code is retrieved from the index and the model is asked for findings as JSON. Failed or malformed reviews and file-limit overflow produce an error status instead of a successful partial review.
4. A summary and verdict are generated, then a single GitHub review is posted. Findings on added lines become inline comments; deletion-only findings remain in the review body and still count toward the blocking status. Intentionally excluded files are listed in the body. Findings already commented on a previous run are skipped, so `synchronize` events don't pile up duplicates.
5. Reviews are deduped by head commit. Use `force: true` to re-run.

### Blocking merges on the review

RepoLens reports a commit status named `repolens/review` (`REVIEW_STATUS_CONTEXT`) on the PR's head commit: **pending** while the review is queued or running, **success** when there are no blocking findings, and **failure** when there are. `REVIEW_FAIL_ON` decides what blocks — `critical` (default) fails only on critical findings, `warning` also fails on warnings, and `never` keeps the check purely informational (always green). If the review itself fails (the model or GitHub is down), the status is set to **error** rather than left hanging on pending. The status description carries the counts (`2 critical, 3 warnings, 1 nit`) and links to the posted review.

To actually block merges, require the check on the base branch: **Settings → Branches → branch protection rule** (or a repository ruleset) → *Require status checks to pass before merging* → add `repolens/review`. The check only appears in that list after RepoLens has reported it at least once, so run one review first.

Pushing fixes moves the PR head, which triggers a fresh review of the new commit; when the blocking findings are gone the new head's status turns green and the PR becomes mergeable. Set `REVIEW_STATUS_CONTEXT=` (blank) to stop reporting statuses altogether.

With a personal access token the status shows up under that token owner's account (their avatar and name); a GitHub App installation token reports as the app instead. The token needs write access to the repository's commit statuses (`repo` scope on a classic PAT, or *Commit statuses: read & write* on a fine-grained one).

PR title, body and comments are treated as untrusted data in the prompts, but as with any LLM reviewer, a determined author can still influence the output. Never give RepoLens a token with more scope than it needs.

After upgrading from a version that allowed partial reviews to pass, force a fresh review of open PRs. Existing cached reviews and GitHub statuses are historical results and are not retroactively validated.

## Development

```bash
npm test          # vitest
npm run typecheck
npm run dev       # server with reload
```

Design notes live in `docs/plans/`. To wire another repository up as a merge-blocking check, follow `docs/INTEGRATION.md`.
