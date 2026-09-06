import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '../../src/review/diff.js';
import { assessChange, selectReviewCandidates } from '../../src/review/selection.js';

function one(diff: string) {
  return parseUnifiedDiff(diff)[0]!;
}

describe('review candidate selection', () => {
  it('keeps blank and comment additions conservatively', () => {
    const file = one(`diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,4 @@
 const x = 1;
+// explanatory comment
+
 const y = 2;
`);
    const result = selectReviewCandidates(file);
    expect(result.file.hunks).toHaveLength(1);
    expect(result.risk.score).toBe(1);
  });

  it('keeps deletions and mixed executable changes', () => {
    const file = one(`diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,3 @@
-const secret = oldSecret;
+const secret = newSecret;
+// keep this context
`);
    const result = selectReviewCandidates(file);
    expect(result.file.hunks).toHaveLength(1);
    expect(result.risk.signals).toContain('security');
  });

  it('drops a malformed context-only hunk as a no-op', () => {
    const file = one(`diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
 const x = 1;
`);
    expect(selectReviewCandidates(file).file.hunks).toHaveLength(0);
  });

  it('scores control flow and preserves unknown executable syntax', () => {
    const file = one(`diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1,2 @@
 export function run() {}
+mysteriousRuntimeCall();
`);
    const result = assessChange(file);
    expect(result.score).toBeGreaterThan(0);
    expect(result.signals).toContain('execution');
    expect(selectReviewCandidates(file).file.hunks).toHaveLength(1);
  });
});
