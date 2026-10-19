import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { Socket } from 'node:net';
import { loadConfig } from '../src/config.js';
import { createProvider } from '../src/llm/index.js';
import { buildDeps } from '../src/server.js';
import { reviewPullRequest, type ReviewDeps } from '../src/review/reviewer.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); vi.restoreAllMocks(); });
const base = { MODEL_BILLING_MODE: 'subscription_only', SUBSCRIPTION_SOCKET_PATH: '/run/private/complete.sock' };

describe('subscription-only configuration', () => {
  it('defaults every enabled role to explicit subscription models', () => {
    const config = loadConfig(base);
    expect(config.llm.provider).toBe('subscription');
    expect(config.llm.model).toBe('gpt-6.1-sol');
    expect(config.review.verifierModel).toBe('gpt-6.1-sol');
    expect(config.review.arbiterModel).toBe('gpt-6-astra');
    expect(config.embedding).toBeNull();
    expect(() => createProvider(config, { provider: 'openrouter', model: 'paid/model' })).toThrow();
  });

  it.each([
    ['LLM_PROVIDER', 'openrouter'], ['CHAT_PROVIDER', 'claude-cli'], ['OPENAI_API_KEY', 'synthetic'],
    ['OPENROUTER_API_KEY', 'synthetic'], ['EMBEDDING_API_KEY', 'synthetic'],
    ['EMBEDDING_MODEL', 'paid-embedding'], ['EMBEDDING_BASE_URL', 'https://example.invalid'],
    ['REVIEW_VERIFIER_MODEL', 'google/paid'], ['REVIEW_ARBITER_MODEL', 'openai/paid'],
    ['CHAT_MODEL', 'openai/paid'], ['REVIEW_ESCALATION_MODEL', 'openai/paid'],
    ['REVIEW_FALLBACK_MODELS', 'paid/model'], ['REVIEW_VERIFIER_MODEL', ''], ['REVIEW_ARBITER_MODEL', ''],
    ['REVIEW_DISCOVERY_MAX_OUTPUT', '16000'], ['LLM_TIMEOUT_MS', '300001'],
  ])('rejects %s overrides before inference', (key, value) => {
    expect(() => loadConfig({ ...base, [key]: value })).toThrow();
  });
});

const finding = { path: 'src/auth.ts', line: 1, severity: 'critical', title: 'Unchecked token',
  body: 'The request token is used without validation.', category: 'security', confidence: 'high',
  rootCause: 'missing token validation', evidence: { path: 'src/auth.ts', line: 1,
    trigger: 'an unauthenticated request', consequence: 'unauthorized access', rule: null } };
const diff = 'diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-const token = oldToken;\n+const token = request.token;\n';
const pr = { number: 1, title: 'Change authentication', body: '', headSha: 'head', baseSha: 'base',
  headRef: 'feature', baseRef: 'main', author: 'owner', htmlUrl: 'https://github.com/o/r/pull/1',
  draft: false, updatedAt: '2026-01-01T00:00:00Z' };

