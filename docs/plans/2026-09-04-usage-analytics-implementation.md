# Usage and Cost Analytics Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or subagent-driven-development) to implement this plan task-by-task.

**Goal:** Record every LLM and embedding call's token usage, price it from OpenRouter's model list, and show per-day, per-provider, per-model totals on a dashboard page. Design: `docs/plans/2026-09-04-usage-analytics-design.md`.

**Architecture:** Providers emit a normalised `UsageRecord` through an `onUsage` callback. `UsageTracker` stores rows in a new `llm_usage` SQLite table and builds a per-day report, pricing unreported calls with a cached OpenRouter price list. `GET /api/usage` serves the report; the vanilla-JS dashboard renders it.

**Tech Stack:** TypeScript on Node (tsx, no build), Hono, better-sqlite3, zod, vitest. Dashboard is plain JS with no build step (`node --check web/app.js` is its only static check).

**Conventions:** Tests never touch the network or real CLIs; providers take injected `fetch` or `run`. Use `openDb(':memory:')` for a fresh database. Run `npx vitest run <path>` for one suite and `npm run typecheck` before every commit. Commit messages end with `Claude-Session: https://claude.ai/code/session_01H2EVvVV7eUfnmiJyqepjZB`.

---

## Shared contracts (read before any task)

`src/usage/types.ts` (Task 1 creates it; everything else imports it):

```ts
/** Which part of RepoLens made the call. */
export type UsageRole = 'review' | 'chat' | 'embed';

/**
 * One backend call's token usage, normalised so the same pricing formula works
 * for every provider: `inputTokens` is fresh (uncached) input, cache reads and
 * writes are separate, and `costUsd` is only set when the backend reported one.
 */
export interface UsageRecord {
  provider: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export type UsageSink = (record: UsageRecord) => void;
```

`Db` additions (Task 1):

```ts
interface UsageInsert { role: UsageRole; provider: string; model: string; input_tokens: number; cached_input_tokens: number; cache_write_tokens: number; output_tokens: number; cost_usd: number | null }
interface UsageDayRow {
  day: string; role: string; provider: string; model: string; calls: number;
  input_tokens: number; cached_input_tokens: number; cache_write_tokens: number; output_tokens: number;
  reported_cost_usd: number;          // sum of cost_usd where not null
  unpriced_input_tokens: number;      // token sums over calls whose cost_usd is null
  unpriced_cached_input_tokens: number;
  unpriced_cache_write_tokens: number;
  unpriced_output_tokens: number;
  unpriced_calls: number;
}
db.insertUsage(row: UsageInsert): void
db.usageByDay(sinceIso: string): UsageDayRow[]   // ts >= sinceIso, ordered day desc, provider, model, role
db.getMeta(key: string): string | undefined
db.setMeta(key: string, value: string): void
```

Provider option (Tasks 2 to 4): every provider options interface gains `onUsage?: UsageSink`. `createProvider(config, opts)` gains `onUsage?: UsageSink` in `CreateProviderOptions`; `createEmbeddings(config, opts?: { onUsage?: UsageSink })`.

Pricing (Task 5):

```ts
export interface ModelPrice { prompt: number; completion: number; inputCacheRead: number; inputCacheWrite: number } // USD per token
export interface PriceList { fetchedAt: string; models: Record<string, ModelPrice> }
export class OpenRouterPricing {
  constructor(opts: { db: Db; baseUrl: string; fetch?: typeof fetch; ttlMs?: number; now?: () => number });
  /** Refresh if stale; never throws. Returns the current list (possibly null) and the last error. */
  ensure(): Promise<{ list: PriceList | null; error: string | null }>;
  /** Pure: pick the first candidate id present in the list. */
  static resolve(list: PriceList, provider: string, model: string): ModelPrice | null;
  static estimate(price: ModelPrice, tokens: { inputTokens: number; cachedInputTokens: number; cacheWriteTokens: number; outputTokens: number }): number;
}
export function candidateIds(provider: string, model: string): string[];
```

