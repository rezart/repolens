import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Durable payload format. Bump when persisted shapes change incompatibly. */
export const CHECKPOINT_PAYLOAD_VERSION = 1 as const;

const Sha = z.string().min(1);
const NonNegative = z.number().finite().nonnegative();
const NonNegativeInt = z.number().int().nonnegative();
const PositiveInt = z.number().int().positive();

const FindingV1 = z.strictObject({
  path: z.string().min(1),
  line: NonNegativeInt,
  severity: z.enum(['critical', 'warning', 'nit']),
  title: z.string(),
  body: z.string(),
  category: z.enum(['correctness', 'edge_case', 'security', 'test_gap', 'repository_rule']).optional(),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  rootCause: z.string().optional(),
  evidence: z.strictObject({
    path: z.string().min(1),
    line: NonNegativeInt,
    trigger: z.string(),
    consequence: z.string(),
    rule: z.strictObject({ path: z.string().min(1), line: PositiveInt, quote: z.string() }).optional(),
  }).optional(),
});

/** Money and retry state that must survive a resume unchanged. */
const LedgerV1 = z.strictObject({
  usedUsd: NonNegative,
  reservedUsd: NonNegative,
  /** Null until a completed call reported a trustworthy cost. */
  costUsd: NonNegative.nullable(),
  retryAttemptsUsed: NonNegativeInt,
  followupRetryAttemptsUsed: NonNegativeInt,
  followupReserve: NonNegative,
  activeProviderIndex: NonNegativeInt,
});
export type ReviewLedger = z.infer<typeof LedgerV1>;

const TraceCallV1 = z.strictObject({
  stage: z.enum(['initial', 'escalation', 'verification', 'arbitration']),
  provider: z.string(),
  model: z.string(),
  estimatedCostUsd: z.number().finite(),
  costUsd: z.number().finite().nullable(),
  outcome: z.enum(['success', 'error', 'validation_error']),
  failure: z.string().optional(),
  pass: z.enum(['normal', 'focused', 'evidence']).optional(),
  elapsedMs: NonNegativeInt.optional(),
});
export type ReviewTraceCall = z.infer<typeof TraceCallV1>;

const DecisionV1 = z.strictObject({
  id: z.union([z.string(), z.number()]),
  decision: z.string(),
  duplicateOf: z.number().int().nullable().optional(),
});
export type ReviewDecision = z.infer<typeof DecisionV1>;

const MissingEvidenceV1 = z.strictObject({
  requested: z.array(z.strictObject({ path: z.string().optional(), symbol: z.string(), question: z.string() })),
  acquired: z.array(z.strictObject({ path: z.string(), lines: z.array(NonNegativeInt) })),
  authoritativeEvidenceAdded: z.boolean(),
  unresolved: z.array(z.strictObject({ id: NonNegativeInt, reason: z.string() })),
});

/**
 * Every live input that must match before a checkpoint may be resumed: PR
 * identity and text, repository instructions, model routing, review config,
 * prompts, and the indexed context generation. Digest into one key.
 */
export const ReviewCompatibilityV1 = z.strictObject({
  version: z.literal(1),
  repoId: z.string().min(1),
  prNumber: PositiveInt,
  headSha: Sha,
  baseSha: Sha,
  title: z.string(),
  body: z.string(),
  instructions: z.string(),
  provider: z.string().min(1),
  model: z.string().min(1),
  fallbackModels: z.array(z.string().min(1)),
  supportsBatchReview: z.boolean(),
  maxFiles: PositiveInt,
  maxRetries: NonNegativeInt,
  discoveryMaxOutput: PositiveInt,
  dualDiscovery: z.boolean(),
  focusedVerification: z.boolean(),
  arbiter: z.boolean(),
  arbiterAllFindings: z.boolean(),
  escalationModel: z.string(),
  verifierModel: z.string(),
  ignorePatterns: z.array(z.string()),
  budgetUsd: NonNegative,
  promptDigest: z.string().min(1),
  algorithmDigest: z.string().min(1),
  contextGeneration: NonNegativeInt,
  indexedCommit: z.string().nullable(),
  /** Fresh benchmark runs never create or resume checkpoints. */
  fresh: z.literal(false),
});
export type ReviewCompatibility = z.infer<typeof ReviewCompatibilityV1>;

/** Discovery output: validated findings plus everything later stages re-derive from. */
const DiscoverySnapshotV1 = z.strictObject({
  findings: z.array(FindingV1),
  primaryTrace: z.array(FindingV1),
  warnings: z.array(z.string()),
  ledger: LedgerV1,
  omittedContext: NonNegativeInt,
  calls: z.array(TraceCallV1),
});

