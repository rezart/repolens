# Usage and cost analytics (issue #3)

Show tokens used per day, per provider, per model in the dashboard, with a rough
dollar figure priced from OpenRouter's public model list.

## What each backend reports

Verified on 2026-09-04 with live calls:

| Backend | Where usage arrives | Fields | Cost |
|---|---|---|---|
| OpenRouter | `usage` in the JSON body; in streaming mode on the last frame before `[DONE]` when the request sets `usage: { include: true }` | `prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens` | `usage.cost` (USD) |
| Claude CLI | the `result` object (`--output-format json`) or the `result` event (`stream-json`) | `usage.input_tokens` (uncached), `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`; `modelUsage[<full id>].canonicalModel` names the model actually used | `total_cost_usd` (exact, list price) |
| Codex CLI | a `{"type":"turn.completed","usage":{...}}` line on stdout, only with `--json` | `input_tokens` (includes cached), `cached_input_tokens`, `output_tokens` | none |
| Embeddings | `usage.prompt_tokens` in the `/embeddings` body | prompt tokens only | none |

Token counts are normalised before storage so the pricing formula is the same
for every backend: `input_tokens` is fresh (uncached) input, `cached_input_tokens`
is cache reads, `cache_write_tokens` is cache creation, `output_tokens` is output.
Codex and OpenRouter report cached tokens inside the input total, so fresh input
is `input - cached` for them.

## Capture

`LLMProvider` implementations and `OpenAIEmbeddings` accept an optional
`onUsage(record)` callback in their constructor options. `createProvider` and
`createEmbeddings` take it through their options object, and `buildDeps` binds
one callback per role: `review`, `chat`, `embed`. Providers never throw because
of usage: a missing or malformed usage block records nothing, and the callback
is wrapped so a storage failure is logged, not surfaced to the caller.

A record is:

```ts
interface UsageRecord {
  provider: string;        // 'openrouter' | 'claude-cli' | 'codex-cli' | 'embeddings'
  model: string;           // resolved model when the backend names one, else the configured one
  inputTokens: number;     // fresh input
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costUsd: number | null;  // reported by the backend, null when it reports none
}
```

The Codex provider adds `--json` to its argv and parses stdout as line-delimited
JSON for the `turn.completed` event. The output file stays authoritative for the
answer text; stdout is only read for usage.

## Storage

One new table, created by `SCHEMA` and safe on existing databases:

```sql
create table if not exists llm_usage (
  id integer primary key autoincrement,
  ts text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  role text not null,          -- review | chat | embed
  provider text not null,
  model text not null,
  input_tokens integer not null default 0,
  cached_input_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd real                 -- reported cost; null when the backend gave none
);
create index if not exists llm_usage_ts on llm_usage(ts);
```

`Db.insertUsage(row)` writes one row per call. `Db.usageByDay(sinceIso)` returns
one row per UTC day, role, provider and model with call count, token sums, the
sum of reported cost, and separate token sums for the calls that reported no
cost. Those "unpriced" sums are what the estimator multiplies by list prices, so
a day that mixes reported and estimated calls is costed correctly.

## Pricing

`src/usage/pricing.ts` fetches `GET <OPENROUTER_BASE_URL>/models` (no key
needed) and keeps `{ id: { prompt, completion, input_cache_read, input_cache_write } }`
per token in memory and in the `meta` table under `openrouter_pricing`, with the
fetch time. The list is refreshed when older than 24 hours; a failed refresh
keeps the last good list. Nothing is fetched at startup; the first usage report
triggers it.

Model ids from the CLIs are mapped to OpenRouter ids by trying candidates in
order and taking the first that exists in the list:

- `openrouter`: the id as configured, then the id without a `:variant` suffix.
- `claude-cli`: `anthropic/<canonical with the version dash turned into a dot>`
  (`claude-haiku-4-5` becomes `anthropic/claude-haiku-4.5`), then
  `anthropic/<model>`, then `~anthropic/claude-<alias>-latest` for the bare
  aliases `haiku`, `sonnet`, `opus`.
- `codex-cli`: `openai/<model>`.
- `embeddings`: the model as configured, then `openai/<model>`.

A model with no match is unpriced: its estimate is `null`, never zero.

Estimate per row:

```
input * prompt + cached * input_cache_read + cacheWrite * input_cache_write + output * completion
```

Row cost = reported sum + estimate of the unpriced tokens. Reported cost wins
because it is exact; the Claude CLI's figure already reflects 1-hour cache
writes, which the list-price formula would understate.

## API

`GET /api/usage?days=30` (bearer auth like every other endpoint; `days` is an
integer 1 to 365, default 30):

```json
{
  "days": 30,
  "since": "2026-08-06T00:00:00.000Z",
  "pricing": { "fetchedAt": "2026-09-04T16:00:00.000Z", "error": null },
  "rows": [
    {
      "day": "2026-09-04", "role": "review", "provider": "codex-cli", "model": "gpt-5.6-terra",
      "calls": 12, "inputTokens": 30100, "cachedInputTokens": 151040, "cacheWriteTokens": 0, "outputTokens": 9700,
      "reportedCostUsd": 0, "estimatedCostUsd": 0.2094, "costUsd": 0.2094, "priced": true
    }
  ]
}
```

`since` is UTC midnight `days - 1` days ago, so the report covers today plus the
previous whole UTC days and the oldest day section is never partial. `priced` is
false when some calls in the row could not be priced; `costUsd` then
covers only the calls that could. `pricing.error` carries the last fetch error
when the list is stale or missing so the page can say why figures are missing.

The `UsageTracker` class (`src/usage/tracker.ts`) owns both halves: `sinkFor(role)`
returns the callback given to a provider, and `report(days)` runs the query,
refreshes pricing if needed, and builds the rows above. It lives on `AppDeps` as
`usage` so tests can hand the app a tracker over an in-memory database.

## Dashboard

A `Usage` button in the sidebar, under the health box, opens a third top-level
view next to the empty state and the repository panel. Selecting a repository
returns to the repository panel. The view has:

- A range selector: 7, 30, 90 days.
- A summary strip: total cost, total tokens, total calls for the range.
- A table with one section per day, newest first, rows per provider, model and
  role: calls, input, cached, output tokens, cost. Estimated costs are prefixed
  with `~`, unpriced rows show `—` with a tooltip naming the model that has no
  OpenRouter price.
- A footnote saying costs are OpenRouter list prices, that subscription CLIs are
  not billed per token, and when the price list was fetched.

The dashboard stays plain JS with no build step and reuses the existing `api`
helper, `h` builder and token formatting.

## Testing

- Provider tests feed each backend's real usage shape through the existing fake
  `fetch` / `run` and assert the normalised record, including the stream path
  and the missing-usage path.
- Codex tests check `--json` is in the argv and `turn.completed` is parsed.
- Db tests insert rows on two days and check the aggregation.
- Pricing tests inject `fetch` and cover candidate resolution, caching in `meta`,
  and a failed refresh keeping the previous list.
- Server tests hit `/api/usage` with seeded rows and a fake price list.

## Out of scope

Per-repository attribution, a CLI subcommand, budgets or alerts, and retention
pruning. Rows are a few hundred bytes each, so pruning can wait.