API row shape (Tasks 6 and 7) is the JSON in the design doc: `day, role, provider, model, calls, inputTokens, cachedInputTokens, cacheWriteTokens, outputTokens, reportedCostUsd, estimatedCostUsd (number|null), costUsd (number|null), priced (boolean)`, wrapped in `{ days, since, pricing: { fetchedAt: string|null, error: string|null }, rows }`.

---

### Task 1: Usage types and storage

**Files:**
- Create: `src/usage/types.ts` (contents above)
- Modify: `src/db.ts` (SCHEMA, new methods)
- Test: `tests/db.test.ts`

**Step 1: Write the failing tests** (append to `tests/db.test.ts`)

```ts
describe('llm_usage', () => {
  let db: Db;
  beforeEach(() => { db = openDb(':memory:'); });

  const row = (over: Partial<Parameters<Db['insertUsage']>[0]> = {}) => ({
    role: 'review' as const, provider: 'codex-cli', model: 'gpt-5.6-terra',
    input_tokens: 100, cached_input_tokens: 50, cache_write_tokens: 0, output_tokens: 20, cost_usd: null, ...over,
  });

  it('aggregates per day, provider, model and role, splitting priced from unpriced calls', () => {
    db.insertUsage(row());
    db.insertUsage(row({ cost_usd: 0.5, input_tokens: 10, output_tokens: 1 }));
    db.insertUsage(row({ role: 'chat', provider: 'claude-cli', model: 'claude-haiku-4-5', cost_usd: 0.01 }));
    // An old row on another day, backdated by hand.
    db.raw.prepare(`update llm_usage set ts='2020-01-01T00:00:00.000Z' where id=1`).run();

    const all = db.usageByDay('2019-01-01');
    expect(all).toHaveLength(3);
    const today = db.usageByDay('2021-01-01');
    expect(today).toHaveLength(2);
    const codex = today.find((r) => r.provider === 'codex-cli')!;
    expect(codex.calls).toBe(1);
    expect(codex.reported_cost_usd).toBeCloseTo(0.5);
    expect(codex.unpriced_calls).toBe(0);
    expect(codex.input_tokens).toBe(10);
    const oldCodex = all.find((r) => r.day === '2020-01-01')!;
    expect(oldCodex.unpriced_calls).toBe(1);
    expect(oldCodex.unpriced_input_tokens).toBe(100);
    expect(oldCodex.reported_cost_usd).toBe(0);
    // Newest day first.
    expect(all[0]!.day > all[all.length - 1]!.day).toBe(true);
  });

  it('stores and reads meta values', () => {
    expect(db.getMeta('x')).toBeUndefined();
    db.setMeta('x', '1');
    db.setMeta('x', '2');
    expect(db.getMeta('x')).toBe('2');
  });
});
```

**Step 2: Run** `npx vitest run tests/db.test.ts` — expect failures: `insertUsage is not a function`.

**Step 3: Implement.** In `src/db.ts`: import `UsageRole` from `./usage/types.js`; add the `llm_usage` table and `llm_usage_ts` index from the design doc to `SCHEMA`; export `UsageInsert` and `UsageDayRow`; add methods:

```ts
  // ---- usage ----
  insertUsage(row: UsageInsert) {
    this.raw.prepare(
      `insert into llm_usage (role, provider, model, input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, cost_usd)
       values (@role, @provider, @model, @input_tokens, @cached_input_tokens, @cache_write_tokens, @output_tokens, @cost_usd)`,
    ).run(row);
  }

  /** Per UTC day, role, provider and model since `sinceIso` (inclusive), newest day first. */
  usageByDay(sinceIso: string): UsageDayRow[] {
    return this.raw.prepare(
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
    ).all(sinceIso) as UsageDayRow[];
  }

  // ---- meta ----
  getMeta(key: string): string | undefined {
    const r = this.raw.prepare(`select value from meta where key=?`).get(key) as { value: string } | undefined;
    return r?.value;
  }

  setMeta(key: string, value: string) {
    this.raw.prepare(`insert into meta (key, value) values (?, ?) on conflict(key) do update set value=excluded.value`).run(key, value);
  }
```

**Step 4: Run** `npx vitest run tests/db.test.ts && npm run typecheck` — expect pass.

**Step 5: Commit** `git add src/usage/types.ts src/db.ts tests/db.test.ts && git commit -m "feat(db): llm_usage table with per-day aggregation"`.