/** Findings after escalation and repository-rule validation. */
const EscalationSnapshotV1 = z.strictObject({
  findings: z.array(FindingV1),
  warnings: z.array(z.string()),
  ledger: LedgerV1,
  decisions: z.array(DecisionV1),
  escalatedFindings: z.array(FindingV1),
  omittedContext: NonNegativeInt,
  calls: z.array(TraceCallV1),
});

/** Findings after verification, arbitration, evidence and focused passes — the reconciliation candidates. */
const VerificationSnapshotV1 = z.strictObject({
  findings: z.array(FindingV1),
  warnings: z.array(z.string()),
  ledger: LedgerV1,
  executed: z.boolean(),
  selectedPaths: z.array(z.string()),
  omittedContext: NonNegativeInt,
  decisions: z.array(DecisionV1).optional(),
  focusedDecisions: z.array(DecisionV1).optional(),
  evidenceDecisions: z.array(DecisionV1).optional(),
  focusedSkipped: z.enum(['budget', 'disabled']).optional(),
  missingEvidence: MissingEvidenceV1.optional(),
  findingsTrace: z.array(FindingV1),
  arbitration: z.strictObject({
    executed: z.boolean(),
    selectedPaths: z.array(z.string()),
    decisions: z.array(DecisionV1),
    calls: z.array(TraceCallV1),
  }).optional(),
  calls: z.array(TraceCallV1),
});

/** Final findings and summary after follow-up reconciliation. */
const ReconciliationSnapshotV1 = z.strictObject({
  findings: z.array(FindingV1),
  summary: z.string(),
  warnings: z.array(z.string()),
  ledger: LedgerV1,
});

export const ReviewProgressV1 = z.strictObject({
  version: z.literal(1),
  discovery: DiscoverySnapshotV1.optional(),
  escalation: EscalationSnapshotV1.optional(),
  verification: VerificationSnapshotV1.optional(),
  reconciliation: ReconciliationSnapshotV1.optional(),
});
export type ReviewProgress = z.infer<typeof ReviewProgressV1>;

/** The full computed review envelope persisted atomically with the review row. */
export const CompletedReviewV1 = z.strictObject({
  version: z.literal(1),
  summary: z.string(),
  verdict: z.enum(['approve', 'comment', 'request_changes']),
  findings: z.array(FindingV1),
  skippedFiles: z.array(z.string()),
  warnings: z.array(z.string()),
  riskMetadata: z.array(z.strictObject({ path: z.string(), risk: z.unknown() })),
  trace: z.unknown().optional(),
  provider: z.string(),
  model: z.string(),
  costUsd: NonNegative.nullable(),
});
export type CompletedReview = z.infer<typeof CompletedReviewV1>;

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`).join(',')}}`;
}
export const canonicalJson = canonicalize;
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}
export function compatibilityKey(value: ReviewCompatibility): string {
  return canonicalHash(ReviewCompatibilityV1.parse(value));
}

/** The furthest stage whose output is already durable. */
export function resumeStageOf(progress: ReviewProgress): 'reconciliation' | 'verification' | 'escalation' | 'discovery' | undefined {
  if (progress.reconciliation) return 'reconciliation';
  if (progress.verification) return 'verification';
  if (progress.escalation) return 'escalation';
  if (progress.discovery) return 'discovery';
  return undefined;
}

/** Ledger of the most recently completed stage, if any. */
export function lastLedgerOf(progress: ReviewProgress): ReviewLedger | undefined {
  return progress.reconciliation?.ledger ?? progress.verification?.ledger ?? progress.escalation?.ledger ?? progress.discovery?.ledger;
}

export class ReviewCheckpointBusyError extends Error {
  readonly code = 'REVIEW_CHECKPOINT_BUSY';
  constructor(readonly jobId: number | null) {
    super('review checkpoint is already owned');
    this.name = 'ReviewCheckpointBusyError';
  }
}

export class ReviewCheckpointCorruptError extends Error {
  readonly code = 'REVIEW_CHECKPOINT_CORRUPT';
  constructor(message = 'review checkpoint payload is corrupt') {
    super(message);
    this.name = 'ReviewCheckpointCorruptError';
  }
}

/** Fail closed: any parse or hash mismatch discards the payload and recomputes. */
export function validateCheckpointPayload(progressJson: string | null, expectedHash?: string | null): ReviewProgress {
  try {
    if (!progressJson) throw new Error('missing payload');
    const progress = ReviewProgressV1.parse(JSON.parse(progressJson));
    if (expectedHash && canonicalHash(progress) !== expectedHash) throw new Error('payload hash mismatch');
    return progress;
  } catch (error) {
    throw new ReviewCheckpointCorruptError(error instanceof Error ? error.message : String(error));
  }
}
