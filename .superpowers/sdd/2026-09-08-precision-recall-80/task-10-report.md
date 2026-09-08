# Task 10 — Calibrate independent verification

## RED

Added the required reviewer and prompt tests first, then ran:

```text
npx vitest run tests/review/reviewer.test.ts tests/review/prompts.test.ts --reporter=verbose
```

Expected RED observed: 4 failures (focused pass absent, malformed focused support did not fail closed, budget suppression had no warning, and the concrete-versus-speculative prompt boundary was missing). The remaining 219 tests passed.

## GREEN

Implemented the minimum behavior:

- Normal verification keeps only supported high-confidence non-nit findings, removes contradicted findings, and collects uncertain findings.
- At most one focused request goes to the same verifier, with uncertain findings only and a supported/contradicted-only contract.
- Focused support requires an allowed current-head citation; malformed output fails closed. If the request cannot fit under the existing `$0.50` cap, the focused call is skipped and uncertain findings are suppressed with a warning.
- Existing verification trace records normal/focused call labels and focused decisions.
- Verifier guidance now requires a concrete reachable failure and rejects generic security/performance/limit speculation while allowing direct authoritative evidence without exhaustive whole-program proof.

Focused verification:

```text
npx vitest run tests/review/reviewer.test.ts tests/review/prompts.test.ts --reporter=dot
```

Result: 223 passed.

Full verification:

```text
npm test
npm run typecheck
git diff --check
```

Results: 32 test files / 691 tests passed; typecheck exited 0; diff check clean.

## Files changed

- `src/review/reviewer.ts`
- `src/review/prompts.ts`
- `tests/review/reviewer.test.ts`
- `tests/review/prompts.test.ts`

## Self-review

- No paid or model calls were made.
- The existing verifier provider and review budget remain unchanged.
- The focused pass intentionally has no corrective retry so the uncertain recheck remains exactly one request; malformed output fails closed under existing review execution error handling.
- Public trace call labels are optional for compatibility with older stored/test trace objects, while newly emitted calls always carry `normal` or `focused`.

## Commit

`feat(review): calibrate uncertain verification` (final commit hash is reported with the handoff).

## Concerns

None beyond the intentional suppression of uncertain findings when the focused request cannot fit the cap.