---

### Task 2: OpenRouter provider and embeddings report usage

**Files:**
- Modify: `src/llm/openrouter.ts`, `src/embeddings/index.ts`
- Test: `tests/llm/openrouter.test.ts`, `tests/embeddings.test.ts`

**Behaviour:**
- Request payload (both modes) gains `usage: { include: true }`.
- Non-streaming: after reading content, if `parsed.usage` is an object with numeric `prompt_tokens`/`completion_tokens`, call `onUsage` with `provider: 'openrouter'`, `model: this.model`, `inputTokens = prompt_tokens - cached`, `cachedInputTokens = cached` where `cached = usage.prompt_tokens_details?.cached_tokens ?? 0`, `cacheWriteTokens: 0`, `outputTokens = completion_tokens`, `costUsd = typeof usage.cost === 'number' ? usage.cost : null`.
- Streaming: frames may carry a top-level `usage` object (OpenRouter sends it on the final frame before `[DONE]`); remember the last one seen and emit it once the stream ends successfully. Never emit on a failed stream.
- Missing usage: emit nothing. Malformed usage (non-numeric): emit nothing.
- Embeddings: after a successful batch, if `parsed.usage?.prompt_tokens` is a number, emit `{ provider: 'embeddings', model: this.model, inputTokens: prompt_tokens, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: null }`. One record per batch.
- The provider must not let a throwing `onUsage` break a completion: wrap the call in try/catch.

**Tests to add** (use the existing `fakeFetch`/`jsonResponse`/`sseResponse` helpers in each test file):
1. `complete` records normalised usage including cost and cached tokens, and the payload includes `usage: { include: true }`.
2. `complete` with no `usage` in the body records nothing.
3. `stream` records the usage carried on the last frame; a stream ending without `[DONE]` records nothing.
4. A throwing `onUsage` does not fail the completion.
5. Embeddings: one record per batch with the batch's `prompt_tokens`; none when absent.

Run the two suites plus `npm run typecheck`; commit `feat(openrouter): report token usage and cost`.

---

### Task 3: Claude CLI provider reports usage

**Files:**
- Modify: `src/llm/claude-cli.ts`
- Test: `tests/llm/claude-cli.test.ts`

**Behaviour.** Both `runOnce` and `runStreaming` read usage from the final `result` object. The real shape (captured 2026-09-04):

```json
{"type":"result","is_error":false,"result":"pong","total_cost_usd":0.016316,
 "usage":{"input_tokens":10,"cache_creation_input_tokens":7508,"cache_read_input_tokens":0,"output_tokens":258},
 "modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":10,"outputTokens":258,"costUSD":0.016316,"canonicalModel":"claude-haiku-4-5"}}}
```

Emit `{ provider: 'claude-cli', model, inputTokens: usage.input_tokens, cachedInputTokens: usage.cache_read_input_tokens ?? 0, cacheWriteTokens: usage.cache_creation_input_tokens ?? 0, outputTokens: usage.output_tokens, costUsd: typeof total_cost_usd === 'number' ? total_cost_usd : null }` where `model` is the first `modelUsage` entry's `canonicalModel`, else that entry's key, else `this.model`. Emit only on success, only when `usage.input_tokens` and `usage.output_tokens` are numbers. Put the parsing in one private `emitUsage(final)` helper shared by both paths; wrap the sink call in try/catch. Extend `ClaudeCliResult` with the optional fields. Do not touch the argv.

