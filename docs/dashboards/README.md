# RepoLens review dashboards

Import either JSON file with Traceway **Dashboards → Add dashboard → Import JSON** in the RepoLens Backend project. Both dashboards are already created at https://tracing.betalabs.org/dashboards?projectId=18304006-001c-46a3-aba0-9d9da3cba2b4.

These metrics begin with deployment of this instrumentation. There is no historical backfill. Missing series mean no observation yet, not zero spend or zero failures. Counters are cumulative per process; the charts use `rate` (per second), never `sum` of cumulative samples. Duration charts show averages; Traceway does not retain histogram buckets for percentiles.

| Service operation | Metric | Meaning |
| --- | --- | --- |
| Review invocation | `repolens.review.runs` | Started plus terminal completed, cache_hit, publication_failed, failed, or superseded. Completed means the workflow returned successfully, including requested publication. Cached repost failures also emit publication_failed. Executions, not unique PRs. |
| Select review scope | `repolens.review.files`, `repolens.review.diff_lines` | Eligible files and hunk lines after binary/generated/ignored/no-op filtering and the file-limit check. Once per uncached run, even if a later call fails. Lines split into add/del/ctx; excludes retrieved/head/history context and does not multiply by retries. This is selected diff scope, not all code read by an LLM. |
| Invoke review model | `repolens.review.llm.calls`, `repolens.review.llm.duration` | Each actual provider.complete invocation, including corrective retries/fallbacks. Stage, pass, provider, model, and provider success/error. Success means response returned, not that findings passed validation. Duration includes provider execution and any provider queue wait. |
| Reject model output | `repolens.review.llm.validation_errors` | Invalid structured/unfinished responses detected by the pipeline, by stage/model/pass. |
| Budget reservation rejected | `repolens.review.budget_blocks` | Call blocked before provider execution because its reservation exceeds the remaining ceiling. Not billed calls; does not include every downstream budget failure. |
| Final review findings | `repolens.review.findings` | Findings from successful new review workflows by severity. Cached/reposted results do not increment this. |
| Provider usage returned | `repolens.llm.usage_records` | One model usage block, not one request: Claude can report several models for one completion; embedding batches also report usage. |
| Token accounting | `repolens.llm.tokens` | Fresh input, cache reads, cache writes, output as separate token_type series. Role review/chat/embed; model/provider/stage/pass breakdowns. |
| Reported provider cost | `repolens.llm.reported_cost_usd` | Finite nonnegative backend-reported cost only. Includes reported zero. Claude subscription list-equivalent reported cost is not necessarily an incremental invoice charge. |
| Missing provider cost | `repolens.llm.unpriced_records` | Usage blocks with absent/invalid reported cost, including embeddings. Existing SQLite report may estimate these separately; estimates are not exported as actual spend. |

Review stages distinguish initial discovery, verification, escalation, arbitration, and follow-up reconciliation. Pass distinguishes normal, focused, and evidence work. Cache hits have no new diff scope or LLM usage. Prompt text, source code, repository IDs, PR numbers, paths, SHAs, and error messages are not metric dimensions. Existing index operations remain separate from PR-review scope.

After deployment, let normal reviews run and allow at least two periodic exports (about two minutes) for rate charts. Check AI Traces for `review.<stage>` spans and the new dashboards. Cost/token records are only available when providers return usage. OpenRouter and Claude CLI calls are traced; embedding usage is counted without changing its parent task into an AI trace. Built-in AI Traces cost fields are not populated by this change; the custom reported-cost metric is the cost source.

```sh
traceway metrics query --project 18304006-001c-46a3-aba0-9d9da3cba2b4 --name repolens.review.runs --aggregation max --since 1h
traceway metrics query --project 18304006-001c-46a3-aba0-9d9da3cba2b4 --name repolens.llm.tokens --group-by token_type --aggregation max --since 1h
```

Tests use in-memory OTel exporters and fake providers/GitHub; they send no synthetic metrics or paid calls to production.
