# Review lineage

## Problem

Every review of a pull request starts from nothing. On PR #9 the first review
raised one critical that was wrong (a `readFile` call it said was not awaited
was awaited). A no-op commit was pushed to satisfy it. The second review re-read
the whole diff cold: it raised a different wrong finding on the same line and
three new warnings on `web/app.js`, a file that had not changed between the two
heads and that the first review had passed without comment.

The reviewer has no memory across heads and no view of how the change was
built. `runReview` in `src/review/reviewer.ts` never reads earlier rows from
the `reviews` table. The prompt carries the PR title and body, the post-change
content of changed files, base-index chunks and the per-file diff. It does not
carry the PR's commits, the previous review's findings, the diff since the
previously reviewed head, or an overview of the codebase the PR lands in.

## Design

Three pieces of lineage go into both the file prompt and the summary prompt.
Findings are never carried forward mechanically: the model sees the previous
findings and the delta and decides what still applies. That is deliberate. A
mechanical carry-over would have kept PR #9's wrong critical alive until the
line changed, which is exactly the no-op commit we want to avoid.

### 1. Previous review of this PR

Before reviewing, load the most recent `done` review row for the PR (any head
sha) from the database. If one exists, fetch the unified diff between its head
sha and the current head from the GitHub compare endpoint. When the old head no
longer exists (force push) the compare call fails; the previous findings are
still supplied but the delta is reported as unavailable.

The file prompt gets, for the file under review:

- the previous review's head sha, verdict, and its findings on this file with
  their line numbers and titles;
- the hunks of the delta diff that touch this file, or a note that the file has
  not changed since the previous review, or a note that the delta is
  unavailable.

The system prompt gains rules for that section: re-report a previous finding
that still applies at its current line; drop one that the delta fixed; drop
one you now judge was wrong; on a file unchanged since the previous review,
add a finding only when confident, since the previous review of the same
lines raised nothing. Do not re-review from scratch.

The summary prompt gets the previous review's verdict and full findings list
next to the new findings, and is asked to say what changed since the previous
review and which earlier findings were resolved. The verdict rules are
unchanged.

Older reviews of the same PR are not supplied. Each review already incorporated
the one before it; only their count is mentioned ("review 3 of this PR").

### 2. Commits in the PR

The PR's commit list (short sha and message subject, oldest first) from the
GitHub pull commits endpoint goes into both prompts as a section. The diff is a
squash; the commits show how it was built and which commits came after the
previous review.

### 3. Architecture before the PR

The reviewer reads a repository overview from the base sha: `CLAUDE.md`,
`ARCHITECTURE.md`, `docs/ARCHITECTURE.md` and `README.md`, in that order, each
fetched with `getFileContent`, skipping files that do not exist and stopping
at a total budget of 12,000 characters. The result is a fixed section in the
file prompt. The search index has these documents, but per-file retrieval by
identifier rarely surfaces the overview.

All three pieces degrade to warnings: a failed GitHub call for commits, the
delta or the overview never fails a review.

## Components

- `src/review/github.ts`: `listPullCommits(owner, repo, number)` returning
  `{ sha, message }[]`, and `compareDiff(owner, repo, base, head)` returning
  the unified diff text or `null` when the compare cannot be produced (404 or
  422). Both added to the `Pick` in `ReviewDeps`.
- `src/db.ts`: `findLatestReview(repoId, prNumber)` returning the newest
  `done` row for the PR regardless of head sha, plus `countPrReviews`.
- `src/review/lineage.ts`: a pure `buildLineage` that assembles the pieces from
  injected fetchers and returns `{ commits, previous, overview, warnings }`,
  and `deltaForFile(previous, path)` which uses `parseUnifiedDiff` and
  `hunkText` from `diff.ts` to pick out one file's delta hunks.
- `src/review/prompts.ts`: new optional `lineage` inputs on
  `buildFileReviewMessage` and `buildSummaryMessage`, rendered as sections in
  a stable order: overview, commits, previous review, delta. New rules in
  `FILE_REVIEW_SYSTEM_PROMPT` and `SUMMARY_SYSTEM_PROMPT`.
- `src/review/reviewer.ts`: `runReview` calls `buildLineage` once after
  fetching the diff, passes the result into every file prompt and the summary
  prompt, and appends its warnings. The posted body gains a line
  "Review N of this PR; M commits since <sha>" when a previous review exists.
- `CLAUDE.md`: the review pipeline paragraph describes the lineage.

## Data flow

```
reviewPullRequest
  getPull, getPullDiff (unchanged)
  buildLineage
    db.findLatestReview(repo, pr)      -> previous findings, head sha
    github.compareDiff(prevHead, head) -> delta diff or null
    github.listPullCommits(pr)         -> commits
    github.getFileContent(doc, baseSha) x up to 4 -> overview
  per file: buildFileReviewMessage({ ..., lineage, delta: deltaForFile })
  summary:  buildSummaryMessage({ ..., lineage })
```

## Error handling

Each fetch inside `buildLineage` is wrapped; a failure adds a warning and
leaves that piece empty. A missing previous review is the normal first-run
case and adds nothing. `compareDiff` returning `null` produces the
"delta unavailable" note rather than a warning, since a force push is normal.

## Testing

- `tests/review/github.test.ts`: `listPullCommits` maps the payload;
  `compareDiff` requests the diff media type and returns `null` on 404/422.
- `tests/db.test.ts`: `findLatestReview` returns the newest done row across
  heads and ignores error rows; `countPrReviews`.
- `tests/review/lineage.test.ts`: `buildLineage` with fakes: no previous
  review; previous review with delta; delta unavailable; overview budget and
  missing docs; each failure becomes a warning. `deltaForFile` picks the right
  hunks and reports unchanged files.
- `tests/review/reviewer.test.ts`: with a stored earlier review and a fake
  compare diff, the file prompt contains the previous findings for that file
  and its delta hunks, the summary prompt contains the previous verdict, and
  the posted body carries the review count. A first review carries none of it.
