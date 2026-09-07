# Benchmark quality improvements

Goal: improve Martian benchmark precision and quiet behavior without changing review models or re-indexing repositories per PR.

## Task 1: Publish only accepted findings

- Add regression tests showing verifier-filtered findings cannot survive in the summary or body.
- Generate the final summary from the final accepted finding set.
- Use one root-cause-deduplicated set for the body and inline comments.
- Suppress `test_gap` findings from low-noise publication while preserving actual bugs in test files.
- Run focused review tests and typecheck.

## Task 2: Give verification better local evidence

- Add regression tests for large changed files where guards sit outside the diff.
- Replace all-or-nothing head-file inclusion with bounded numbered windows around changed hunks.
- Improve targeted retrieval using implicated finding symbols/callees, reusing existing repository search.
- Require verifier decisions to cite numbered evidence and consider counter-evidence.
- Run focused review/search tests and typecheck.

## Task 3: Make escalation decisions explicit and bounded

- Add regression tests for retain/reject/uncertain decisions per primary finding.
- Remove a primary finding only on explicit rejection; preserve uncertain findings for normal verifier handling.
- Trim optional verifier context before required evidence.
- Add at most one corrective retry for malformed citations within the existing spend cap.
- Persist a minimal stage trace using existing review artifacts; do not store secrets or raw reasoning.
- Run focused tests, full tests, typecheck, and diff check.

## Constraints

- Keep the current review and embedding models.
- Do not run paid benchmark inference until implementation and review are complete.
- Reuse existing helpers and artifact storage; add no dependencies or new platform services.
- Keep the existing dirty benchmark changes intact.
