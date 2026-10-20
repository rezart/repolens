# Private ChatGPT subscription provider

`subscription` calls a private Unix socket serving the pinned Software Factory
Codex broker. The broker checks ChatGPT authentication and completes text-only
turns with native tools disabled. RepoLens receives no account credentials and
has no subprocess, TCP, OpenRouter, or API-key fallback through this provider.
The existing `codex-cli` adapter remains disabled.

For subscription-only operation, use these settings:

```dotenv
MODEL_BILLING_MODE=subscription_only
SUBSCRIPTION_SOCKET_PATH=/run/software-factory/complete.sock
LLM_PROVIDER=subscription
LLM_MODEL=gpt-6.1-sol
CHAT_PROVIDER=subscription
CHAT_MODEL=gpt-6.1-sol
REVIEW_VERIFIER_MODEL=gpt-6.1-sol
REVIEW_ARBITER_MODEL=gpt-6-astra
REVIEW_FALLBACK_MODELS=
EMBEDDING_MODEL=
```

Keep any enabled escalation model as an explicit native subscription model ID.
Verification, arbitration, and escalation use separate provider instances and
turns, including when two roles use the same model. The optional independent
contract/concurrency discovery pass remains available. Authentication, capacity,
or model-availability failures block review; they cannot produce approval by
silently suppressing a failed role.

Remove API/provider/embedding credentials and explicit embedding/provider URLs
from the process environment. Remove `REVIEW_DISCOVERY_MAX_OUTPUT` entirely;
the broker cannot enforce OpenRouter sampling, dollar, or token routing caps.
The adapter rejects these controls directly, and review/chat call sites omit
them explicitly. The broker enforces a 256 KiB request, 1 MiB response, and a
maximum 300-second completion timeout. Oversized core diffs block review;
optional context may be omitted with an explicit review warning.

Mount only the broker socket into RepoLens. Its immediate parent must be a
private directory and the socket must deny world access. Do not mount the
account-authentication store, a host command socket, or a project workspace.
This is private, single-owner automation, not a public inference endpoint.

Indexing and FTS/lexical retrieval remain available with embeddings disabled.
This mode has no semantic/vector retrieval. Known input/output usage is retained even when the cache breakdown is unavailable.
In that case the known total stays in the input bucket, with no separately
measured cached tokens; zero in that bucket does not imply measured cache misses. The dashboard labels
the billing source **ChatGPT subscription**; monetary cost is unknown and is
never estimated from OpenRouter prices or advertised as unlimited/free usage.

The configured model IDs are requests, not verified entitlements. Deployment
must wait for live subscription smoke checks for each enabled role and for
the generation sandbox tests. Existing current-head GitHub/RepoLens gates
remain required. Migration PRs must not be opened while an existing paid
reviewer can automatically pick them up. Rollback must stop inference rather
than restore a paid provider implicitly.


## Private two-host deployment

Generation and the account-authenticated broker run on `codex-work`. The
existing RepoLens API/index remains on `external-docker`. A trusted SSH service
forwards a root-only Unix listener at
`/run/software-factory-review/complete.sock` on `external-docker` to
`/run/software-factory/complete.sock` on `codex-work`. The production Compose
file mounts only that remote socket directory read-only. There is no public
inference listener, account mount, workspace mount or native command socket.
Socket-directory mounting allows forwarding/broker restarts to replace socket
inodes without replacing the RepoLens container.

Use `deploy/subscription.example.env` as the inference portion of a new private
`/opt/repolens/subscription.env`. Preserve existing API authentication, GitHub
App identity, webhook secret, observability, severity/status policy, independent
passes and retry settings. Remove all paid-provider/API/embedding credentials,
provider URLs and `REVIEW_DISCOVERY_MAX_OUTPUT`; an empty credential override is
not a substitute for removing old process configuration. Preserve the original
file only as a protected backup for inspection, never as an active fallback.

Before opening migration PRs, independently review the complete boundary code,
back up the live database/index and prepare an isolated instance from tested
source and a consistent snapshot. Verify all model/effort combinations with
completed live subscription turns. Stop the old paid consumer before routing
webhooks or polls to the replacement, and preserve/reconcile queued and running
jobs. Do not run two publishers against the same live database. API health and
configuration validation alone are not evidence of a successful review.

The controlled instance must use the existing authenticated review API, GitHub
App publishing path, review history and latest-head status. It must actually
complete model review; do not write substitute passing statuses. A missing,
failed or stale review blocks merging. After each migration PR passes current
checks, review and applicable approvals, deploy the merged revision, recheck
subscription-only configuration and restart persistence, then enable calendar
generation. Rollback stops work and keeps paid routes disabled.

The deterministic factory boundary suite exercises the actual pinned Codex
binary with synthetic TLS/auth endpoints and forged native calls; RepoLens's
Unix-socket/provider and complete multi-role pipeline suites exercise strict
text/schema framing, blocked tools/config, capacity failures and retained FTS
retrieval. Reuse these tests instead of maintaining a second copy of Codex
protocol fixtures in this repository. A real-broker integration smoke and live
role review remain rollout checks; neither may be skipped or treated as passing
because a synthetic suite passed.
