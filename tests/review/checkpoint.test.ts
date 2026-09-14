import { describe, expect, it } from 'vitest';
import {
  ReviewCompatibilityV1,
  ReviewProgressV1,
  canonicalHash,
  canonicalJson,
  compatibilityKey,
  lastLedgerOf,
  resumeStageOf,
  validateCheckpointPayload,
} from '../../src/review/checkpoint.js';

const compatibility = {
  version: 1 as const,
  repoId: 'github:acme/widgets', prNumber: 4, headSha: 'head', baseSha: 'base',
  title: 'Title', body: 'Body', instructions: '', provider: 'openrouter', model: 'model',
  fallbackModels: ['openrouter/backup'], supportsBatchReview: true, maxFiles: 40, maxRetries: 3,
  discoveryMaxOutput: 8000, dualDiscovery: false, focusedVerification: false, arbiter: false,
  arbiterAllFindings: false, escalationModel: '', verifierModel: '', ignorePatterns: [], budgetUsd: 0.495, promptDigest: 'digest',
  algorithmDigest: 'algo', contextGeneration: 2, indexedCommit: 'indexed', fresh: false as const,
};

const ledger = { usedUsd: 0.01, reservedUsd: 0.02, costUsd: 0.01, retryAttemptsUsed: 0, followupRetryAttemptsUsed: 0, followupReserve: 0, activeProviderIndex: 0 };
const finding = {
  path: 'src/app.ts', line: 4, severity: 'critical' as const, title: 'Assignment in condition', body: 'Use ===.',
};

describe('review checkpoint DTOs', () => {
  it('reject unknown fields and preserve canonical object hashing', () => {
    expect(() => ReviewCompatibilityV1.parse({ ...compatibility, secret: 'must not persist' })).toThrow();
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
    expect(compatibilityKey(compatibility)).toHaveLength(64);
  });

  it('orders resume stages and exposes the latest ledger', () => {
    const discovery = { findings: [finding], primaryTrace: [finding], warnings: [], ledger, omittedContext: 0, calls: [] };
    const escalation = { findings: [finding], warnings: [], ledger, decisions: [], escalatedFindings: [], omittedContext: 0, calls: [] };
    const verification = { findings: [], warnings: [], ledger, executed: true, selectedPaths: [], omittedContext: 0, findingsTrace: [], calls: [] };
    const reconciliation = { findings: [], summary: 'Follow-up review 2.', warnings: [], ledger };

    expect(resumeStageOf(ReviewProgressV1.parse({ version: 1, discovery }))).toBe('discovery');
    expect(resumeStageOf(ReviewProgressV1.parse({ version: 1, discovery, escalation }))).toBe('escalation');
    expect(resumeStageOf(ReviewProgressV1.parse({ version: 1, discovery, escalation, verification }))).toBe('verification');
    expect(resumeStageOf(ReviewProgressV1.parse({ version: 1, discovery, escalation, verification, reconciliation }))).toBe('reconciliation');
    expect(resumeStageOf(ReviewProgressV1.parse({ version: 1 }))).toBeUndefined();
    expect(lastLedgerOf(ReviewProgressV1.parse({ version: 1, discovery }))).toEqual(ledger);
  });

  it('validates the payload hash and fails closed for corruption', () => {
    const progress = ReviewProgressV1.parse({ version: 1, discovery: { findings: [finding], primaryTrace: [], warnings: [], ledger, omittedContext: 0, calls: [] } });
    const hash = canonicalHash(progress);
    expect(validateCheckpointPayload(JSON.stringify(progress), hash).discovery?.findings).toHaveLength(1);
    // Tampered bytes and a wrong hash must both discard the payload.
    expect(() => validateCheckpointPayload('{"version":1}', hash)).toThrow();
    expect(() => validateCheckpointPayload(JSON.stringify(progress), 'bad')).toThrow();
    expect(() => validateCheckpointPayload(null, hash)).toThrow();
  });
});
