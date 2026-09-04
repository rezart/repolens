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
2. A GitHub token in RepoLens's `GITHUB_TOKEN` with, for the target repo: `Contents: read`, `Pull requests: read & write`, `Commit statuses: write` (classic PAT: `repo` scope covers all three). Statuses and reviews appear under the token owner's account.
3. `gh` authenticated as a repo admin on the machine where you run the commands below.
4. RepoLens reachable by you (default `http://localhost:3000`) and its `REPOLENS_API_TOKEN`.

Set these once in your shell:

```bash
export REPOLENS_URL=http://localhost:3000
export REPOLENS_API_TOKEN=...      # from RepoLens's .env
export REPO=OWNER/REPO
```

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
- Classic branch protection works as well: `gh api -X PUT repos/$REPO/branches/main/protection` with `required_status_checks.contexts: ["repolens/review"]`. Rulesets are preferred.

Verify:

```bash
gh api "repos/$REPO/rulesets" --jq '.[] | {id, name, enforcement}'
```

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
