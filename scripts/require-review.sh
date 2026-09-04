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
info=$(gh pr view ${pr:+"$pr"} --json headRefOid,url --jq '.headRefOid + " " + .url' 2>/dev/null) || info=''
head=${info%% *}
[ -n "$head" ] || deny "Could not resolve the pull request for '$cmd'; pass the PR number to gh pr merge."

# The PR's own URL names the repository, so a merge by URL checks that repo, not the cwd's.
repo=${info#* }; repo=${repo#https://github.com/}; repo=${repo%/pull/*}
state=$(gh api "repos/$repo/commits/$head/status" --jq '[.statuses[] | select(.context=="repolens/review") | .state] | first // "missing"' 2>/dev/null) || state='unknown'
[ "$state" = "success" ] || deny "repolens/review is '$state' on head ${head:0:8}; wait for RepoLens to review this commit (status success) before merging."

# Pin the merge to the commit that was checked, so a push between check and merge fails instead of slipping through.
case "$cmd" in *--match-head-commit*) exit 0 ;; esac
jq -n --arg command "$cmd --match-head-commit $head" '{hookSpecificOutput:{hookEventName:"PreToolUse",updatedInput:{command:$command}}}'
