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
This mode has no semantic/vector retrieval. Token usage is recorded when the
broker supplies actual input, output, and cache counts. The dashboard labels
the billing source **ChatGPT subscription**; monetary cost is unknown and is
never estimated from OpenRouter prices or advertised as unlimited/free usage.

The configured model IDs are requests, not verified entitlements. Deployment
must wait for live subscription smoke checks for each enabled role and for
the generation sandbox tests. Existing current-head GitHub/RepoLens gates
remain required. Migration PRs must not be opened while an existing paid
reviewer can automatically pick them up. Rollback must stop inference rather
than restore a paid provider implicitly.