**Tests:** (1) `complete` emits the record with the canonical model and reported cost; (2) `stream` emits from the `result` event (extend the `streamJson` helper's `extra` param); (3) no `usage` → nothing emitted; (4) `is_error: true` → nothing emitted; (5) falls back to the configured model when `modelUsage` is absent.

Commit `feat(claude-cli): report token usage and cost`.

---

### Task 4: Codex CLI provider reports usage

**Files:**
- Modify: `src/llm/codex-cli.ts`
- Test: `tests/llm/codex-cli.test.ts`

**Behaviour.** Add `--json` to the argv (after `--color never`, before `-C`). Stdout becomes line-delimited JSON; the real usage line (captured 2026-09-04) is:

```json
{"type":"turn.completed","usage":{"input_tokens":18114,"cached_input_tokens":15104,"output_tokens":97,"reasoning_output_tokens":90}}
```

`input_tokens` includes the cached tokens. Non-JSON lines (Codex logs errors to stderr, but be defensive) are ignored. After a successful run, scan `res.stdout` line by line for the last `turn.completed` event and emit `{ provider: 'codex-cli', model: this.model, inputTokens: input - cached, cachedInputTokens: cached, cacheWriteTokens: 0, outputTokens: output_tokens, costUsd: null }` when the numbers are present. The `-o` output file remains the answer; do not read the answer from stdout. Wrap the sink call in try/catch.

**Tests:** (1) argv contains `--json`; (2) a stdout containing the events above emits the normalised record with `inputTokens: 3010`; (3) stdout with noise lines and no `turn.completed` emits nothing; (4) a non-zero exit emits nothing.

Commit `feat(codex-cli): report token usage via --json`.

---

### Task 5: OpenRouter pricing

**Files:**
- Create: `src/usage/pricing.ts`
- Test: `tests/usage/pricing.test.ts`

**Behaviour** (see the design doc "Pricing" section):
- `GET ${baseUrl}/models` with headers `HTTP-Referer: https://github.com/repolens`, `X-Title: RepoLens`, `signal: AbortSignal.timeout(30_000)`. Response is `{ data: [{ id, pricing: { prompt, completion, input_cache_read?, input_cache_write? } }] }` with prices as decimal strings per token. Missing cache prices fall back to `prompt`. Skip entries with non-numeric `prompt`/`completion`.
- Persist the parsed `PriceList` as JSON in `meta` under key `openrouter_pricing`; load it in the constructor.
- `ensure()`: if the in-memory list is newer than `ttlMs` (default 24h) return it. Otherwise fetch; on success replace and persist; on any failure (network throw, non-2xx, bad JSON) remember the error message and keep the old list. Concurrent `ensure()` calls share one in-flight fetch.
- `candidateIds(provider, model)`:
  - `openrouter`: `[model, model.split(':')[0]]` (deduped).
  - `claude-cli`: if model is `haiku|sonnet|opus` → `~anthropic/claude-<model>-latest`; else `anthropic/<model with /-(\d+)-(\d+)$/ replaced by -$1.$2>`, then `anthropic/<model>`. Example: `claude-haiku-4-5` → `anthropic/claude-haiku-4.5`; `claude-opus-5` → `anthropic/claude-opus-5`.
  - `codex-cli`: `openai/<model>`.
  - `embeddings`: `[model, 'openai/' + model]`.
  - `default` (the unset-CLI-model placeholder) or empty model → `[]`.
- `resolve` returns the first candidate found; `estimate` applies the formula from the design doc.

**Tests** (inject `fetch` returning a canned `/models` body; use `openDb(':memory:')`): parses prices and cache fallbacks; caches in `meta` and reuses without fetching when fresh; a failed refresh keeps the previous list and reports the error; candidate mapping for each provider; estimate arithmetic (the Claude example in the design: 10 fresh, 7508 cache write at 1.25e-6, 258 output at 5e-6, prompt 1e-6 → 0.010685).

Commit `feat(usage): OpenRouter price list with meta cache`.

---

### Task 6: Tracker, wiring and API

**Files:**
- Create: `src/usage/tracker.ts`
- Modify: `src/llm/index.ts` (pass `opts.onUsage` into each provider), `src/embeddings/index.ts` (`createEmbeddings(config, opts)`), `src/app.ts` (`usage: UsageTracker` on `AppDeps`, `GET /api/usage`), `src/server.ts` (build tracker, bind sinks)
- Modify tests that build `AppDeps`: `tests/server.test.ts`, `tests/poller.test.ts`, `tests/review/pulls.test.ts` (add `usage: new UsageTracker({ db, pricing: null })` or similar)
- Test: `tests/usage/tracker.test.ts`, `tests/server.test.ts`

**Tracker:**

```ts
export class UsageTracker {
  constructor(opts: { db: Db; pricing: OpenRouterPricing | null; log?: (m: string) => void });
  sinkFor(role: UsageRole): UsageSink;   // inserts a row; catches and logs errors
  async report(days: number): Promise<UsageReport>;  // shape from the design doc
}
```

`report`: `since = new Date(Date.now() - days*86400000).toISOString().slice(0,10)`; rows from `db.usageByDay(since)`; `pricing?.ensure()` for the list; per row `estimatedCostUsd` is `null` when `unpriced_calls > 0` and no price resolves, else the estimate over the unpriced token sums (0 when there are none); `costUsd = reportedCostUsd + (estimatedCostUsd ?? 0)` but `null` when `reported == 0 && estimated == null`; `priced = unpriced_calls === 0 || estimatedCostUsd !== null`. `pricing: { fetchedAt: list?.fetchedAt ?? null, error }`; with no pricing object, `{ fetchedAt: null, error: 'pricing disabled' }`.

**Route:** `app.get('/api/usage')` parses `days` with `z.coerce.number().int().min(1).max(365).default(30)`, 400 on failure, returns `await deps.usage.report(days)`.

**Server:** `const pricing = new OpenRouterPricing({ db, baseUrl: config.llm.openrouterBaseUrl }); const usage = new UsageTracker({ db, pricing, log });` then `createProvider(config, { ..., onUsage: usage.sinkFor('review') })`, chat with `sinkFor('chat')`, `createEmbeddings(config, { onUsage: usage.sinkFor('embed') })`. Add `usage` to the returned deps.

**Tests:** tracker: sink inserts a row with the role; a sink whose insert throws logs and does not throw; report prices unpriced rows through a fake pricing object and passes reported cost through; server: `/api/usage` needs auth, rejects `days=0`, returns seeded rows with `costUsd`.

Commit `feat(api): GET /api/usage backed by UsageTracker`.

---

### Task 7: Dashboard usage page

**Files:**
- Modify: `web/index.html`, `web/app.js`, `web/style.css`

**Behaviour** (design doc "Dashboard" section):
- `index.html`: a `<button id="usage-nav" class="btn btn-ghost btn-sm" type="button">Usage</button>` row in the sidebar under the health box, and a `<div class="panel" id="usage-panel" hidden>` in `<main>` with a header (`h2` "Usage", a `select` with 7/30/90 days) and a `<div class="panel-body" id="usage-body">`.
- `app.js`: `state.view = 'repo' | 'usage'`, `state.usage = { days: 30, data: null, loading: false, error: null }`. `showUsage()` sets the view, hides the repo panel and empty state, loads `/api/usage?days=N` and renders. `selectRepo` sets the view back to `repo`. Rendering: summary strip (total cost with `$` and 4 decimals below $1, else 2; total tokens via `fmtCount`; calls), then a table grouped by day (a full-width row per day with the day's subtotal, then rows: provider, model, role, calls, input, cached, output, cost). Cost cell: `~$x` when `estimatedCostUsd > 0`, `$x` when fully reported, `—` with `title="No OpenRouter price for <model>"` when `costUsd` is null. Footnote with the pricing fetch time or error.
- `style.css`: `.usage-summary` strip (flex, cards reuse `--panel-2`), `.usage-table` with right-aligned numeric columns using `.mono`, `.usage-day` row style. Keep it in the existing aesthetic.
- Check with `node --check web/app.js`.

Commit `feat(web): usage page with per-day cost table`.

---

### Task 8: Docs

**Files:** `CLAUDE.md` (Architecture: add a **Usage** paragraph naming `src/usage/`, the `llm_usage` table, `/api/usage`, and the pricing cache in `meta`), `.env.example` (a comment that usage pricing reads OpenRouter's public model list from `OPENROUTER_BASE_URL` and needs no key), `README.md` if it lists API endpoints.

Commit `docs: usage analytics`.

---

### Task 9: Verify and ship

1. `npm test && npm run typecheck && node --check web/app.js`.
2. Start the server from the worktree (`npm start`), open the dashboard, click Usage, ask one chat question, confirm a row appears with a cost.
3. Push, open the PR against `main`, wait for the `repolens/review` status, fix criticals, merge, remove the worktree.
