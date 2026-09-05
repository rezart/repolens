import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { OpenRouterProvider } from '../src/llm/openrouter.js';
import { reviewPullRequest, type ReviewDeps } from '../src/review/reviewer.js';
import { reviewCostUpperBound } from '../src/review/budget.js';
import type { UsageRecord } from '../src/usage/types.js';

// Only generated synthetic code is sent. No repository files, database, or
// GitHub data are read. The environment supplies authentication only.
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error('Set OPENROUTER_API_KEY to run the paid synthetic benchmark (at most $0.25).');
const db = openDb(':memory:');
const repoId = 'github:synthetic/example';
db.upsertRepo({ id: repoId, remote: 'https://example.invalid/synthetic.git', owner: 'synthetic', name: 'example', branch: 'main' });
db.setRepoStatus(repoId, 'ready', { last_commit: 'base' });
const paths = Array.from({ length: 40 }, (_, i) => `src/file${i}.ts`);
const contents = paths.map((_, i) => Array.from({ length: 12 }, (_, j) => `export function add${i}_${j}(n: number) { return n + ${j}; }`).join('\n'));
contents[39] = 'export function canDelete(user: { role: string }) {\n  if (user.role = "admin") return true;\n  return false;\n}';
const diff = paths.map((p, i) => `diff --git a/${p} b/${p}\n--- /dev/null\n+++ b/${p}\n@@ -0,0 +1,${contents[i]!.split('\n').length} @@\n${contents[i]!.split('\n').map((l) => '+' + l).join('\n')}\n`).join('');
const pr = { number: 1, title: 'Synthetic cost benchmark: arithmetic helpers and role authorization', body: 'Only administrators should be able to delete resources.', headSha: 'head', baseSha: 'base', headRef: 'benchmark', baseRef: 'main', author: 'synthetic', htmlUrl: '', draft: false, updatedAt: null };
const noPost = async (): Promise<never> => { throw new Error('Benchmark must not publish'); };
const github: ReviewDeps['github'] = {
  getPull: async () => pr, getPullDiff: async () => diff,
  getFileContent: async (_owner, _repo, path) => contents[paths.indexOf(path)] ?? null,
  listPullCommits: async () => [], compareDiff: async () => null,
  listPathCommits: async () => [], listCommitPulls: async () => [],
  createReview: noPost, listReviewComments: noPost, createCommitStatus: noPost,
};
const usage: UsageRecord[] = [];
const provider = new OpenRouterProvider({ apiKey, model: 'qwen/qwen3-coder', onUsage: (r) => { usage.push(r); console.log('usage', JSON.stringify(r)); } });
let upperBound = 0;
const result = await reviewPullRequest({ db, github, retrieve: async () => [], llm: {
  name: provider.name, model: provider.model, concurrency: provider.concurrency,
  complete: async (req) => { upperBound = reviewCostUpperBound(req); console.log('reservedUsd', upperBound); return provider.complete(req); },
} }, { repoId, prNumber: 1, post: false });
assert.equal(usage.length, 1);
assert(usage.every((r) => r.costUsd !== null));
const cost = usage.reduce((sum, r) => sum + r.costUsd!, 0);
assert(cost <= 0.25);
assert(result.findings.some((f) => f.path === paths[39] && f.line === 2 && f.severity === 'critical'));
console.log(JSON.stringify({ costUsd: cost, upperBound, findings: result.findings, summary: result.summary, warnings: result.warnings, posted: result.posted }, null, 2));
db.close();
