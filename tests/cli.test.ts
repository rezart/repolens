import { describe, expect, it } from 'vitest';
import { freshReviewDeps, freshReviewFailureRecord, parseReviewArgs } from '../src/cli.js';
import { ReviewExecutionError } from '../src/review/reviewer.js';

describe('review CLI options', () => {
  it('keeps fresh reviews dry-run unless --post is explicit', () => {
    expect(parseReviewArgs(['github:o/r', '42', '--fresh'])).toMatchObject({
      repoId: 'github:o/r', prNumber: 42, fresh: true, post: false, force: false,
    });
    expect(parseReviewArgs(['github:o/r', '42', '--fresh', '--post']).post).toBe(true);
  });

  it('passes the configured verifier backend through fresh review wiring', () => {
    const primary = { name: 'qwen' };
    const verifier = { name: 'gpt-5-mini' };
    const wired = freshReviewDeps({
      llm: primary, verifierLlm: verifier,
      config: { review: { statusContext: '', failOn: 'critical', maxRetries: 3, ignorePatterns: [] } },
    } as never);
    expect(wired.verifierLlm).toBe(verifier);
  });

  it('passes dual discovery through fresh review wiring', () => {
    const wired = freshReviewDeps({
      llm: { name: 'qwen' }, config: { review: { statusContext: '', failOn: 'critical', maxRetries: 3, dualDiscovery: true, ignorePatterns: [] } },
    } as never);
    expect(wired.dualDiscovery).toBe(true);
  });

  it('passes focused verification through fresh review wiring', () => {
    const wired = freshReviewDeps({
      llm: { name: 'qwen' }, config: { review: { statusContext: '', failOn: 'critical', maxRetries: 3, focusedVerification: true, ignorePatterns: [] } },
    } as never);
    expect(wired.focusedVerification).toBe(true);
  });

  it('renders terminal fresh-review failures as structured telemetry', () => {
    const trace = {
      version: 1 as const,
      identity: { repoId: 'github:o/r', prNumber: 42, headSha: 'head', baseSha: 'base', provider: 'openrouter', model: 'qwen', config: { maxRetries: 3, maxFiles: 40 } },
      stages: [{ stage: 'initial' as const, selectedPaths: [], hunks: [], omittedContext: 0, calls: [{ provider: 'openrouter', model: 'qwen', estimatedCostUsd: 0.1, costUsd: null, outcome: 'error' as const, failure: 'fatal' }], findingCount: 0 }],
      finalFindings: [],
    };
    const record = freshReviewFailureRecord('github:o/r', new ReviewExecutionError('fatal', { headSha: 'head', costUsd: null, trace }), 17);
    expect(record).toMatchObject({ fixture: 'github:o/r', arm: 'fresh', headSha: 'head', cost: null, latencyMs: 17, findings: [], trace, error: 'fatal', posted: false });
    expect(record.stageModels).toEqual({ initial: ['qwen'] });
  });
});
