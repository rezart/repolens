# Integrating RepoLens as a required check

This is a step-by-step recipe for wiring a GitHub repository to a running RepoLens instance so that every pull request is reviewed automatically and cannot be merged while the review reports blocking findings. It is written so an agent (or a person) can execute it end to end with the `gh` CLI. Replace `OWNER/REPO` throughout.

## What you get

- Every open, non-draft PR is reviewed on its head commit. The review is posted as a GitHub review with inline comments.
- RepoLens sets a commit status named `repolens/review` on the PR head:
  - `pending` while the review is queued or running
  - `success` when there are no blocking findings
  - `failure` when there are (by default: any `critical` finding; `REVIEW_FAIL_ON=warning` also fails on warnings)
  - `error` if the review itself could not run
- A branch ruleset requires that status to be `success` before merging into the base branch.
- Pushing a fix creates a new head commit, RepoLens reviews it again, and the status turns green when the blocking findings are gone.

## Prerequisites

1. A running RepoLens instance (`npm start`, the launchd service, or Docker). See the README.
2. A [GitHub App installation](#github-app-authentication), or a GitHub token in RepoLens's `GITHUB_TOKEN` with, for the target repo: `Contents: read`, `Pull requests: read & write`, `Commit statuses: write` (classic PAT: `repo` scope covers all three). Statuses and reviews appear under the token owner's account.
3. `gh` authenticated as a repo admin on the machine where you run the commands below.
4. RepoLens reachable by you (default `http://localhost:3000`) and its `REPOLENS_API_TOKEN`.

Set these once in your shell:

```bash
export REPOLENS_URL=http://localhost:3000
export REPOLENS_API_TOKEN=...      # from RepoLens's .env
export REPO=OWNER/REPO
```

## GitHub App authentication

Use an App to post reviews under its own bot identity. A personal token cannot
request changes on a PR opened by the token owner. Marketplace publication is
not required.

1. Open **Settings → Developer settings → GitHub Apps → New GitHub App** on the
   account that owns the repositories. Choose a unique name and use your RepoLens
   repository URL as the homepage.
2. Leave user authorization/OAuth disabled. For polling only, uncheck **Active**
   under Webhook; no public server URL is needed.
3. Set repository permissions: **Contents: read**, **Pull requests: read & write**,
   and **Commit statuses: read & write**. If using issue-comment mentions, also
   grant **Issues: read & write**. Metadata read access is included by GitHub.
4. Choose **Only on this account** and create the App. Generate a private key,
   store the downloaded PEM outside version control (for example
   `data/github-app.pem`), and restrict its file permissions (`chmod 600`).
5. Under **Install App**, install it on the selected repositories RepoLens indexes.
   Copy the App ID from the App settings and the installation ID from the
   installation settings URL (`/settings/installations/<id>`).
6. Set these values in RepoLens's `.env` and restart:

   ```dotenv
   GITHUB_APP_ID=123456
   GITHUB_APP_INSTALLATION_ID=789012
   GITHUB_APP_PRIVATE_KEY_PATH=./data/github-app.pem
   ```

All three values are required together. App authentication takes precedence over
`GITHUB_TOKEN` for both API requests and private-repository fetches; it never
silently falls back to your personal identity if App authentication fails. Tokens
are cached in memory and renewed before expiry. Keep the PEM accessible to the
server user; in Docker, mount it read-only and use its container path.

This setup supports one installation per RepoLens instance. A private App can be
installed only on its owning account; use a separate instance/installation for
another account. Existing PAT-only configuration continues to work.

For webhooks, enable the App webhook with the existing `/webhooks/github` URL and
`GITHUB_WEBHOOK_SECRET`, subscribing to **Pull request**, **Push**, and optionally
**Issue comment**. Polling can remain enabled.

Verify the next posted review is authored by the App and the head commit has a
`repolens/review` status. RepoLens does not automatically submit approving reviews:
if branch protection requires reviews and an App request-changes review blocks a
later clean commit, dismiss that outdated review through GitHub. The required
`repolens/review` status remains the automatic severity-based merge gate.

## Step 1: register the repository with RepoLens

```bash
curl -sf -X POST "$REPOLENS_URL/api/repositories" \
  -H "Authorization: Bearer $REPOLENS_API_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"remote\":\"github\",\"repository\":\"$REPO\"}"
```

This clones and indexes the default branch. Poll until `status` is `ready`:

```bash
ID="github%3A$(echo "$REPO" | tr '[:upper:]' '[:lower:]' | sed 's#/#%2F#')"
curl -sf "$REPOLENS_URL/api/repositories/$ID" -H "Authorization: Bearer $REPOLENS_API_TOKEN" | jq '{status, file_count, chunk_count, error}'
```

From here on, RepoLens polls GitHub (every `REPOLENS_POLL_INTERVAL` seconds, default 300) for new commits and open PRs. No webhook is required. If you want instant triggering as well, see "Optional: webhook" below.

## Step 2: require the status check on the base branch

Create a ruleset on the default branch that requires the `repolens/review` status. This works on public repos and on private repos with GitHub Pro/Team.

```bash
gh api -X POST "repos/$REPO/rulesets" --input - <<'EOF'
{
  "name": "RepoLens review required",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [ { "context": "repolens/review" } ]
      }
    }
  ]
}
EOF
```

Notes:
- With an active ruleset and no bypass actors, repository admins are blocked too. To let admins bypass, add `"bypass_actors": [{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"}]` (5 = admin role).
- To also require a pull request (no direct pushes), add a second rule `{ "type": "pull_request", "parameters": { "required_approving_review_count": 0, "dismiss_stale_reviews_on_push": false, "require_code_owner_review": false, "require_last_push_approval": false, "required_review_thread_resolution": false } }`.
- Classic branch protection works as well, but it names the branch explicitly, so resolve the default branch first instead of assuming `main`:

  ```bash
  DEFAULT_BRANCH=$(gh repo view "$REPO" --json defaultBranchRef --jq .defaultBranchRef.name)
  echo '{"required_status_checks":{"strict":false,"contexts":["repolens/review"]},"enforce_admins":false,"required_pull_request_reviews":null,"restrictions":null}' \
    | gh api -X PUT "repos/$REPO/branches/$DEFAULT_BRANCH/protection" --input -
  ```

  Rulesets are preferred: `~DEFAULT_BRANCH` above needs no lookup.

Verify:

```bash
gh api "repos/$REPO/rulesets" --jq '.[] | {id, name, enforcement}'
```

### Security note

A commit status is not proof that RepoLens ran. When RepoLens authenticates with a personal access token, the `repolens/review` status it sets is an ordinary status that **anyone with write access to the repository can also set** — a green check can be posted by hand with `gh api -X POST repos/$REPO/statuses/$SHA -f state=success -f context=repolens/review`. The required check is therefore only as trustworthy as the set of people (and tokens) with write access.

For stricter enforcement:

- Run RepoLens under a dedicated GitHub App, or at least a bot account, whose credentials are used for nothing else and which holds only the permissions it needs (`Contents: read`, `Pull requests: read & write`, `Commit statuses: write`).
- With a GitHub App, pin the required check to that app so a status from any other actor does not satisfy the rule. Add the app's `integration_id` (from `gh api /apps/<app-slug> --jq .id`) to the required check:

  ```json
  "required_status_checks": [ { "context": "repolens/review", "integration_id": 123456 } ]
  ```

  A status with the same context set by a user or a different app then no longer counts, so the rule can only be satisfied by RepoLens itself.

## Step 3: prove it on a pull request

1. Open a PR with a real change. Within one poll interval the PR shows a `repolens/review` status as `pending`, then the review lands and the status becomes `success` or `failure`. Until the status exists, GitHub shows "Expected — Waiting for status to be reported" and blocks merging.
2. Check the status directly:
   ```bash
   SHA=$(gh pr view <number> -R "$REPO" --json headRefOid --jq .headRefOid)
   gh api "repos/$REPO/commits/$SHA/status" --jq '{state, statuses: [.statuses[] | {context, state, description}]}'
   ```
3. If it failed, fix the flagged lines and push. The new head is reviewed and the status is set again. Merge when green.

To trigger a review immediately instead of waiting for the poll:

```bash
curl -sf -X POST "$REPOLENS_URL/api/repositories/$ID/pulls/review" \
  -H "Authorization: Bearer $REPOLENS_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"prNumbers":[<number>]}'
```

Add `"force":true` to re-review a head that was already reviewed.

## Tuning

| Setting (RepoLens `.env`) | Effect |
| --- | --- |
| `REVIEW_FAIL_ON=critical` (default) | Only critical findings block the merge |
| `REVIEW_FAIL_ON=warning` | Warnings block too |
| `REVIEW_FAIL_ON=never` | Status is always `success`; the review is informational |
| `REVIEW_STATUS_CONTEXT=repolens/review` | Name of the status. Must match the ruleset. Blank disables statuses |
| Per-repo instructions | `PUT /api/repositories/$ID/instructions` with `{"instructions": "..."}`, or the dashboard Settings tab. Use this to tell the reviewer what counts as critical for this codebase |

## Optional: webhook for instant triggering

If RepoLens is reachable from GitHub (reverse proxy or tunnel), add a webhook so reviews start within seconds of a push instead of on the next poll. Set `GITHUB_WEBHOOK_SECRET` in RepoLens first; the endpoint refuses deliveries without it.

```bash
gh api -X POST "repos/$REPO/hooks" --input - <<EOF
{
  "name": "web",
  "active": true,
  "events": ["pull_request", "issue_comment", "push"],
  "config": { "url": "https://<public host>/webhooks/github", "content_type": "json", "secret": "<GITHUB_WEBHOOK_SECRET>" }
}
EOF
```

Polling and webhooks can both be on; reviews are deduplicated by head commit.

## Removing the integration

```bash
gh api -X DELETE "repos/$REPO/rulesets/<id>"
curl -sf -X DELETE "$REPOLENS_URL/api/repositories/$ID" -H "Authorization: Bearer $REPOLENS_API_TOKEN"
```

## Checklist for an agent

- [ ] `GITHUB_TOKEN` in RepoLens has commit-status write access to the repo
- [ ] Repository registered and `status: ready`
- [ ] Ruleset created requiring `repolens/review` on the default branch
- [ ] A test PR shows the status going `pending` → `success`/`failure`
- [ ] Merge button is blocked while the status is not `success`
