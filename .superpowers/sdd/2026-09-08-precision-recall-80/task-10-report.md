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

## Round 1 fixes

### RED

Added regression coverage for the standalone focused contract, original candidate IDs, and budget-skip trace semantics before production edits. The focused reviewer run produced the expected three failures:

- The focused system prompt inherited the normal contract and advertised `uncertain`.
- Focused findings were renumbered locally instead of retaining the normal verifier's uncertain IDs.
- Budget suppression emitted a warning instead of preserving a zero-warning result.

### GREEN

- Focused verification now uses a standalone binary `supported|contradicted` contract, treats insufficient evidence as contradicted, and has no uncertain schema/token.
- Focused requests preserve original normal-verifier candidate IDs, require exactly that uncertain-ID set (in any order), and trace those IDs.
- Budget-skipped focused verification records `focusedSkipped: 'budget'`, suppresses uncertain findings, and emits no warning.

Round 1 focused verification:

```text
npx vitest run tests/review/reviewer.test.ts -t 'focused|uncertain findings' --reporter=verbose
npx vitest run tests/review/prompts.test.ts -t 'system prompts' --reporter=verbose
```

Result: 4 reviewer tests and 6 prompt tests passed.

Round 1 full verification:

```text
npm test
npm run typecheck
git diff --check
```

Results: 32 test files / 692 tests passed; typecheck exited 0; diff check clean.

## Round 2 fixes

### RED

Added a focused prompt safeguard test before editing production code. The targeted run failed as expected because the standalone focused prompt did not retain the allegation, authoritative head-evidence, historical removed-evidence, reachability/callee, or counterevidence guidance.

### GREEN

Retained those non-conflicting normal-verifier safety rules in the standalone focused contract:

- finding prose is an allegation, not evidence;
- currentEvidence and structured `revision:"head"` headEvidence are authoritative;
- removedEvidence is historical and cannot prove current code;
- declared parameters, guards/early exits, caller constraints, callee behavior, and counterevidence must be checked;
- citations must support the claim, not merely cite an allowed line.

The focused contract remains binary (`supported|contradicted`) and treats insufficient evidence as contradicted. Assertions use semantic patterns rather than full-string coupling.

Round 2 focused verification:

```text
npx vitest run tests/review/prompts.test.ts -t 'focused verification evidence safeguards' --reporter=verbose
npx vitest run tests/review/reviewer.test.ts -t 'focused|uncertain findings' --reporter=dot
```

Result: 1 prompt test and 4 reviewer tests passed.

Round 2 full verification:

```text
npm test
npm run typecheck
git diff --check
```

Results: 32 test files / 693 tests passed; typecheck exited 0; diff check clean.