async function setup(failArbiter = false, dualDiscovery = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'subscription-wiring-'));
  const socketPath = path.join(directory, 'complete.sock');
  const calls: Array<{ model: string; stage: string; payload: Record<string, unknown> }> = [];
  let discoveryInFlight = 0;
  let maxDiscoveryInFlight = 0;
  const sockets = new Set<Socket>();
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const transcript = JSON.parse(body.input);
    const properties = body.output_schema?.properties;
    let stage = 'verification';
    let output: unknown;
    if (properties?.reviewedPaths && properties.decisions) {
      stage = 'escalation';
      const ids = properties.decisions.items.properties.id.enum as string[];
      output = { reviewedPaths: ['src/auth.ts'], decisions: ids.map((id) => ({ id, decision: 'retain' })), findings: [] };
    } else if (properties?.reviewedPaths) {
      stage = 'discovery';
      output = { reviewedPaths: ['src/auth.ts'], summary: 'Synthetic review.', verdict: 'request_changes', findings: [finding] };
    } else if (properties?.decisions) {
      stage = 'arbitration';
      output = { decisions: [{ id: 0, decision: 'supported', explanation: 'Confirmed.', evidence: { path: 'src/auth.ts', line: 1 } }] };
    } else {
      output = { decisions: [{ id: 0, decision: 'contradicted', explanation: 'Synthetic disagreement.',
        evidence: { path: 'src/auth.ts', line: 1 }, duplicateOf: null }], missingEvidence: [], summary: 'Verify.', verdict: 'approve' };
    }
    calls.push({ model: body.model, stage, payload: body });
    if (stage === 'discovery') {
      discoveryInFlight++;
      maxDiscoveryInFlight = Math.max(maxDiscoveryInFlight, discoveryInFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      discoveryInFlight--;
    }
    if (stage === 'arbitration' && failArbiter) {
      res.writeHead(503); res.end(JSON.stringify({ error: 'subscription_exhausted' })); return;
    }
    expect(transcript.system).toBeTypeOf('string');
    res.end(JSON.stringify({ text: JSON.stringify(output), thread_id: 'thread-' + calls.length,
      turn_id: 'turn-' + calls.length, input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 }));
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(socketPath); await once(server, 'listening'); await fs.chmod(socketPath, 0o660);
  const config = loadConfig({ ...base, REPOLENS_DATA_DIR: directory, SUBSCRIPTION_SOCKET_PATH: socketPath,
    REVIEW_ESCALATION_MODEL: dualDiscovery ? '' : 'gpt-6-astra', REVIEW_DUAL_DISCOVERY: String(dualDiscovery),
    REVIEW_MAX_RETRIES: '0' });
  const deps = buildDeps(config, () => {});
  cleanup.push(async () => {
    deps.db.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  deps.db.upsertRepo({ id: 'github:o/r', remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
  deps.db.setRepoStatus('github:o/r', 'ready', { last_commit: 'base' });
  const indexed = 'export function validateToken(token) { return token.signatureIsValid; }';
  const file = deps.db.upsertFile({ repo_id: 'github:o/r', path: 'src/token.ts', blob_hash: 'indexed', language: 'typescript', size: indexed.length });
  deps.db.insertChunks([{ fileId: file.id, repoId: 'github:o/r', path: 'src/token.ts', startLine: 1, endLine: 1, content: indexed }]);
  const statuses: string[] = [];
  const github: ReviewDeps['github'] = {
    async getPull() { return pr; }, async getPullDiff() { return diff; },
    async getFileContent(_owner, _repo, file) { return file === 'src/auth.ts' ? 'const token = request.token;\n' : null; },
    async listPullCommits() { return []; }, async listCommitPulls() { return []; },
    async listPathCommits() { return []; }, async compareDiff() { return null; },
    async listReviewComments() { return []; },
    async createReview() { return { id: 1, htmlUrl: 'https://github.com/o/r/pull/1#review' }; },
    async createCommitStatus(_owner, _repo, _sha, input) { statuses.push(input.state); },
  };
  return { deps, config, calls, github, statuses, discoveryConcurrency: () => maxDiscoveryInFlight };
}

describe('subscription review wiring', () => {
  it('runs discovery, escalation, verification and arbitration through the Unix broker', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('external inference forbidden'));
    const { deps, config, calls, github } = await setup();
    expect(deps.verifierLlm).not.toBe(deps.llm);
    expect(deps.embeddings).toBeNull();
    const result = await reviewPullRequest({ ...deps, github, maxRetries: 0 }, { repoId: 'github:o/r', prNumber: 1, post: false });
    expect(calls.map((call) => call.stage)).toEqual(['discovery', 'escalation', 'verification', 'arbitration']);
    expect(calls.map((call) => call.model)).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-astra']);
    expect(calls.every((call) => !('maxTokens' in call.payload) && !('reviewBudget' in call.payload))).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.trace?.stages.flatMap((stage) => stage.calls).every((call) => call.estimatedCostUsd === null && call.costUsd === null)).toBe(true);
    const usage = await deps.usage!.report(1);
    expect(usage.rows.every((row) => row.costUsd === null && row.billingSource === 'ChatGPT subscription')).toBe(true);
    for (let index = 0; index < 2; index++) {
      expect((await deps.retrieve({ repoIds: ['github:o/r'], query: 'validateToken', limit: 3 }))[0]?.path).toBe('src/token.ts');
    }
    const restarted = buildDeps(config, () => {});
    try {
      expect((await restarted.retrieve({ repoIds: ['github:o/r'], query: 'validateToken', limit: 3 }))[0]?.path).toBe('src/token.ts');
      expect((await restarted.usage!.report(1)).rows.every((row) => row.costUsd === null)).toBe(true);
    } finally { restarted.db.close(); }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the independent contract/concurrency pass enabled on subscription models', async () => {
    const { deps, calls, github, discoveryConcurrency } = await setup(false, true);
    await reviewPullRequest({ ...deps, github, maxRetries: 0 }, { repoId: 'github:o/r', prNumber: 1, post: false });
    expect(calls.filter((call) => call.stage === 'discovery')).toHaveLength(2);
    expect(discoveryConcurrency()).toBe(1);
  });

  it('blocks review if the arbiter cannot run rather than publishing a passing verdict', async () => {
    const { deps, calls, github, statuses } = await setup(true);
    await expect(reviewPullRequest({ ...deps, github, statusContext: 'repolens/review', maxRetries: 0 },
      { repoId: 'github:o/r', prNumber: 1 })).rejects.toThrow('subscription_exhausted');
    expect(calls.filter((call) => call.stage === 'arbitration')).toHaveLength(1);
    expect(statuses).not.toContain('success');
  });
});
