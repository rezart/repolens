# Precision/Recall 80 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reach a credible path to at least 80% strict precision while materially increasing strict recall, without exceeding $0.50 per review or gaming the metric through silence.

**Architecture:** Run two independent Qwen discovery views—local execution and contract/concurrency—then canonicalize candidates and use GPT-5 mini as the independent adjudicator. Establish fresh, dry-run benchmark semantics and citable head-revision evidence before comparing the corrected baseline, independent-verifier, and dual-discovery arms.

**Tech Stack:** TypeScript, Vitest, SQLite, OpenRouter, Python Martian offline benchmark.

**Spec:** `docs/superpowers/plans/2026-09-07-benchmark-quality-improvements.md` plus the judged artifacts in `/Users/rez/workspace/code-review-benchmark/offline/results/google_gemini-3.8-flash/`.

## Global Constraints

- Keep every review, including retries and all stages, below the existing `$0.50` reservation cap.
- Preserve full diff coverage, head-change checks, fail-closed validation, privacy-minimal production traces, and no automatic GitHub approval.
- Benchmark experiments must be dry-run fresh reviews and export full accepted findings; they must not depend on prior GitHub comments or lineage.
- Exact deduplication may merge only identical `(rootCauseMarker, path, evidence line)` candidates.
- Different causes at one line and one cause at distinct locations must remain distinct.
- Use test-first development and run focused tests, the full suite, typecheck, and `git diff --check` before any benchmark run.
- Do not run the full supported-48 benchmark until the 8- and 12-fixture gates pass.

---

### Task 1: Fresh-review benchmark mode and full-finding export

**Files:**
- Modify: `src/review/reviewer.ts`
- Modify: `src/cli.ts`
- Test: `tests/review/reviewer.test.ts`
- Test: the CLI test file that currently covers `review` option parsing
- Create or modify in benchmark repository: `/Users/rez/workspace/code-review-benchmark/offline/scripts/repolens_experiment.py`
- Test in benchmark repository: `/Users/rez/workspace/code-review-benchmark/offline/tests/test_repolens_experiment.py`

**Interfaces:**
- Add `ReviewOptions.fresh?: boolean`; when true, skip `buildLineage` and existing-comment suppression but retain PR-head and historical-repository context.
- Add CLI flag `--fresh`; it implies dry-run unless `--post` is explicitly present.
- Export one JSON record per review containing fixture, arm, head SHA, stage models, accepted full `Finding[]`, cost, latency, warnings, and trace.

- [ ] Write tests proving `fresh:true` does not read prior reviews/comments and still returns full accepted findings.
- [ ] Run those tests and observe failure for the missing option.
- [ ] Implement the smallest branch around lineage/comment suppression and CLI parsing.
- [ ] Add a benchmark script that reads fixture allowlists, invokes RepoLens with `--fresh`, and writes a new arm-specific file without mutating shared benchmark result files.
- [ ] Test the script with a fake CLI subprocess and two fixtures; prove resumption uses only the arm output file.
- [ ] Run focused tests and commit `feat(benchmark): isolate fresh review experiments`.

### Task 2: Exact provisional candidate deduplication

**Files:**
- Modify: `src/review/reviewer.ts:1753-1767`
- Test: `tests/review/reviewer.test.ts`

**Interfaces:**
- Add a small internal candidate identity based on existing `rootCauseMarker(finding)`, `finding.path`, and `findingLine(finding)`.
- Deduplicate after rejected-primary removal and before refreshed retrieval/verifier request construction.

- [ ] Add tests for identical primary/escalation candidates, different causes at one line, one cause in different files, eleven Discourse-style duplicate pairs, two Keycloak-style distinct findings, and rejected-primary reintroduction.
- [ ] Run focused tests and observe duplicate-count failures.
- [ ] Implement stable first-wins exact deduplication without changing publication root grouping.
- [ ] Run focused tests and commit `fix(review): deduplicate provisional findings`.

