# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

RepoLens is a self-hosted Greptile clone: it indexes git repositories into SQLite, answers codebase questions with `path:start-end` citations, and reviews GitHub pull requests, posting a review with inline comments and a `repolens/review` commit status that can gate merges. One Node process, no external services. LLM backends are swappable: OpenRouter (HTTP), the `claude` CLI (Claude subscription), and the `codex` CLI (ChatGPT subscription).

## Commands

```bash
npm start                      # server + dashboard on :3000 (reads .env)
npm run dev                    # same, with reload
npm test                       # vitest, all suites
npx vitest run tests/review    # one directory
npx vitest run tests/review/reviewer.test.ts -t "commit statuses"   # one test by name
npm run typecheck              # tsc --noEmit (no build step; tsx runs TS directly)
node --check web/app.js        # the dashboard is plain JS with no build; this is its only static check

npm run cli -- index owner/name [--branch b]      # or a local path
npm run cli -- ask github:owner/name "question"   # streams to stdout
npm run cli -- pulls github:owner/name
npm run cli -- review github:owner/name 42 [--post] [--force]
npm run cli -- review github:owner/name --all [--post]
```

Tests never touch the network or real CLIs: providers take an injected `fetch` or `run`, GitHub is a fake object, and `openDb(':memory:')` gives a fresh SQLite. Git tests build real temp repositories. When gating a push on tests in a shell chain, check vitest's exit code, not the exit code of a `grep` on its output.

## Architecture

**Dependency wiring.** `src/server.ts` `buildDeps(config)` constructs everything and returns `AppDeps` (`src/app.ts`): `db`, `llm` (review backend), `chatLlm` (chat backend, always built at low reasoning effort), `embeddings | null`, `retrieve`, `github`, `jobs`. Every module below takes its collaborators as arguments; nothing reaches for globals. Tests build `AppDeps` by hand with fakes.

**Config** is env-only (`src/config.ts`, zod). `.env` is loaded by `src/cli.ts`, not by the server module. Review and chat are separate backends: `LLM_PROVIDER`/`LLM_MODEL`/`LLM_REASONING_EFFORT` for reviews, `CHAT_PROVIDER`/`CHAT_MODEL` for chat. Config validation happens in `loadConfig`, not in the provider factory.

**Providers** (`src/llm/`) implement `LLMProvider { complete, stream? }`. `createProvider(config, { provider?, model?, reasoningEffort? })` is the only factory. CLI providers spawn a process per call through `src/llm/spawn.ts`, which strips nested-session env vars (`CLAUDECODE`, `CLAUDE_CODE_*`) and serialises calls with a semaphore shared per binary, so two provider instances still run one CLI process at a time. Do not pass `--bare` to `claude`: it skips keychain reads and the subscription login disappears. `extractJson` in `src/llm/json.ts` is how every JSON-mode response is parsed; models wrap JSON in prose and fences.

**Storage** (`src/db.ts`) is one SQLite file: `repos`, `files`, `chunks`, an FTS5 external-content table over chunks kept in sync by triggers, a `sqlite-vec` `chunk_vec` table created lazily once the embedding dimension is known (the dimension is pinned in `meta`; changing the embedding model means deleting the database), `reviews`, and `jobs`. Repo ids are `github:owner/name` (lowercased) or `local:name`.

**Indexing** (`src/indexer/`) clones into `data/repos/<id>` and indexes incrementally by git blob hash: unchanged files are skipped, removed files are deleted along with their chunks and vectors, and chunks without vectors are backfilled when embeddings are on. `chunkFile` splits on language-aware definition boundaries with a fallback window; `shouldIndex` excludes vendored, generated, lockfile and binary paths. Git credentials are passed per invocation via `http.extraheader`, never written into the clone.

**Retrieval** (`src/search/`) fuses BM25 (FTS5) and vector kNN with reciprocal rank fusion, then multiplies by `pathWeight`: source 1.0, docs 0.8, tests 0.7, changelogs 0.6, with a boost when query terms appear in the path. Without an embedding provider it is lexical-only and still works. `formatContext` packs chunks under a character budget.

**Question answering** (`src/query/answer.ts`) does one LLM call. Follow-up turns do not rewrite the question with the model; `buildFollowUpQuery` reuses citation paths and identifiers from the previous turn for retrieval. Streaming flows `onDelta` → `streamAnswer` in `src/app.ts` → SSE events `sources`, `delta`, `message`, `done`, `error`. The `message` event is authoritative; the Codex CLI can only stream a single final delta.

