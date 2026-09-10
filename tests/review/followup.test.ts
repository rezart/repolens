import { describe, it, expect } from 'vitest';
import { reconcileFollowup } from '../../src/review/followup.js';
import { parseUnifiedDiff } from '../../src/review/diff.js';
import type { Lineage } from '../../src/review/lineage.js';
import type { Finding } from '../../src/review/reviewer.js';

const old: Finding = { path: 'app.ts', line: 2, severity: 'critical', title: 'Public config', body: 'Requires auth.' };
const warning: Finding = { path: 'telemetry.ts', line: 1, severity: 'warning', title: 'Invalid SDK option', body: 'Allegation.' };
const delta = parseUnifiedDiff('diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1,2 +1,2 @@\n route();\n-publicConfig();\n+authenticatedConfig();\n');
const lineage: Lineage = { reviewNumber: 2, commits: [], overview: '', warnings: [], previous: {
  headSha: 'abcdef123', verdict: 'request_changes', summary: '', findings: [old], commitsSince: 1, delta,
} };
const evidence = { path: 'app.ts', line: 2, side: 'new' };
const resolved = { id: 0, status: 'resolved', findingIndex: null, reason: 'The route now requires authentication.', evidence };
const decision = { id: 0, introduced: false, reason: 'Unchanged SDK setup; unrelated to authentication.', evidence: null };
const input = (previous = [resolved], candidates = [decision]) => JSON.stringify({ previous, candidates });
const head = [{ path: 'app.ts', lines: [{ line: 1, text: 'route();' }, { line: 2, text: 'authenticatedConfig();' }] }, { path: 'telemetry.ts', lines: [{ line: 1, text: 'startSdk();' }] }];

describe('follow-up reconciliation', () => {
  it('reports the endpoint fix and suppresses an unrelated new warning on unchanged code', () => {
    const result = reconcileFollowup(input(), lineage, [warning], head);
    expect(result.findings).toEqual([]);
    expect(result.summary).toContain('Follow-up review 2');
    expect(result.summary).toContain('Resolved: Public config');
    expect(result.summary).not.toContain('Invalid SDK option');
  });

  it('allows an unchanged caller finding only with cited evidence from the latest delta', () => {
    const candidate = { ...decision, introduced: true, evidence, reason: 'The new auth requirement breaks this caller.' };
    const raw = JSON.stringify({ previous: [resolved], candidates: [candidate] });
    expect(reconcileFollowup(raw, lineage, [warning], head).findings).toEqual([warning]);
    const unrelated = { ...evidence, path: 'telemetry.ts', line: 1 };
    const invalid = JSON.stringify({ previous: [resolved], candidates: [{ ...candidate, evidence: unrelated }] });
    expect(() => reconcileFollowup(invalid, lineage, [warning], head)).toThrow();
  });

  it('does not infer resolution from a missing previous finding', () => {
    expect(() => reconcileFollowup(JSON.stringify({ previous: [], candidates: [decision] }), lineage, [warning], head)).toThrow();
    expect(() => reconcileFollowup(input([{ ...resolved, status: 'unconfirmed' }]), lineage, [warning], head)).toThrow();
  });

  it('separates retractions from delta-proven fixes', () => {
    const raw = input([{ ...resolved, status: 'retracted', reason: 'The browser token is intentionally public.' }]);
    expect(reconcileFollowup(raw, lineage, [warning], head).summary).toContain('Retracted: Public config');
    const noDelta = { ...lineage, previous: { ...lineage.previous!, delta: null } };
    expect(() => reconcileFollowup(input(), noDelta, [warning], head)).toThrow();
  });

  it('keeps remaining findings linked to their earlier identity despite a moved line', () => {
    const moved = { ...old, line: 1 };
    const raw = JSON.stringify({ previous: [{ ...resolved, status: 'remaining', findingIndex: 0, evidence: { ...evidence, line: 1 } }], candidates: [decision] });
    const result = reconcileFollowup(raw, lineage, [moved], head);
    expect(result.findings).toEqual([moved]);
    expect(result.summary).toContain('Remaining: Public config');
    expect(result.summary).not.toContain('New:');
  });

  it('accepts an explicit remaining mapping when multiple candidates share the old title', () => {
    const candidates = [{ ...old, rootCause: 'original' }, { ...old, rootCause: 'new regression' }];
    const raw = JSON.stringify({ previous: [{ ...resolved, status: 'remaining', findingIndex: 0 }], candidates: [
      decision, { id: 1, introduced: true, reason: 'The new delta introduces another failure.', evidence },
    ] });
    expect(reconcileFollowup(raw, lineage, candidates, head).findings).toEqual(candidates);
  });

  it('rejects a remaining mapping to an unrelated candidate', () => {
    const raw = JSON.stringify({ previous: [{ ...resolved, status: 'remaining', findingIndex: 0 }], candidates: [decision] });
    expect(() => reconcileFollowup(raw, lineage, [warning], head)).toThrow();
  });

  it('cannot retract or resolve an issue that still has a matching current candidate', () => {
    for (const status of ['resolved', 'retracted']) {
      expect(() => reconcileFollowup(input([{ ...resolved, status }]), lineage, [old], head)).toThrow();
    }
  });

  it('rejects duplicate IDs and invented current citations', () => {
    expect(() => reconcileFollowup(JSON.stringify({ previous: [resolved, resolved], candidates: [decision] }), lineage, [warning], head)).toThrow();
    expect(() => reconcileFollowup(input([{ ...resolved, status: 'retracted', evidence: { ...evidence, line: 99 } }]), lineage, [warning], head)).toThrow();
  });
});