### Task 3: Independent verifier configuration and routine-escalation ablation

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example`
- Modify: `src/server.ts`
- Modify: `src/app.ts`
- Test: `tests/config.test.ts`
- Test: `tests/server.test.ts`

**Interfaces:**
- Add optional `REVIEW_VERIFIER_MODEL`; for OpenRouter, create a provider using the existing factory and review usage sink.
- Pass `deps.verifierLlm` through the server/app instead of unconditionally reusing the primary.
- Permit experiment arm B to omit `escalationLlm` while retaining verifier execution.

- [ ] Write config/wiring tests showing GPT-5 mini can be verifier while Qwen remains primary, and blank escalation disables routine escalation.
- [ ] Run tests and observe current same-model wiring failure.
- [ ] Implement minimal provider wiring with no new abstraction.
- [ ] Run focused tests and commit `feat(review): configure an independent verifier`.

### Task 4: Citable cross-file head evidence

**Files:**
- Modify: `src/review/reviewer.ts` (`buildHeadContext`, `buildVerifierFiles`, `hasValidVerifierCitation`, targeted retrieval path)
- Test: `tests/review/reviewer.test.ts`

**Interfaces:**
- Represent every authoritative verifier snippet as `{path, revision:'head', lines:[{line,text}]}` or its existing equivalent.
- Build one allowed `(path,line)` citation set from current diff evidence, numbered own-head windows, and bounded referenced-head snippets.
- Never treat base-index text or an unversioned retrieved chunk as authoritative head evidence.

- [ ] Add tests where an unchanged callee guard supports or contradicts a candidate and its exact line is accepted.
- [ ] Add a test proving a base-only retrieved line remains invalid.
- [ ] Run tests and observe the unavailable-citation failure.
- [ ] Fetch/render only the implicated bounded head snippet and extend citation validation to that explicit set.
- [ ] Run focused tests and commit `feat(review): cite bounded cross-file head evidence`.

### Task 5: Complementary independent discovery pass

**Files:**
- Modify: `src/review/prompts.ts`
- Modify: `src/review/reviewer.ts`
- Modify: `src/review/budget.ts` only if the existing reservation function cannot express the second call
- Test: `tests/review/prompts.test.ts`
- Test: `tests/review/reviewer.test.ts`

**Interfaces:**
- Add a contract/concurrency discovery prompt that does not receive primary finding prose.
- Run local and contract/concurrency discovery concurrently only after reserving the sum of both worst-case requests.
- Union their validated findings through Task 2 identity, then pass them once to the independent verifier.
- The complementary pass focuses on changed API/callers, response shapes, normalization, data writes, lifecycle, awaits, locks, and state transitions.

- [ ] Write prompt tests proving the second pass receives code/evidence but not primary allegations.
- [ ] Write reviewer tests proving concurrent independent requests, atomic combined reservation, validated union, and one verifier pass.
- [ ] Run tests and observe missing second-pass behavior.
- [ ] Implement the second request using existing provider and validation helpers; do not introduce an agent framework.
- [ ] Run focused tests and commit `feat(review): add complementary discovery pass`.

### Task 6: Targeted evidence queries and budget packing

**Files:**
- Modify: `src/review/reviewer.ts` (`contextQuery`, `retrieveTargetedChunks`, verifier/escalation request packing)
- Test: `tests/review/reviewer.test.ts`

**Interfaces:**
- Prefer exact path/symbol/callee terms over prose-frequency tokens.
- Exclude changed paths before retrieval top-k and keep definition/caller results.
- Remove duplicate context and ignored summary/verdict payloads before estimating/reserving.
- Preserve full hard-cap reservation for unknown-cost failures.

- [ ] Add query-selection tests using the Cal.com response-shape and Keycloak caller-contract patterns.
- [ ] Add a packing test proving duplicate evidence is sent once and retry reservation remains under the same hard cap.
- [ ] Run tests and observe current query/duplication failures.
- [ ] Implement only the measured query and packing changes.
- [ ] Run focused tests and commit `perf(review): target evidence within the review budget`.

### Task 7: Narrow runtime/contract evidence checks

**Files:**
- Create: `src/review/static-evidence.ts`
- Modify: `src/review/reviewer.ts`
- Test: `tests/review/static-evidence.test.ts`
- Test: `tests/review/reviewer.test.ts`

**Interfaces:**
- Produce bounded, non-executing evidence for directly inspectable facts: declared parameters, literal response-property access, awaited/unawaited calls, obvious local API arity, and configured runtime/version files.
- Supply facts to discovery/verifier prompts as evidence; never auto-publish a finding from a heuristic.

- [ ] Write tests for one TypeScript response-shape case, one unawaited call, and one runtime-version fact; include negative cases.
- [ ] Run tests and observe missing evidence.
- [ ] Implement minimal parsing with existing token/text utilities and no new dependency.
- [ ] Thread the facts into the verifier evidence payload.
- [ ] Run focused tests and commit `feat(review): add bounded static evidence`.

### Task 8: Replay and gated model-architecture experiments

**Files:**
- Modify: `/Users/rez/workspace/code-review-benchmark/offline/scripts/repolens_experiment.py`
- Create: `/Users/rez/workspace/code-review-benchmark/offline/results/repolens-precision-recall/README.md`
- Create generated arm result JSON/Markdown under that results directory.

**Interfaces:**
- Arm A0: current stages with fresh mode and exact deduplication.
- Arm B0: Qwen primary, no routine escalation, GPT-5 mini verifier.
- Arm C0: independent Qwen local and contract/concurrency generators, GPT-5 mini verifier.

- [ ] Replay stored traces and verify 162 verifier entries collapse to 100 exact candidates without losing distinct locations.
- [ ] Run the eight-fixture diagnostic cohort: Discourse 4/6/2/10, Cal.com 22532/11059, Keycloak 37634, Sentry Greptile 2.
- [ ] Continue only if Keycloak’s two critical findings survive, operational failures are zero, FP decreases, and at least two previously missed goldens are recovered.
- [ ] Run A0/B0/C0 on the twelve-fixture cohort from the Astra report, three repetitions for promising arms.
- [ ] Select C only if it adds at least four TP versus B, precision is at least 80%, no Critical TP is lost, pure-noise PRs do not increase, and every attempt stays below $0.50.
- [ ] Run the full supported 48 only after the twelve-fixture gate; first full gate is TP≥53, FP≤13, FN≤79, pure-noise≤5, FP/PR≤0.20, and no operational failures.
- [ ] Record official strict and separately adjudicated metrics, all-call cost, latency, failure rate, and quiet/useful-only/mixed/pure-noise counts.

### Task 9: Final review and integration decision

**Files:**
- Review all changed files and experiment artifacts.

- [ ] Run `npm test`, `npm run typecheck`, and `git diff --check` in RepoLens.
- [ ] Run the benchmark repository test suite.
- [ ] Dispatch a final Astra review of code, traces, and scored results.
- [ ] Do not merge unless the twelve-fixture gate passes and the user approves the resulting branch/PR.