**Review pipeline** (`src/review/`): `reviewPullRequest` fetches the PR and diff, parses it (`diff.ts`), skips unreviewable files, and reviews each file with two kinds of context: the post-change content of the PR's own changed files fetched at the head sha (authoritative), and index chunks for paths not changed in the PR (`excludePaths`). This distinction exists because the index reflects the base branch; feeding stale chunks for changed paths produced false "export does not exist" criticals that blocked merges. Findings are kept only on added lines (`changedNewLines`). Reviews are deduped by head sha; a failed GitHub post is retried on the next run rather than cached as done. `createReview` degrades in two steps on 422: `REQUEST_CHANGES` → `COMMENT` keeping inline comments, then comments folded into the body. Commit status transitions are `pending` → `success`/`failure` per `REVIEW_FAIL_ON`, or `error` if the review throws; status posting never fails the review. Each review also carries lineage (`src/review/lineage.ts`): the PR's commit list, an overview read from `CLAUDE.md`/`ARCHITECTURE.md`/`README.md` at the base sha, and, on a re-review, the previous review's findings plus the compare diff from its head to the current one. Findings are never carried forward mechanically; the prompt tells the model to re-report what still applies, drop what the delta fixed, and retract what it now judges wrong. Every lineage fetch degrades to a warning.

**Triggers.** Three paths lead to `enqueueReview`/`enqueueIndex` in `src/app.ts`: the GitHub webhook (`src/review/webhook.ts`, HMAC-verified, refuses to run without a secret), the poller (`src/poller.ts`, default every 300 s, needs no inbound network; reindexes when the tracked branch moves and reviews open PRs whose head has no posted review), and the API/CLI/dashboard (`src/review/pulls.ts` lists open PRs with status and reviews one or all). `JobQueue` (`src/jobs.ts`) runs one job per kind at a time and tags review jobs with `pr_number` so pending reviews are detectable. Automatic triggers (webhook, poller) go through `scheduleReview`, which debounces per PR for `REVIEW_SETTLE_SECONDS` (default 300) via `JobQueue.schedule` so a flurry of pushes costs one review; the poller skips PRs with a scheduled review rather than restarting the window. Manual triggers (API, CLI, dashboard) call `enqueueReview` directly and run immediately. A review re-checks the PR head before each file's LLM call and before the summary; if it moved it throws `ReviewSupersededError`, leaves the stale sha's status alone, and lets the trigger for the new head review it.

**Usage** (`src/usage/`). Every provider and the embedding client take an `onUsage` callback and emit one normalised `UsageRecord` per call (fresh input, cache reads, cache writes, output, and the cost when the backend reports one: OpenRouter via `usage.include`, the Claude CLI via `total_cost_usd`; Codex reports tokens only, read from the `turn.completed` event that `--json` adds to its stdout). `buildDeps` binds one sink per role (`review`, `chat`, `embed`) through `UsageTracker`, which writes `llm_usage` rows and builds the `GET /api/usage` report per UTC day, provider, model and role. Calls without a reported cost are priced from OpenRouter's public `/models` list (`OpenRouterPricing`, cached in `meta` under `openrouter_pricing`, refreshed daily, never fetched at startup); CLI model names are mapped to OpenRouter ids by `candidateIds`, and a model with no match is reported as unpriced rather than free.

**Dashboard** (`web/`) is vanilla JS served statically; it talks to the same API with a bearer token kept in localStorage and reads SSE via `fetch` + `ReadableStream`.

## Workflow

- Never develop on `main`. For any feature or fix, create a git worktree on a new branch and work there:
  ```bash
  git worktree add ../repolens-<feature> -b feat/<feature>
  cd ../repolens-<feature> && npm install
  ```
  The worktree gets its own `node_modules`; copy `.env` in if you need to run the server from it (it is gitignored).
- When the work is done and `npm test` plus `npm run typecheck` pass, push the branch and open a pull request against `main`. RepoLens reviews the PR and sets the `repolens/review` status; `main` requires it, so fix any critical findings and push again until the status is green, then merge (`gh pr merge --merge --delete-branch`). A PreToolUse hook (`.claude/settings.json` → `scripts/require-review.sh`) refuses `gh pr merge` while the PR head's `repolens/review` status is anything but `success`, so every pushed commit must be reviewed before it can be merged; pass the PR number explicitly.
- Remove the worktree after the merge: `git worktree remove ../repolens-<feature>`.

## Operational notes

- `data/` holds the database and clones and is gitignored. `.env` is gitignored; `.env.example` documents every variable.
- `docs/INTEGRATION.md` is the recipe for making the review a required check on another repository (ruleset JSON, verification, security caveat that a PAT-set status is settable by any writer). `docs/plans/` holds the original design and plan.
- `deploy/com.repolens.server.plist` contains absolute paths for this checkout; regenerate it if the directory moves.
- The repository's own PRs are reviewed by a RepoLens instance and gated by the `repolens/review` status on `main`.
