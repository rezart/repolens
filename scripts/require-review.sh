#!/usr/bin/env bash
# Claude Code PreToolUse hook: refuse `gh pr merge` unless the PR head commit
# carries a repolens/review status of "success". Reads the tool call as JSON on
# stdin and answers with a permission decision on stdout.
set -u

cmd=$(jq -r '.tool_input.command // ""')
case "$cmd" in *"gh pr merge"*) ;; *) exit 0 ;; esac

deny() {
  jq -n --arg reason "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
  exit 0
}

# First non-flag token after "merge" is the PR (number, URL or branch); none means the current branch.
pr=$(printf '%s' "$cmd" | sed -n 's/.*gh pr merge//p' | tr -s ' ' '\n' | grep -v '^-' | grep -m1 .)
head=$(gh pr view ${pr:+"$pr"} --json headRefOid --jq .headRefOid 2>/dev/null) || head=''
[ -n "$head" ] || deny "Could not resolve the pull request for '$cmd'; pass the PR number to gh pr merge."

state=$(gh api "repos/{owner}/{repo}/commits/$head/status" --jq '[.statuses[] | select(.context=="repolens/review") | .state] | first // "missing"' 2>/dev/null) || state='unknown'
[ "$state" = success ] || deny "repolens/review is '$state' on head ${head:0:8}; wait for RepoLens to review this commit (status success) before merging."
exit 0
