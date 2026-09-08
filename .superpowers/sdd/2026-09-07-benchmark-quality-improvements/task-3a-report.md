# Task 3a report

## RED

- Added escalation regression coverage for explicit retain/reject/uncertain decisions and incomplete decision sets.
- Before the implementation, the new tests failed because escalation did not send primary IDs/decisions and replaced risky findings unconditionally.

## GREEN

- `npx vitest run tests/review/reviewer.test.ts tests/review/prompts.test.ts --reporter=dot` — 2 files, 175 tests passed.
- `npx vitest run tests/review --reporter=dot` — 9 files, 261 tests passed.
- `npx vitest run tests/review/reviewer.test.ts -t 'trims optional verifier' --reporter=verbose` — passed.
- `npm run typecheck` — passed.
- `git diff --check` — passed.

## Files

- `src/review/reviewer.ts`: stable primary IDs, strict escalation decision validation, reject-only removal, bounded verifier context and actual request cost estimation.
- `src/review/prompts.ts`: escalation response contract for decisions and newly supported findings.
- `tests/review/reviewer.test.ts`: explicit decision, malformed response, and verifier budget/context regressions.

## Concerns

- Stable IDs are deterministic hashes of root cause/path/line, with an occurrence suffix for duplicate primary findings; they are scoped to a review response.
- Optional verifier context is retained when it fits the remaining cap; under pressure, relevant retrieval context is dropped and the first head-context block (candidate windows) is preserved.

## Follow-up review fixes

- Verifier reservation now starts from all current findings, not only risky primary findings, and reserves a bounded allowance for the escalation response's possible added findings before permitting escalation.
- Added explicit duplicate-ID and unknown-ID regression cases alongside the missing-ID case.
- `npx vitest run tests/review/reviewer.test.ts -t 'primary decision ID' --reporter=verbose` — 3 tests passed.
- `npx vitest run tests/review/reviewer.test.ts -t 'staged review' --reporter=dot` — 19 tests passed.
- `npm run typecheck` and `git diff --check` — passed.

## Follow-up review fix 2

- The possible escalation-output allowance is now included in both full and trimmed verifier reserve candidates before choosing which context variant fits.
- Added a near-cap regression where only the trimmed candidate leaves room for escalation and verifier work. The pre-fix test failed with the escalation budget guard; it now passes.
- `npx vitest run tests/review/reviewer.test.ts -t 'chooses trimmed verifier' --reporter=dot` — passed.
