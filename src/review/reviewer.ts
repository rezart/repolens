import type { Db, RepoRow } from '../db.js';
import { matchesGlob } from 'node:path';
import { createHash } from 'node:crypto';
import { reviewCallCost } from '../usage/review-cost.js';
import type { CompleteRequest, LLMProvider } from '../llm/types.js';
import { reviewCostUpperBound, REVIEW_MAX_USD, REVIEW_MAX_OUTPUT, REVIEW_ESCALATION_MAX_OUTPUT } from './budget.js';
import { IncompleteResponseError, NetworkProviderError, ProviderError } from '../llm/types.js';
import { extractJson, JsonExtractError } from '../llm/json.js';
import type { RetrieveFn, RetrievedChunk } from '../search/types.js';
import { truncateDescription } from './github.js';
import type { CommitStatusState, GitHubClient, PullRequest } from './github.js';
import { parseUnifiedDiff, changedNewLines, hunkText, type DiffFile } from './diff.js';
import { buildLineage, deltaForFile, type Lineage } from './lineage.js';
import { buildHistoricalContext, type HistoricalPr } from './history.js';
import { assessChange, selectReviewCandidates, type ChangeRisk } from './selection.js';
import { collectStaticEvidence, type StaticEvidenceFact } from './static-evidence.js';
import {
  FILE_REVIEW_SYSTEM_PROMPT,
  BATCH_REVIEW_SYSTEM_PROMPT,
  CONTRACT_CONCURRENCY_DISCOVERY_SYSTEM_PROMPT,
  FOLLOWUP_BATCH_REVIEW_SYSTEM_PROMPT,
  ESCALATION_SYSTEM_PROMPT,
  VERIFIER_SYSTEM_PROMPT,
  focusedVerifierSystemPrompt,
  buildFileReviewMessage,
  renderHistoricalContext,
} from './prompts.js';

export type Severity = 'critical' | 'warning' | 'nit';
export type Verdict = 'approve' | 'comment' | 'request_changes';
export type FindingCategory = 'correctness' | 'edge_case' | 'security' | 'test_gap' | 'repository_rule';
export type FindingConfidence = 'high' | 'medium' | 'low';

export function buildEscalationJsonSchema(paths: string[], primaryIds: string[] = []): Record<string, unknown> {
  const stringEnum = (values: readonly string[]) => ({ type: 'string', enum: [...values] });
  const evidence = {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'line', 'trigger', 'consequence', 'rule'],
    properties: {
      path: stringEnum(paths),
      line: { type: 'integer' },
      trigger: { type: 'string' },
      consequence: { type: 'string' },
      rule: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'line', 'quote'],
            properties: { path: { type: 'string' }, line: { type: 'integer' }, quote: { type: 'string' } },
          },
          { type: 'null' },
        ],
      },
    },
  };
  const finding = {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'line', 'severity', 'title', 'body', 'category', 'confidence', 'rootCause', 'evidence'],
    properties: {
      path: stringEnum(paths),
      line: { type: 'integer' },
      severity: stringEnum(['critical', 'warning', 'nit']),
      title: { type: 'string' },
      body: { type: 'string' },
      category: stringEnum(['correctness', 'edge_case', 'security', 'test_gap', 'repository_rule']),
      confidence: stringEnum(['high', 'medium', 'low']),
      rootCause: { type: 'string' },
      evidence,
    },
  };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['reviewedPaths', 'decisions', 'findings'],
    properties: {
      reviewedPaths: {
        type: 'array', minItems: paths.length, maxItems: paths.length,
        items: stringEnum(paths),
      },
      decisions: {
        type: 'array', minItems: primaryIds.length, maxItems: primaryIds.length,
        items: {
          type: 'object', additionalProperties: false, required: ['id', 'decision'],
          properties: { id: stringEnum(primaryIds), decision: stringEnum(['retain', 'reject', 'uncertain']) },
        },
      },
      findings: { type: 'array', items: finding },
    },
  };
}

export interface FindingEvidence {
  path: string;
  line: number;
  trigger: string;
  consequence: string;
  /** Required when category is repository_rule; verified against repository instructions later. */
  rule?: { path: string; line: number; quote: string };
}
/** Which findings make the commit status fail. */
export type FailOn = 'critical' | 'warning' | 'never';

export interface ReviewStatus {
  state: CommitStatusState;
  description: string;
}

export interface Finding {
  path: string;
  line: number;
  severity: Severity;
  title: string;
  body: string;
  /** Optional in storage so reviews written before evidence was introduced remain readable. */
  category?: FindingCategory;
  confidence?: FindingConfidence;
  rootCause?: string;
  evidence?: FindingEvidence;
}

/** Thrown when a new push lands on the PR mid-review; the fresh head gets its own review. */
export class ReviewSupersededError extends Error {
  constructor(
    public readonly staleSha: string,
    public readonly newSha: string,
  ) {
    super(`review of ${shortSha(staleSha)} abandoned: PR head moved to ${shortSha(newSha)}`);
  }
}

export interface ReviewFailureTelemetry {
  headSha: string;
  costUsd: number | null;
  trace?: ReviewTrace;
}

/** Terminal review failures retain the billing and staged-call metadata known so far. */
export class ReviewExecutionError extends Error {
  constructor(message: string, public readonly telemetry: ReviewFailureTelemetry) {
    super(message);
    this.name = 'ReviewExecutionError';
  }
}

export interface ReviewResult {
  reviewId: number;
  prNumber: number;
  headSha: string;
  summary: string;
  verdict: Verdict;
  findings: Finding[];
  posted: boolean;
  reviewUrl?: string;
  skippedFiles: string[];
  warnings: string[];
  /** Deterministic risk metadata for the reviewed candidate files. */
  riskMetadata: Array<{ path: string; risk: ChangeRisk }>;
  /** The commit status reported on the PR head, when statuses are enabled. */
  status?: ReviewStatus;
  /** Replayable, non-secret metadata for the staged review. */
  trace?: ReviewTrace;
}

export interface ReviewTraceFinding {
  path: string;
  line: number;
  rootCauseMarker: string;
}

export interface ReviewTraceDecision {
  id: string | number;
  decision: string;
  explanation: string;
  evidence?: unknown;
}

export interface ReviewTraceExperiment {
  discovery: Finding[];
  verificationCandidates: Array<{ id: number; rootCauseMarker: string; finding: Finding }>;
  verificationDecisions: ReviewTraceDecision[];
  focusedDecisions?: ReviewTraceDecision[];
  publishedFindings: Array<{ id: number | null; rootCauseMarker: string; finding: Finding }>;
}

export interface ReviewTrace {
  version: 1;
  identity: { repoId: string; prNumber: number; headSha: string; baseSha: string; provider: string; model: string; config: { maxRetries: number; maxFiles: number } };
  stages: Array<{
    stage: 'initial' | 'escalation' | 'verification' | 'final';
    selectedPaths: string[];
    hunks: Array<{ path: string; lines: number[] }>;
    omittedContext: number;
    calls: Array<{ provider: string; model: string; estimatedCostUsd: number; costUsd: number | null; outcome: 'success' | 'error' | 'validation_error'; failure?: string; pass?: 'normal' | 'focused'; elapsedMs?: number }>;
    findingCount: number;
    primaryFindings?: ReviewTraceFinding[];
    decisions?: Array<{ id: string | number; decision: string }>;
    focusedDecisions?: Array<{ id: string | number; decision: string }>;
    focusedSkipped?: 'budget' | 'disabled';
    findings?: ReviewTraceFinding[];
  }>;
  finalFindings: ReviewTraceFinding[];
  experiment?: ReviewTraceExperiment;
}

export interface ReviewDeps {
  db: Db;
  llm: LLMProvider;
  /** Optional stronger backend used only for risky hunks. */
  escalationLlm?: LLMProvider;
  /** Optional cheap backend used to verify provisional findings. */
  verifierLlm?: LLMProvider;
  /** Run the independent contract/concurrency discovery view when true. */
  dualDiscovery?: boolean;
  /** Recheck verifier-uncertain findings with a focused call. */
  focusedVerification?: boolean;
  retrieve: RetrieveFn;
  github: Pick<
    GitHubClient,
    | 'getPull'
    | 'getPullDiff'
    | 'getFileContent'
    | 'createReview'
    | 'listReviewComments'
    | 'createCommitStatus'
    | 'listPullCommits'
    | 'compareDiff'
    | 'listPathCommits'
    | 'listCommitPulls'
  >;
  /** Injected from search/tokenize.ts in production. */
  identifiers?: (text: string) => string[];
  /** Injected from search/retrieve.ts in production. */
  formatContext?: (chunks: RetrievedChunk[]) => string;
  maxFiles?: number;
  /** Extra attempts for failed batch reviews; default 3, within the total budget. */
  maxRetries?: number;
  /** Injectable for tests; production waits between rate-limit retries. */
  sleep?: (ms: number) => Promise<void>;
  /** Commit status context reported on the PR head; blank/undefined disables statuses. */
  statusContext?: string;
  /** Which findings turn the commit status red (default `critical`). */
  failOn?: FailOn;
  /** Base URL of this RepoLens install, used as a status target when the PR has no URL. */
  publicUrl?: string;
  /** Repository-relative globs excluded from review. */
  ignorePatterns?: string[];
  log?: (msg: string) => void;
}

export interface ReviewOptions {
  repoId: string;
  prNumber: number;
  /** Post the review to GitHub (default true). */
  post?: boolean;
  /** Re-review even when a review for this head sha already exists. */
  force?: boolean;
  /** Ignore prior reviews and GitHub comments for an independent benchmark run. */
  fresh?: boolean;
  /** Include full discovery/verifier/publication provenance in the trace. */
  experimentTrace?: boolean;
}

const SEVERITIES: readonly Severity[] = ['critical', 'warning', 'nit'];

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
  'composer.lock',
  'gemfile.lock',
  'poetry.lock',
  'pdm.lock',
  'cargo.lock',
  'go.sum',
  'mix.lock',
  'packages.lock.json',
  'pipfile.lock',
  'flake.lock',
]);

const SKIP_DIRS = ['node_modules/', 'vendor/', 'dist/', 'build/', '.next/', 'out/', 'target/', 'coverage/', '.venv/', 'generated/', 'gen/', '__generated__/'];

const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'avif', 'tiff', 'svgz',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar', 'war',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'mp4', 'mov', 'avi', 'webm', 'wav', 'ogg', 'flac',
  'so', 'dylib', 'dll', 'exe', 'bin', 'wasm', 'class', 'o', 'a',
  'pyc', 'pyo', 'db', 'sqlite', 'sqlite3', 'parquet',
]);

/** Files RepoLens will not spend an LLM call on. */
function matchesIgnorePattern(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesGlob(path, pattern));
}

/** Detect standard generated-file notices in the first five diff lines. */
export function hasGeneratedHeader(file: DiffFile): boolean {
  return file.hunks.flatMap((hunk) => hunk.lines)
    // Deleted marker lines do not describe the post-change file; a hand-written
    // file that removed its old generated notice must still be reviewed.
    .filter((line) => line.type !== 'del' && line.newLine !== undefined && line.newLine <= 5)
    .some((line) => /^\s*(?:(?:\/\/|#|;|--)\s*)?(?:code\s+generated\b.*\bdo not edit\b.*|@generated\b.*)$/i.test(line.content));
}

function hasGeneratedContent(content: string): boolean {
  return content.split('\n').slice(0, 5).some((line) => /^\s*(?:(?:\/\/|#|;|--)\s*)?(?:code\s+generated\b.*\bdo not edit\b.*|@generated\b.*)$/i.test(line));
}

export function isReviewablePath(path: string, ignorePatterns: string[] = []): boolean {
  if (!path) return false;
  const lower = path.toLowerCase();
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  if (matchesIgnorePattern(path, ignorePatterns)) return false;
  if (LOCKFILES.has(base)) return false;
  if (SKIP_DIRS.some((d) => lower === d.slice(0, -1) || lower.startsWith(d) || lower.includes(`/${d}`))) return false;
  if (base.endsWith('.snap')) return false;
  if (/\.min\.(js|css|mjs|cjs)$/.test(base)) return false;
  if (/[.-]bundle\.js$/.test(base)) return false;
  if (base.endsWith('.map')) return false;
  if (/(?:\.generated|\.gen|_generated|\.pb)\.[^.]+$/.test(base)) return false;
  const dot = base.lastIndexOf('.');
  if (dot > 0 && BINARY_EXT.has(base.slice(dot + 1))) return false;
  return true;
}

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]{2,}/g;

/** Fallback for `deps.identifiers` (search/tokenize.ts supplies the real one). */
export function defaultIdentifiers(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(IDENT_RE)) {
    seen.add(m[0]);
    if (seen.size >= 40) break;
  }
  return [...seen];
}

/** Fallback for `deps.formatContext` (search/retrieve.ts supplies the real one). */
export function defaultFormatContext(chunks: RetrievedChunk[]): string {
  return chunks.map((c) => `### ${c.path}:${c.startLine}-${c.endLine}\n\`\`\`\n${c.content}\n\`\`\``).join('\n\n');
}

function escapedTerm(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function chunkIdentity(chunk: RetrievedChunk): string {
  return `${chunk.path}\0${chunk.startLine}\0${chunk.endLine}\0${chunk.content}`;
}

function isCodeLikeTerm(term: string, text: string): boolean {
  const escaped = escapedTerm(term);
  return /[A-Z_$]/.test(term) ||
    new RegExp(`\\.${escaped}\\b`).test(text) ||
    new RegExp(`(?:[.$({\\[])\\s*${escaped}(?=\\s*[.$({\\[=,:;)]|$)`).test(text) ||
    new RegExp(`\\b${escaped}(?=\\s*[.$({\\[=,:;)]|$)`).test(text) ||
    new RegExp('`[^`]*\\b' + escaped + '\\b`').test(text);
}

/** Keep only base-index chunks that can explain the changed identifiers. */
export function selectRelevantChunks(chunks: RetrievedChunk[], identifiers: string[], changedPath: string, limit = 8): RetrievedChunk[] {
  const terms = [...new Set(identifiers.map((value) => value.toLowerCase()).filter((value) =>
    value.length >= 2 && !CONTEXT_KEYWORDS.has(value)))];
  if (!terms.length) return [];
  const stem = changedPath.slice(changedPath.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '').toLowerCase();
  const matches = (text: string, term: string) => new RegExp(`(?:^|[^a-z0-9_$])${escapedTerm(term)}(?:$|[^a-z0-9_$])`, 'i').test(text);
  const unique = new Map<string, RetrievedChunk>();
  for (const chunk of chunks) {
    if (chunk.path === changedPath) continue;
    unique.set(chunkIdentity(chunk), chunk);
  }
  const scored = [...unique.values()].map((chunk, index) => {
    const haystack = `${chunk.path}\n${chunk.content}`;
    const score = terms.reduce((total, term, termIndex) => total + (matches(haystack, term) ? termIndex < 3 ? 2 : 1 : 0), 0) +
      (stem && matches(chunk.path, stem) ? 0.25 : 0);
    return { chunk, score, index };
  }).filter((item) => item.score > 0);
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).slice(0, limit).map((item) => item.chunk);
}

export function contextQuery(path: string, changedText: string, identifiers: (text: string) => string[]): { stem: string; symbols: string[] } {
  const stem = path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
  const pathTerms = path.match(/[A-Za-z][A-Za-z0-9_]*/g) ?? [];
  const raw = [...new Set([...identifiers(changedText), ...(changedText.match(IDENTIFIER_RE) ?? [])])];
  const precise = raw.filter((term) => isCodeLikeTerm(term, changedText));
  const strong = precise.filter((term) => /[a-z][A-Z]/.test(term) || /^[A-Z]{2,}$/.test(term) || term.includes('_') || term.includes('$'));
  const ordinary = precise.filter((term) => !strong.includes(term) && !/^[A-Z][a-z]+$/.test(term));
  const weak = precise.filter((term) => !strong.includes(term) && !ordinary.includes(term));
  const symbols = [...new Set([...strong, ...ordinary, ...pathTerms, ...weak])]
    .filter((term) => term.length >= 2 && !CONTEXT_KEYWORDS.has(term.toLowerCase()));
  return { stem, symbols };
}

async function retrieveTargetedChunks(
  retrieve: RetrieveFn,
  repoId: string,
  path: string,
  changedText: string,
  identifiers: (text: string) => string[],
  excludePaths: string[],
  focusText?: string,
): Promise<RetrievedChunk[]> {
  const targeted = focusText?.trim()
    ? contextQuery(path, focusText, identifiers)
    : contextQuery(path, changedText, identifiers);
  const changedSymbols = targeted.symbols.filter((symbol) => !symbol.includes('/') && symbol !== targeted.stem).slice(0, 6);
  const queries = [...changedSymbols, path, targeted.stem].filter((query, index, all) => query && all.indexOf(query) === index);
  const testQuery = [...changedSymbols, targeted.stem, 'test'].filter(Boolean).join(' ');
  if (testQuery && !queries.includes(testQuery)) queries.push(testQuery);
  const chunksById = new Map<number, RetrievedChunk>();
  for (const query of queries) {
    for (const chunk of await retrieve({ repoIds: [repoId], query, limit: 8, excludePaths })) chunksById.set(chunk.chunkId, chunk);
  }
  const excluded = new Set(excludePaths);
  const relevant = selectRelevantChunks([...chunksById.values()].filter((chunk) => !excluded.has(chunk.path)), [...changedSymbols, targeted.stem], path, Number.MAX_SAFE_INTEGER);
  const selected = relevant.slice(0, 8);
  const testChunk = relevant.find((chunk) => /(^|\/)(test|tests|spec|__tests__)(\/|$)|\.(test|spec)\./i.test(chunk.path));
  if (testChunk && !selected.some((chunk) => chunk.chunkId === testChunk.chunkId)) {
    selected.pop();
    selected.push(testChunk);
  }
  return selected.slice(0, 8);
}

function mergeRelevantChunks(original: RetrievedChunk[], focused: RetrievedChunk[], limit = 8): RetrievedChunk[] {
  const unique = new Map<string, RetrievedChunk>();
  for (const chunk of [...original.slice(0, Math.ceil(limit / 2)), ...focused]) {
    unique.set(chunkIdentity(chunk), chunk);
  }
  const selected = [...unique.values()].slice(0, limit);
  const testChunk = [...original, ...focused].find((chunk) => /(^|\/)(test|tests|spec|__tests__)(\/|$)|\.(test|spec)\./i.test(chunk.path));
  if (testChunk && !selected.some((chunk) => chunkIdentity(chunk) === chunkIdentity(testChunk))) {
    selected.pop();
    selected.push(testChunk);
  }
  return selected;
}

/** Root and ancestor rule files that can apply to the changed paths. */
export function repositoryRulePaths(changedPaths: string[]): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const add = (path: string) => { if (!seen.has(path)) { seen.add(path); paths.push(path); } };
  add('AGENTS.md'); add('CLAUDE.md');
  for (const path of changedPaths) {
    const parts = path.split('/');
    for (let i = parts.length - 1; i >= 1; i--) {
      const dir = parts.slice(0, i).join('/');
      add(`${dir}/AGENTS.md`); add(`${dir}/CLAUDE.md`);
    }
  }
  return paths;
}

export function renderRepositoryRules(rules: Map<string, string>, baseSha: string): string {
  return [...rules].map(([path, content]) => `### ${path} (base ${baseSha.slice(0, 12)})\n${content.split('\n').map((line, i) => `${i + 1} | ${line}`).join('\n')}`).join('\n\n');
}

const CONTEXT_KEYWORDS = new Set([
  'abstract', 'async', 'await', 'boolean', 'case', 'catch', 'class', 'const', 'else', 'export', 'extends', 'false',
  'function', 'if', 'import', 'interface', 'let', 'new', 'null', 'number', 'private', 'protected', 'public', 'return',
  'string', 'throw', 'true', 'type', 'undefined', 'var', 'void', 'while',
  'css', 'cts', 'js', 'jsx', 'mjs', 'mts', 'src', 'ts', 'tsx',
]);

/* ------------------------------------------------------------------ PR head context */

/** How many changed files RepoLens fetches the post-change content of. */
const HEAD_FILES_MAX = 60;
/** Concurrent `contents` requests. */
const HEAD_FETCH_CONCURRENCY = 4;
/** Per referenced file, inside the head-context section. */
const HEAD_SNIPPET_CHARS_MAX = 8_000;
/** Total budget for referenced files (the reviewed file's own content is separate). */
const HEAD_CONTEXT_CHARS_MAX = 24_000;
/** At most this many unchanged files may be fetched for verifier evidence. */
const REFERENCED_HEAD_FILES_MAX = 16;
/** The reviewed file's own content is included in full only up to this size. */
const OWN_HEAD_CHARS_MAX = 12_000;
const OWN_HEAD_WINDOW_RADIUS = 20;
const OWN_HEAD_WINDOW_COUNT_MAX = 8;
const OWN_HEAD_LINE_CHARS_MAX = 600;
const RULE_FILES_MAX = 16;
const RULE_REQUESTS_MAX = 128;
const RULE_CHARS_MAX = 12_000;
/** Global cap for advisory heuristics in an untrimmed verifier payload. */
const STATIC_EVIDENCE_VERIFIER_MAX = 80;

/** Module specifiers of `import`, `import()`, `export ... from` and `require()`. */
const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"\n]+)['"]/g;
/** `export function|const|class|interface|type|enum <name>` (and the usual variants). */
const EXPORT_DECL_RE =
  /^[ \t]*export[ \t]+(?:declare[ \t]+)?(?:default[ \t]+)?(?:abstract[ \t]+)?(?:async[ \t]+)?(?:function\*?|const|let|var|class|interface|type|enum)[ \t]+([A-Za-z_$][\w$]*)/gm;
/** `export { a, b as c }` — the exported name is the one after `as`. */
const EXPORT_LIST_RE = /\bexport[ \t]*\{([^}]*)\}/g;
const IDENTIFIER_RE = /[A-Za-z_$][\w$]*/g;
/** Extensionless and `.js`-suffixed specifiers both resolve onto TypeScript sources. */
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js'];

/** Resolve `./a/../b` style segments; paths are repository-relative, so `..` above the root is dropped. */
function normalizeRepoPath(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/**
 * Resolve a relative module specifier used inside `fromPath` onto one of `changed`.
 * Handles the ESM `./x.js` → `x.ts` rewrite and directory `index` files.
 * Returns null for bare (package) specifiers and for files this PR does not touch.
 */
export function resolveChangedImport(fromPath: string, specifier: string, changed: Set<string>): string | null {
  if (!specifier.startsWith('.')) return null;
  const dir = fromPath.slice(0, fromPath.lastIndexOf('/') + 1);
  const base = normalizeRepoPath(dir + specifier);
  if (!base) return null;
  const bases = [base];
  const stripped = base.replace(/\.(js|jsx|mjs|cjs)$/, '');
  if (stripped !== base) bases.push(stripped);
  for (const b of bases) {
    for (const suffix of RESOLVE_SUFFIXES) {
      const candidate = b + suffix;
      if (changed.has(candidate)) return candidate;
    }
  }
  return null;
}

/** Names `content` exports, as far as a regex can tell. */
export function exportedNames(content: string): Set<string> {
  const names = new Set<string>();
  for (const m of content.matchAll(EXPORT_DECL_RE)) names.add(m[1]!);
  for (const m of content.matchAll(EXPORT_LIST_RE)) {
    for (const part of m[1]!.split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim() ?? '';
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

/** Exported names per path, computed once per review rather than once per reviewed file. */
export function buildExportIndex(headContents: Map<string, string>): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const [path, content] of headContents) index.set(path, exportedNames(content));
  return index;
}

export interface HeadEvidence {
  path: string;
  revision: 'head';
  lines: Array<{ line: number; text: string }>;
}

function numberedHeadLines(content: string, relevantLines: number[], maxChars: number): Array<{ line: number; text: string }> {
  const lines = content.split(/\r?\n/);
  const points = [...new Set(relevantLines)].filter((line) => Number.isInteger(line) && line > 0 && line <= lines.length).sort((a, b) => a - b);
  if (!content) return [];

  const anchors = !points.length ? [1] : points.length <= OWN_HEAD_WINDOW_COUNT_MAX
    ? points
    : Array.from({ length: OWN_HEAD_WINDOW_COUNT_MAX }, (_, index) => points[Math.round(index * (points.length - 1) / (OWN_HEAD_WINDOW_COUNT_MAX - 1))]!);
  const windows: Array<{ start: number; end: number; anchor: number }> = [];
  for (const line of anchors) {
    windows.push({
      start: Math.max(1, line - OWN_HEAD_WINDOW_RADIUS),
      end: Math.min(lines.length, line + OWN_HEAD_WINDOW_RADIUS),
      anchor: line,
    });
  }
  const perWindowChars = Math.max(80, Math.floor(maxChars / windows.length));
  const rendered: Array<{ line: number; text: string }> = [];
  const emitted = new Set<number>();
  for (const window of windows) {
    const nearby = [window.anchor];
    for (let distance = 1; distance <= OWN_HEAD_WINDOW_RADIUS; distance++) {
      if (window.anchor - distance >= window.start) nearby.push(window.anchor - distance);
      if (window.anchor + distance <= window.end) nearby.push(window.anchor + distance);
    }
    const selected = new Map<number, string>();
    let used = 0;
    for (const line of nearby) {
      const prefix = `${line} | `;
      const text = lines[line - 1] ?? '';
      const room = perWindowChars - used - prefix.length - 1;
      if (room < 0) break;
      const value = text.length > Math.min(OWN_HEAD_LINE_CHARS_MAX, room)
        ? `${text.slice(0, Math.min(OWN_HEAD_LINE_CHARS_MAX, room))} ... (line truncated)`
        : text;
      const output = `${prefix}${value}`;
      if (used + output.length + 1 > perWindowChars) break;
      selected.set(line, output);
      used += output.length + 1;
    }
    for (const line of [...selected.keys()].sort((a, b) => a - b)) {
      if (emitted.has(line)) continue;
      const output = selected.get(line)!;
      rendered.push({ line, text: output.slice(output.indexOf(' | ') + 3) });
      emitted.add(line);
    }
  }
  return rendered;
}

function renderHeadEvidence(snippet: HeadEvidence, heading: string): string {
  return `### ${snippet.path} (${heading})\n\`\`\`\n${snippet.lines.map(({ line, text }) => `${line} | ${text}`).join('\n')}\n\`\`\``;
}

function headSnippet(path: string, content: string, relevantLines: number[]): HeadEvidence {
  return { path, revision: 'head', lines: numberedHeadLines(content, relevantLines, HEAD_SNIPPET_CHARS_MAX) };
}

function matchingHeadLines(content: string, terms: Set<string>): number[] {
  const lowerTerms = [...terms].map((term) => term.toLowerCase());
  if (!lowerTerms.length) return [1];
  const lines = content.split(/\r?\n/);
  const matches = lines.flatMap((line, index) => lowerTerms.some((term) => line.toLowerCase().includes(term)) ? [index + 1] : []);
  return matches.length ? matches : [1];
}

/**
 * The post-change content the model needs to judge `path`: its own new content plus
 * the new content of the changed files it references — the ones a stale index would
 * otherwise describe with their pre-change exports.
 */
export function buildHeadContext(input: {
  path: string;
  addedText: string;
  headContents: Map<string, string>;
  /** Unchanged files fetched at the PR head for explicit verifier evidence. */
  referencedHeadContents?: Map<string, string>;
  /** Retrieved base-index ranges that identify the bounded head snippets above. */
  referencedHeadLines?: Map<string, number[]>;
  /** New-file lines whose surrounding head code is relevant to this review. */
  relevantLines?: number[];
  /** Precomputed `exportedNames` per path; recomputed here when absent. */
  exportsByPath?: Map<string, Set<string>>;
}): string {
  return collectHeadEvidence(input).map((snippet) => renderHeadEvidence(snippet,
    snippet.path === input.path ? 'content after this pull request; bounded windows' : 'content after this pull request')).join('\n\n');
}

/** Structured authoritative snippets used to construct verifier citation allowlists. */
export function buildHeadEvidence(input: {
  path: string;
  addedText: string;
  headContents: Map<string, string>;
  referencedHeadContents?: Map<string, string>;
  referencedHeadLines?: Map<string, number[]>;
  relevantLines?: number[];
  exportsByPath?: Map<string, Set<string>>;
}): HeadEvidence[] {
  return collectHeadEvidence(input);
}

function collectHeadEvidence(input: {
  path: string;
  addedText: string;
  headContents: Map<string, string>;
  referencedHeadContents?: Map<string, string>;
  referencedHeadLines?: Map<string, number[]>;
  relevantLines?: number[];
  exportsByPath?: Map<string, Set<string>>;
}): HeadEvidence[] {
  const { path, addedText, headContents } = input;
  const exportsByPath = input.exportsByPath ?? buildExportIndex(headContents);
  const own = headContents.get(path);
  const changed = new Set(headContents.keys());

  // (i) files this one imports, in the order they appear.
  const imported: string[] = [];
  if (own) {
    for (const m of own.matchAll(SPECIFIER_RE)) {
      const target = resolveChangedImport(path, m[1]!, changed);
      if (target && target !== path && !imported.includes(target)) imported.push(target);
    }
  }

  // (ii) files that export an identifier the added lines mention.
  const mentioned = new Set(addedText.match(IDENTIFIER_RE) ?? []);
  const byExport: string[] = [];
  for (const other of headContents.keys()) {
    if (other === path || imported.includes(other)) continue;
    for (const name of exportsByPath.get(other) ?? []) {
      if (mentioned.has(name)) {
        byExport.push(other);
        break;
      }
    }
  }

  const snippets: HeadEvidence[] = [];
  let used = 0;
  for (const referenced of [...imported, ...byExport]) {
    const content = headContents.get(referenced);
    if (content === undefined) continue;
    const terms = new Set([...mentioned, referenced.slice(referenced.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '')]);
    const snippet = headSnippet(referenced, content, matchingHeadLines(content, terms));
    const block = renderHeadEvidence(snippet, 'content after this pull request; bounded snippet');
    if (used + block.length > HEAD_CONTEXT_CHARS_MAX) break;
    snippets.push(snippet);
    used += block.length + 2;
  }
  for (const [referenced, content] of input.referencedHeadContents ?? []) {
    if (referenced === path || headContents.has(referenced) || snippets.some((snippet) => snippet.path === referenced)) continue;
    const snippet = headSnippet(referenced, content, input.referencedHeadLines?.get(referenced) ?? [1]);
    const block = renderHeadEvidence(snippet, 'content after this pull request; bounded snippet');
    if (used + block.length > HEAD_CONTEXT_CHARS_MAX) break;
    snippets.push(snippet);
    used += block.length + 2;
  }

  // The diff alone hides the code around the hunks, so lead with the whole file.
  if (own !== undefined) {
    const relevantLines = input.relevantLines ?? [];
    snippets.unshift({ path, revision: 'head', lines: numberedHeadLines(own, relevantLines, OWN_HEAD_CHARS_MAX) });
  }
  return snippets;
}

export function buildReviewBody(input: {
  summary: string;
  verdict: Verdict;
  findings: Finding[];
  providerName: string;
  model: string;
  skippedFiles?: string[];
  lineage?: Pick<Lineage, 'reviewNumber' | 'previous'>;
}): string {
  const findings = selectPostedFindings(input.findings);
  const counts = { critical: 0, warning: 0, nit: 0 };
  for (const f of findings) counts[f.severity]++;
  const parts: string[] = ['## RepoLens review', '', input.summary.trim(), ''];
  parts.push(
    `**Verdict:** ${input.verdict} · **Findings:** ${findings.length} (${counts.critical} critical, ${counts.warning} warnings, ${counts.nit} nits)`,
  );
  if (findings.length) {
    parts.push('');
    parts.push('| Severity | File | Title |');
    parts.push('| --- | --- | --- |');
    for (const f of findings) {
      parts.push(`| ${f.severity} | ${f.path}:${f.line} | ${escapeCell(f.title)} |`);
    }
    const bodyFindings = findings.filter((f) => f.line === 0);
    if (bodyFindings.length) {
      parts.push('');
      parts.push('### Findings without an inline location');
      for (const f of bodyFindings) parts.push(`- **[${f.severity}] ${escapeCell(f.title)}** (${f.path})\n\n${f.body}`);
    }
  }
  parts.push('');
  if (input.skippedFiles?.length) {
    parts.push(`Skipped files (not reviewed): ${input.skippedFiles.join(', ')}`);
    parts.push('');
  }
  if (input.lineage?.previous) {
    const n = input.lineage.previous.commitsSince;
    parts.push(
      `<sub>Review ${input.lineage.reviewNumber} of this pull request; ${n} commit${n === 1 ? '' : 's'} since ${shortSha(input.lineage.previous.headSha)}.</sub>`,
    );
    parts.push('');
  }
  parts.push(`<sub>Generated by RepoLens (${input.providerName}/${input.model})</sub>`);
  return parts.join('\n');
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Math.max(1, Math.min(Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 1, items.length || 1));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]!);
      }
    }),
  );
  return results;
}

function traceHunks(files: DiffFile[]): Array<{ path: string; lines: number[] }> {
  return files.map((file) => ({
    path: file.newPath ?? file.oldPath ?? '',
    lines: [...new Set(file.hunks.flatMap((hunk) => hunk.lines.flatMap((line) => line.newLine !== undefined ? [line.newLine] : line.oldLine !== undefined ? [line.oldLine] : [])))].sort((a, b) => a - b),
  }));
}

function traceFinding(finding: Finding): ReviewTraceFinding {
  return { path: finding.path, line: findingLine(finding), rootCauseMarker: rootCauseMarker(finding) };
}

function withCorrection(req: CompleteRequest, validationError: string, allowedPathsAndLines: Array<{ path: string; lines: number[] }>): CompleteRequest {
  const content = req.messages[0]?.content ?? '';
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(content) as unknown;
    payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { original: parsed };
  } catch {
    payload = { original: content };
  }
  payload.validationError = validationError;
  payload.allowedPathsAndLines = allowedPathsAndLines;
  return { ...req, messages: [{ ...req.messages[0]!, content: JSON.stringify(payload) }, ...req.messages.slice(1)] };
}

function allowedFindingLines(file: DiffFile): Set<number> {
  const added = changedNewLines(file);
  if (file.status !== 'deleted' && added.size > 0) return added;
  return new Set(file.hunks.flatMap((h) => h.lines.flatMap((l) => l.oldLine === undefined ? [] : [l.oldLine])));
}

function hasExactReviewedPaths(value: unknown, paths: string[]): boolean {
  return Array.isArray(value) && value.length === paths.length &&
    value.every((path) => typeof path === 'string') && new Set(value).size === paths.length &&
    paths.every((path) => value.includes(path));
}

function findingLine(finding: Finding): number {
  return finding.evidence?.line ?? finding.line;
}

function hunkContainsLine(file: DiffFile, hunkIndex: number, line: number): boolean {
  const hunk = file.hunks[hunkIndex];
  if (!hunk) return false;
  return hunk.lines.some((item) => item.newLine === line || item.oldLine === line);
}

function headRelevantLines(file: DiffFile, hunks = file.hunks): number[] {
  return hunks.flatMap((hunk) => {
    const lines = hunk.lines.flatMap((line) => line.newLine === undefined ? [] : [line.newLine]);
    // A deletion-only hunk has no new-file lines; anchor it at the first
    // post-change line so surrounding guards/exits remain inspectable.
    if (!lines.length) return [Math.max(1, hunk.newStart)];
    return lines[0] === lines[lines.length - 1] ? [lines[0]!] : [lines[0]!, lines[lines.length - 1]!];
  });
}

type VerifierContextFile = {
  path: string;
  currentEvidence?: Array<{ line?: number }>;
  headContext?: string;
  headEvidence?: HeadEvidence[];
};

function verifierCitationLines(file: VerifierContextFile): Set<string> {
  const cited = new Set<string>();
  for (const evidence of file.currentEvidence ?? []) {
    if (Number.isInteger(evidence.line) && evidence.line! > 0) cited.add(`${file.path}:${evidence.line}`);
  }
  for (const snippet of file.headEvidence ?? []) {
    if (snippet.revision !== 'head') continue;
    for (const line of snippet.lines) {
      if (Number.isInteger(line.line) && line.line > 0) cited.add(`${snippet.path}:${line.line}`);
    }
  }
  // Keep parsing the rendered form for compatibility with older callers/tests;
  // only the explicit post-change heading is authoritative.
  let currentPath = '';
  for (const line of file.headContext?.split(/\r?\n/) ?? []) {
    const heading = /^### (.+) \(content after this pull request/.exec(line);
    if (heading) currentPath = heading[1]!;
    const numbered = /^(\d+) \| /.exec(line);
    if (numbered && currentPath === file.path) cited.add(`${file.path}:${Number(numbered[1])}`);
  }
  return cited;
}

/** Accept only citations that point at supplied post-change evidence. */
export function hasValidVerifierCitation(decision: Record<string, unknown>, files: VerifierContextFile[]): boolean {
  const cited = new Set(files.flatMap((file) => [...verifierCitationLines(file)]));
  const evidence = decision.evidence;
  const candidates = Array.isArray(evidence) ? evidence : evidence && typeof evidence === 'object' ? [evidence] : [];
  for (const item of candidates) {
    if (!item || typeof item !== 'object') continue;
    const path = typeof (item as Record<string, unknown>).path === 'string' ? (item as Record<string, unknown>).path : '';
    const line = (item as Record<string, unknown>).line;
    if (typeof line === 'number' && Number.isInteger(line) && line > 0 && cited.has(`${path}:${line}`)) return true;
  }
  return false;
}

export function parseFindings(raw: string, file: DiffFile): Finding[] {
  const parsed = extractJson(raw) as { findings?: unknown } | unknown[];
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.findings) ? (parsed.findings as unknown[]) : null;
  if (!list) throw new Error('model output has no "findings" array');
  const path = file.newPath ?? file.oldPath ?? '';
  const allowed = allowedFindingLines(file);
  const bodyOnly = file.status === 'deleted' || changedNewLines(file).size === 0;
  const out: Finding[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('model output contains a malformed finding');
    const e = entry as Record<string, unknown>;
    const line = typeof e.line === 'number' ? e.line : typeof e.line === 'string' ? Number(e.line) : NaN;
    // allowed already contains old diff lines for deleted/deletion-only files.
    if (!Number.isInteger(line) || !allowed.has(line)) {
      throw new Error(`model output contains an invalid finding line for ${path}`);
    }
    const title = typeof e.title === 'string' ? e.title.trim() : '';
    const body = typeof e.body === 'string' ? e.body.trim() : '';
    if (!title && !body) throw new Error(`model output contains an empty finding for ${path}`);
    const sevRaw = typeof e.severity === 'string' ? e.severity.toLowerCase().trim() : '';
    if (!(SEVERITIES as readonly string[]).includes(sevRaw)) throw new Error(`model output contains an invalid finding severity for ${path}`);
    const severity = sevRaw as Severity;
    const category = typeof e.category === 'string' ? e.category.trim() : '';
    if (!(['correctness', 'edge_case', 'security', 'test_gap', 'repository_rule'] as const).includes(category as FindingCategory)) {
      throw new Error(`model output contains an invalid finding category for ${path}`);
    }
    const confidence = typeof e.confidence === 'string' ? e.confidence.toLowerCase().trim() : '';
    if (!(['high', 'medium', 'low'] as const).includes(confidence as FindingConfidence)) {
      throw new Error(`model output contains an invalid finding confidence for ${path}`);
    }
    const rootCause = typeof e.rootCause === 'string' ? e.rootCause.trim() : '';
    if (!rootCause) throw new Error(`model output contains no finding rootCause for ${path}`);
    if (!e.evidence || typeof e.evidence !== 'object' || Array.isArray(e.evidence)) {
      throw new Error(`model output contains no finding evidence for ${path}`);
    }
    const evidence = e.evidence as Record<string, unknown>;
    const evidencePath = typeof evidence.path === 'string' ? evidence.path.trim() : '';
    const evidenceLine = typeof evidence.line === 'number' ? evidence.line : typeof evidence.line === 'string' ? Number(evidence.line) : NaN;
    const trigger = typeof evidence.trigger === 'string' ? evidence.trigger.trim() : '';
    const consequence = typeof evidence.consequence === 'string' ? evidence.consequence.trim() : '';
    const ruleRaw = evidence.rule;
    const rule = ruleRaw && typeof ruleRaw === 'object' && !Array.isArray(ruleRaw) ? ruleRaw as Record<string, unknown> : null;
    const rulePath = typeof rule?.path === 'string' ? rule.path.trim() : '';
    const ruleLine = typeof rule?.line === 'number' ? rule.line : typeof rule?.line === 'string' ? Number(rule.line) : NaN;
    const ruleQuote = typeof rule?.quote === 'string' ? rule.quote.trim() : '';
    if (evidencePath !== path || evidenceLine !== line || !Number.isInteger(evidenceLine) || !trigger || !consequence ||
        (category === 'repository_rule' && (!rulePath || !Number.isInteger(ruleLine) || ruleLine < 1 || !ruleQuote))) {
      throw new Error(`model output contains invalid finding evidence for ${path}`);
    }
    out.push({ path, line: bodyOnly ? 0 : line, severity, title: title || body.slice(0, 60), body: body || title,
      category: category as FindingCategory, confidence: confidence as FindingConfidence, rootCause,
      evidence: { path: evidencePath, line: evidenceLine, trigger, consequence,
        ...(rulePath ? { rule: { path: rulePath, line: ruleLine, quote: ruleQuote } } : {}) } });
  }
  return out;
}

function findingGroups(findings: Finding[]): Map<string, Finding[]> {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings.filter((finding) => finding.category !== 'test_gap')) {
    const key = rootCauseMarker(finding);
    const group = groups.get(key);
    if (group) group.push(finding);
    else groups.set(key, [finding]);
  }
  return groups;
}

/** Select one deterministic, non-test-gap finding per root cause for publication. */
export function selectPostedFindings(findings: Finding[]): Finding[] {
  const groups = findingGroups(findings);
  const rank = (f: Finding) => severityRank(f.severity);
  const representative = (group: Finding[]) => [...group].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path) || a.line - b.line || a.title.localeCompare(b.title))[0]!;
  const canonical = [...groups.entries()]
    .map(([key, group]) => ({ key, group, finding: representative(group) }))
    .sort((a, b) => rank(a.finding) - rank(b.finding) || a.finding.path.localeCompare(b.finding.path) || a.finding.line - b.finding.line || normalizedRootCause(a.finding).localeCompare(normalizedRootCause(b.finding)));
  return canonical.map(({ finding }) => {
    const key = rootCauseMarker(finding);
    const group = groups.get(key) ?? [];
    const related = group.filter((other) => other !== finding && other.line > 0);
    if (!related.length) return finding;
    return { ...finding, body: `${finding.body}\n\nRelated locations: ${related.map((other) => `${other.path}:${other.line}`).join(', ')}` };
  });
}

const NO_FINDINGS_SUMMARY = 'The review found no actionable issues in the supplied changes.';

export function buildFindingSummary(findings: Finding[]): string {
  if (!findings.length) return NO_FINDINGS_SUMMARY;
  const counts = { critical: 0, warning: 0, nit: 0 };
  for (const finding of findings) counts[finding.severity]++;
  const count = findings.length === 1 ? '1 actionable issue' : `${findings.length} actionable issues`;
  const severity = Object.entries(counts).filter(([, n]) => n > 0).map(([name, n]) => `${n} ${name}`).join(', ');
  const details = findings.map((finding) => `${finding.title} (${finding.path}:${finding.line || 'body'})`).join('; ');
  return `The review found ${count} (${severity}): ${details}.`;
}

function normalizedRootCause(finding: Finding): string {
  const cause = finding.rootCause?.trim() || `${finding.path}:${finding.line}:${finding.title.trim()}`;
  return cause.replace(/\s+/g, ' ').toLowerCase();
}

function rootCauseMarker(finding: Finding): string {
  return createHash('sha256').update(normalizedRootCause(finding)).digest('hex').slice(0, 16);
}

function provisionalCandidateKey(finding: Finding): string {
  return `${rootCauseMarker(finding)}:${finding.path}:${findingLine(finding)}`;
}

function deduplicateProvisionalCandidates(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = provisionalCandidateKey(finding);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function primaryFindingIds(findings: Finding[]): string[] {
  const counts = new Map<string, number>();
  return findings.map((finding) => {
    const base = provisionalCandidateKey(finding);
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    return count ? `${base}:${count}` : base;
  });
}

function verdictForFindings(findings: Finding[]): Verdict {
  return findings.some((finding) => finding.severity === 'critical') ? 'request_changes' : findings.length ? 'comment' : 'approve';
}

function postedFindingBody(finding: Finding): string {
  return `<!-- repolens-root-cause:${rootCauseMarker(finding)} -->\n**[${finding.severity}] ${finding.title}**\n\n${finding.body}`;
}

async function validateRepositoryRuleFindings(
  findings: Finding[],
  github: ReviewDeps['github'],
  repo: RepoRow,
  baseSha: string,
  warnings: string[],
): Promise<Finding[]> {
  const contents = new Map<string, string | null>();
  const valid: Finding[] = [];
  for (const finding of findings) {
    const rule = finding.category === 'repository_rule' ? finding.evidence?.rule : undefined;
    if (!rule) { valid.push(finding); continue; }
    const fileDir = finding.path.includes('/') ? finding.path.slice(0, finding.path.lastIndexOf('/')) : '';
    const normalized = rule.path.replace(/^\/+|\/{2,}/g, '/').replace(/\/$/, '');
    const applicable = (normalized === 'CLAUDE.md' || normalized === 'AGENTS.md') ||
      (normalized.endsWith('/CLAUDE.md') || normalized.endsWith('/AGENTS.md')) &&
      (fileDir === normalized.slice(0, normalized.lastIndexOf('/')) || fileDir.startsWith(`${normalized.slice(0, normalized.lastIndexOf('/'))}/`));
    if (!applicable || rule.line < 1 || !rule.quote.trim()) {
      warnings.push(`Suppressed repository rule finding at ${finding.path}:${finding.line}: unsupported rule citation.`);
      continue;
    }
    let content = contents.get(normalized);
    if (content === undefined) {
      try { content = await github.getFileContent(repo.owner, repo.name, normalized, baseSha); }
      catch { content = null; }
      contents.set(normalized, content);
    }
    const line = content?.split(/\r?\n/)[rule.line - 1]?.trim();
    if (!line || line !== rule.quote.trim()) {
      warnings.push(`Suppressed repository rule finding at ${finding.path}:${finding.line}: rule citation does not match ${normalized}:${rule.line}.`);
      continue;
    }
    valid.push(finding);
  }
  return valid;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Map findings onto the commit status RepoLens reports on the PR head.
 * `failOn: 'never'` keeps the check informational (always green).
 */
export function statusForFindings(findings: Finding[], failOn: FailOn = 'critical'): ReviewStatus {
  const counts = { critical: 0, warning: 0, nit: 0 };
  for (const f of findings) counts[f.severity]++;
  const parts: string[] = [];
  if (counts.critical) parts.push(`${counts.critical} critical`);
  if (counts.warning) parts.push(plural(counts.warning, 'warning'));
  if (counts.nit) parts.push(plural(counts.nit, 'nit'));
  const blocking =
    failOn === 'critical' ? counts.critical > 0 : failOn === 'warning' ? counts.critical + counts.warning > 0 : false;
  return {
    state: blocking ? 'failure' : 'success',
    description: parts.length ? parts.join(', ') : 'No blocking findings',
  };
}

function severityRank(s: Severity): number {
  return s === 'critical' ? 0 : s === 'warning' ? 1 : 2;
}

function toVerdict(value: unknown): Verdict | null {
  if (typeof value !== 'string') return null;
  const v = value.toLowerCase().replace(/[\s-]/g, '_');
  return v === 'approve' || v === 'comment' || v === 'request_changes' ? v : null;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

interface PostContext {
  db: Db;
  github: ReviewDeps['github'];
  llm: Pick<LLMProvider, 'name' | 'model'>;
  repo: RepoRow;
  pr: PullRequest;
  log: (msg: string) => void;
  /** Set by runReview; a cached review is re-posted with its original body. */
  lineage?: Pick<Lineage, 'reviewNumber' | 'previous'>;
  fresh?: boolean;
}

/**
 * Post `result` to GitHub, mutating it in place. Never throws: a failed post leaves
 * `posted: false` and adds a warning so the stored review can be re-posted later.
 */
async function postReview(ctx: PostContext, result: ReviewResult): Promise<void> {
  const { db, github, llm, repo, pr, log } = ctx;
  const warnings = result.warnings;
  const publishedFindings = result.findings;

  let body = buildReviewBody({
    summary: result.summary,
    verdict: result.verdict,
    findings: publishedFindings,
    providerName: llm.name,
    model: llm.model,
    skippedFiles: result.skippedFiles,
    lineage: ctx.lineage,
  });
  // Retrieved context comes from the last indexed commit, not the PR head.
  if (repo.last_commit && pr.baseSha && repo.last_commit !== pr.baseSha) {
    body += `\n<sub>Context indexed at ${shortSha(repo.last_commit)}; PR base is ${shortSha(pr.baseSha)}.</sub>`;
  }

  // Drop findings that were already commented on an earlier run (e.g. a `synchronize` event).
  let comments = publishedFindings;
  if (!ctx.fresh) {
    try {
      const existing = await github.listReviewComments(repo.owner, repo.name, result.prNumber);
      const existingMarkers = new Set(existing.flatMap((comment) => [...comment.body.matchAll(/repolens-root-cause:([a-f0-9]{16})/g)].map((match) => match[1]!)));
      const groups = new Map<string, Finding[]>();
      for (const finding of comments) {
        const key = rootCauseMarker(finding);
        const group = groups.get(key);
        if (group) group.push(finding); else groups.set(key, [finding]);
      }
      const kept = [...groups.values()].filter((group) => {
        const marker = rootCauseMarker(group[0]!);
        return !existingMarkers.has(marker) && !group.some((f) => existing.some((c) => c.path === f.path && c.line === f.line && c.body.includes(f.title)));
      }).flat();
      const dropped = comments.length - kept.length;
      if (dropped > 0) {
        const msg = `Skipped ${dropped} findings already commented`;
        warnings.push(msg);
        log(`review: ${msg}`);
      }
      comments = kept;
    } catch (err) {
      const msg = `listing existing review comments failed: ${errMessage(err)}`;
      warnings.push(msg);
      log(`review: ${msg}`);
    }
  }

  try {
    // Never APPROVE automatically — an "approve" verdict still posts as a COMMENT review.
    const created = await github.createReview(repo.owner, repo.name, result.prNumber, {
      commitId: pr.headSha,
      body,
      event: result.verdict === 'request_changes' ? 'REQUEST_CHANGES' : 'COMMENT',
      comments: comments.filter((f) => f.line > 0).map((f) => ({
        path: f.path,
        line: f.line,
        body: postedFindingBody(f),
      })),
    });
    db.markReviewPosted(result.reviewId);
    result.posted = true;
    result.reviewUrl = created.htmlUrl;
  } catch (err) {
    // Keep the stored review: the next delivery for this head sha retries the post.
    const msg = `posting the review failed: ${errMessage(err)}`;
    warnings.push(msg);
    log(`review: ${msg}`);
  }
}

export async function reviewPullRequest(deps: ReviewDeps, opts: ReviewOptions): Promise<ReviewResult> {
  const { db, llm, retrieve, github } = deps;
  const escalationLlm = deps.escalationLlm;
  const verifierLlm = deps.verifierLlm;
  const experimentTrace = Boolean(opts.fresh && opts.experimentTrace);
  let activeLlm = llm;
  let costUsd: number | null = 0;
  let reservedUsd = 0;
  let usedUsd = 0;
  const traceCalls: Array<{ stage: 'initial' | 'escalation' | 'verification'; provider: string; model: string; estimatedCostUsd: number; costUsd: number | null; outcome: 'success' | 'error' | 'validation_error'; failure?: string; pass: 'normal' | 'focused'; elapsedMs: number }> = [];
  const completeCall = async (req: CompleteRequest, provider: LLMProvider = activeLlm, alreadyReserved = false, pass: 'normal' | 'focused' = 'normal'): Promise<{ raw?: string; error?: unknown; failed: boolean; costUsd: number | null; traceIndex?: number }> => {
    const estimate = req.reviewBudget ? reviewCostUpperBound(req) : 0;
    const traceCall: (typeof traceCalls)[number] | undefined = req.reviewStage ? { stage: req.reviewStage, provider: provider.name, model: provider.model, estimatedCostUsd: estimate, costUsd: null, outcome: 'error', pass, elapsedMs: 0 } : undefined;
    if (traceCall) traceCalls.push(traceCall);
    const traceIndex = traceCall ? traceCalls.length - 1 : undefined;
    const started = Date.now();
    if (req.reviewBudget && !alreadyReserved && reservedUsd + estimate > REVIEW_MAX_USD) {
      if (traceCall) traceCall.elapsedMs = Math.max(0, Date.now() - started);
      throw new Error(`Review stage exceeds the remaining $0.50 budget; used $${usedUsd.toFixed(6)}, reserved $${reservedUsd.toFixed(6)}, next attempt $${estimate.toFixed(6)}; no review was published.`);
    }
    if (req.reviewBudget && !alreadyReserved) reservedUsd += estimate;
    const call = { reported: false, costUsd: 0 as number | null };
    let raw: string | undefined;
    let error: unknown;
    let threw = false;
    try {
      raw = await reviewCallCost.run(call, () => provider.complete(req));
    } catch (err) {
      threw = true;
      error = err;
    } finally {
      if (traceCall) traceCall.elapsedMs = Math.max(0, Date.now() - started);
      const next = costUsd !== null && call.reported && call.costUsd !== null ? costUsd + call.costUsd : null;
      costUsd = next !== null && Number.isFinite(next) ? next : null;
    }
    const validCost = call.reported && call.costUsd !== null && Number.isFinite(call.costUsd) && call.costUsd >= 0;
    if (req.reviewBudget && validCost) {
      usedUsd += call.costUsd!;
      reservedUsd += call.costUsd! - estimate;
    } else if (req.reviewBudget && threw && !call.reported && error instanceof ProviderError && error.status === 429) {
      reservedUsd -= estimate;
    }
    if (req.reviewBudget && reservedUsd > REVIEW_MAX_USD) {
      if (traceCall) traceCall.outcome = 'error';
      return { raw, error: new Error(`Review exceeds the $0.50 budget; used $${usedUsd.toFixed(6)}, reserved $${reservedUsd.toFixed(6)}; no review was published.`), failed: true, costUsd: validCost ? call.costUsd : null, traceIndex };
    }
    if (traceCall) {
      traceCall.costUsd = validCost ? call.costUsd : null;
      traceCall.outcome = threw ? 'error' : 'success';
    }
    return { raw, error: threw ? error : undefined, failed: threw, costUsd: validCost ? call.costUsd : null, traceIndex };
  };
  const markTraceValidation = (traceIndex: number | undefined, error: unknown) => {
    if (traceIndex === undefined) return;
    const trace = traceCalls[traceIndex];
    if (trace) { trace.outcome = 'validation_error'; trace.failure = errMessage(error); }
  };
  const completeStructured = async <T>(req: CompleteRequest, provider: LLMProvider, parse: (raw: string) => T, allowed: Array<{ path: string; lines: number[] }>, consumeRetryAllowance: () => boolean): Promise<T> => {
    const run = async (request: CompleteRequest) => {
      const call = await completeCall(request, provider);
      if (call.failed) {
        if (call.error instanceof JsonExtractError || call.error instanceof IncompleteResponseError) markTraceValidation(call.traceIndex, call.error);
        throw call.error;
      }
      try { return parse(call.raw!); }
      catch (err) { markTraceValidation(call.traceIndex, err); throw err; }
    };
    try {
      return await run(req);
    } catch (err) {
      if (!(err instanceof JsonExtractError || err instanceof IncompleteResponseError)) throw err;
      if (!consumeRetryAllowance()) throw err;
      return run(withCorrection(req, errMessage(err), allowed));
    }
  };
  const log = deps.log ?? (() => {});
  const identifiers = deps.identifiers ?? defaultIdentifiers;
  const formatContext = deps.formatContext ?? defaultFormatContext;
  const maxFiles = deps.maxFiles ?? 40;
  const post = opts.post ?? true;
  const failOn = deps.failOn ?? 'critical';
  const statusContext = (deps.statusContext ?? '').trim();

  const found = db.getRepo(opts.repoId);
  if (!found) throw new Error(`Unknown repo: ${opts.repoId}`);
  // Aliased so the type stays narrowed inside the nested runReview().
  const repo: RepoRow = found;

  const pr = await github.getPull(repo.owner, repo.name, opts.prNumber);
  const postCtx: PostContext = { db, github, llm, repo, pr, log, fresh: opts.fresh };

  const failureTrace = (): ReviewTrace | undefined => {
    if (!traceCalls.length) return undefined;
    const stages = (['initial', 'escalation', 'verification'] as const)
      .map((stage) => ({ stage, selectedPaths: [], hunks: [], omittedContext: 0, calls: traceCalls.filter((call) => call.stage === stage), findingCount: 0 }))
      .filter((stage) => stage.calls.length);
    return {
      version: 1,
      identity: { repoId: opts.repoId, prNumber: opts.prNumber, headSha: pr.headSha, baseSha: pr.baseSha, provider: activeLlm.name, model: activeLlm.model, config: { maxRetries: deps.maxRetries ?? 3, maxFiles: deps.maxFiles ?? 40 } },
      stages,
      finalFindings: [],
    };
  };

  // Commit statuses need a GitHub repository and a head commit to attach to.
  const statusEnabled = Boolean(statusContext) && (!opts.fresh || post) && opts.repoId.startsWith('github:') && Boolean(repo.owner && repo.name && pr.headSha);
  const dashboardUrl = deps.publicUrl ? `${deps.publicUrl.replace(/\/+$/, '')}/#/reviews/${opts.repoId}` : undefined;
  /** Reporting a status must never fail a review: failures become warnings. */
  const setStatus = async (status: ReviewStatus, targetUrl: string | undefined, warnings: string[]): Promise<void> => {
    if (!statusEnabled) return;
    try {
      await github.createCommitStatus(repo.owner, repo.name, pr.headSha, {
        state: status.state,
        context: statusContext,
        description: status.description,
        targetUrl: targetUrl || dashboardUrl,
      });
      log(`review: commit status ${status.state} on ${pr.headSha} (${statusContext})`);
    } catch (err) {
      const msg = `posting commit status failed: ${errMessage(err)}`;
      warnings.push(msg);
      log(`review: ${msg}`);
    }
  };

  const cached = opts.fresh || opts.force ? null : db.findReview(opts.repoId, opts.prNumber, pr.headSha);
  const statusWarnings: string[] = [];
  // A cached, already-posted review is not "in progress": go straight to its final state.
  if (!cached || cached.posted !== 1) {
    await setStatus({ state: 'pending', description: 'RepoLens review in progress' }, pr.htmlUrl, statusWarnings);
  }

  // Everything below the `pending` status runs inside this try: any escape without a
  // terminal status would leave a required check pending, blocking the PR forever.
  try {
    if (cached) {
      log(`review: reusing review #${cached.id} for ${opts.repoId}#${opts.prNumber} @ ${pr.headSha}`);
      let findings: Finding[] = [];
      try {
        const parsedFindings = JSON.parse(cached.comments_json) as unknown;
        if (Array.isArray(parsedFindings)) findings = parsedFindings as Finding[];
      } catch {
        findings = [];
      }
      findings = selectPostedFindings(await validateRepositoryRuleFindings(findings, github, repo, pr.baseSha, statusWarnings));
      const cachedResult: ReviewResult = {
        reviewId: cached.id,
        prNumber: cached.pr_number,
        headSha: cached.head_sha,
        summary: buildFindingSummary(findings),
        verdict: verdictForFindings(findings),
        findings,
        posted: cached.posted === 1,
        skippedFiles: [],
        warnings: statusWarnings,
        riskMetadata: [],
      };
      postCtx.llm = { name: cached.provider ?? 'unknown', model: cached.model ?? 'unknown' };
      if (post && cached.posted === 0) {
        // A previous run stored the review but failed (or was asked not) to post it.
        log(`review: cached review #${cached.id} was never posted; posting it now`);
        await postReview(postCtx, cachedResult);
      }
      const cachedStatus = statusForFindings(cachedResult.findings, failOn);
      await setStatus(cachedStatus, cachedResult.reviewUrl ?? pr.htmlUrl, cachedResult.warnings);
      if (statusEnabled) cachedResult.status = cachedStatus;
      return cachedResult;
    }

    const result = await runReview();
    const status = statusForFindings(result.findings, failOn);
    await setStatus(status, result.reviewUrl ?? pr.htmlUrl, result.warnings);
    if (statusEnabled) result.status = status;
    return result;
  } catch (err) {
    // A superseded review is not a failure; the stale sha's status is left as is
    // (nobody merges it) and the new head is reviewed by the trigger that moved it.
    if (err instanceof ReviewSupersededError) throw err;
    if (!(err instanceof Error)) {
      await setStatus(
        { state: 'error', description: truncateDescription(`RepoLens review failed: ${errMessage(err)}`) },
        pr.htmlUrl,
        statusWarnings,
      );
      throw err;
    }
    const failure = err instanceof ReviewExecutionError ? err : new ReviewExecutionError(errMessage(err), {
      headSha: pr.headSha,
      costUsd,
      trace: failureTrace(),
    });
    // The check must not stay pending forever when the review itself blows up.
    // Descriptions are capped at 140 characters, so a long message would make the
    // status call fail too and leave the check pending.
    await setStatus(
      { state: 'error', description: truncateDescription(`RepoLens review failed: ${failure.message}`) },
      pr.htmlUrl,
      statusWarnings,
    );
    throw failure;
  }

  async function runReview(): Promise<ReviewResult> {
    const diffText = await github.getPullDiff(repo.owner, repo.name, opts.prNumber);
    const parsed = parseUnifiedDiff(diffText);

    const warnings: string[] = [...statusWarnings];

    const lineage: Lineage = opts.fresh ? { reviewNumber: 1, commits: [], overview: '', warnings: [] } : await buildLineage(
      {
        previousReview: () => db.findLatestReview(opts.repoId, opts.prNumber),
        reviewCount: () => db.countPrReviews(opts.repoId, opts.prNumber),
        compareDiff: (base, head) => github.compareDiff(repo.owner, repo.name, base, head),
        listCommits: () => github.listPullCommits(repo.owner, repo.name, opts.prNumber),
        readFile: (path, ref) => github.getFileContent(repo.owner, repo.name, path, ref),
      },
      { baseSha: pr.baseSha, headSha: pr.headSha },
    );
    warnings.push(...lineage.warnings);
    postCtx.lineage = lineage;

    // Every path the PR touches. Index chunks for these are stale by construction,
    // so they are excluded from retrieval even when the file itself is not reviewed.
    const changedPaths: string[] = [];
    for (const f of parsed) {
      for (const path of [f.oldPath, f.newPath]) if (path && !changedPaths.includes(path)) changedPaths.push(path);
    }

    const skippedFiles: string[] = [];
    const reviewable: DiffFile[] = [];
    for (const f of parsed) {
      const path = f.newPath ?? f.oldPath;
      if (f.binary || !path || hasGeneratedHeader(f) || !isReviewablePath(path, deps.ignorePatterns)) {
        const label = path ?? f.oldPath ?? '(unknown)';
        skippedFiles.push(label);
        continue;
      }
      if (!f.hunks.length || f.hunks.every((h) => h.lines.length === 0)) {
        skippedFiles.push(path);
        continue;
      }
      const candidate = selectReviewCandidates(f);
      if (!candidate.file.hunks.length) {
        skippedFiles.push(path);
        continue;
      }
      reviewable.push(candidate.file);
    }

    const budgeted = llm.supportsBatchReview === true;
    // Read head files before final filtering so an unchanged generated header
    // outside the diff still suppresses the review.
    const headContents = new Map<string, string>();
    const headFetched = new Set<string>();
    const headerPaths = reviewable
      .filter((f) => f.status !== 'deleted' && !f.binary && f.newPath)
      .map((f) => f.newPath!);
    await mapPool(headerPaths, HEAD_FETCH_CONCURRENCY, async (path) => {
      headFetched.add(path);
      try {
        const content = await github.getFileContent(repo.owner, repo.name, path, pr.headSha);
        if (content === null) {
          log(`review: ${path}: no post-change content at ${shortSha(pr.headSha)}`);
        } else {
          headContents.set(path, content);
        }
      } catch (err) {
        warnings.push(`${path}: fetching post-change content failed: ${errMessage(err)}`);
      }
    });
    for (let i = reviewable.length - 1; i >= 0; i--) {
      const path = reviewable[i]!.newPath ?? reviewable[i]!.oldPath!;
      if (hasGeneratedContent(headContents.get(path) ?? '')) {
        skippedFiles.push(path);
        reviewable.splice(i, 1);
      }
    }
    // Never silently approve files that did not fit the configured review budget.
    if (reviewable.length > maxFiles) {
      throw new Error('Review exceeds the file limit; split this pull request before reviewing.');
    }
    const files = reviewable;
    let initialOmittedContext = 0;
    let escalationOmittedContext = 0;
    let verifierOmittedContext = 0;
    let primaryTrace: Finding[] = [];
    let escalationDecisionsTrace: Array<{ id: string | number; decision: string }> | undefined;
    let escalationFindingsTrace: Finding[] | undefined;
    let verifierDecisionsTrace: Array<{ id: string | number; decision: string }> | undefined;
    let verifierFocusedDecisionsTrace: Array<{ id: string | number; decision: string }> | undefined;
    let verifierFocusedSkipped: 'budget' | 'disabled' | undefined;
    let verifierSelectedPaths = new Set<string>();
    let verifierExecuted = false;
    let verifierFindingsTrace: Finding[] = [];
    let experimentVerificationCandidates: Array<{ id: number; rootCauseMarker: string; finding: Finding }> = [];
    let experimentVerificationDecisions: ReviewTraceDecision[] = [];
    let experimentFocusedDecisions: ReviewTraceDecision[] | undefined;
    const maxRetries = deps.maxRetries ?? 3;
    let retryAttemptsUsed = 0;
    let correctiveRetryUsed = false;
    const consumeRetryAllowance = (corrective = false): boolean => {
      if (retryAttemptsUsed >= maxRetries || corrective && correctiveRetryUsed) return false;
      retryAttemptsUsed++;
      if (corrective) correctiveRetryUsed = true;
      return true;
    };

    const historyPathSet = new Set<string>();
    for (const file of files) {
      for (const path of [file.oldPath, file.newPath]) if (path) historyPathSet.add(path);
    }
    const historyPaths = [...historyPathSet];
    const historical = await buildHistoricalContext(
      {
        listPathCommits: (path, ref) => github.listPathCommits(repo.owner, repo.name, path, ref),
        listCommitPulls: (sha) => github.listCommitPulls(repo.owner, repo.name, sha),
        findLatestReview: (number) => db.findLatestReview(opts.repoId, number),
      },
      {
        paths: historyPaths,
        baseSha: pr.baseSha,
        currentPrNumber: opts.prNumber,
        repository: `${repo.owner}/${repo.name}`,
      },
    );
    warnings.push(...historical.warnings);

    // Read applicable policy at the PR base so a head change cannot rewrite the
    // rules used to judge it. Keep the paths in the prompt as citations.
    const repositoryRules = new Map<string, string>();
    let rulesUsed = 0;
    const rulePaths = repositoryRulePaths(changedPaths);
    let ruleRequests = 0;
    for (const rulePath of rulePaths) {
      if (rulesUsed >= RULE_CHARS_MAX || ruleRequests >= RULE_REQUESTS_MAX || [...repositoryRules].length >= RULE_FILES_MAX) break;
      ruleRequests++;
      try {
        const content = await github.getFileContent(repo.owner, repo.name, rulePath, pr.baseSha);
        if (!content?.trim()) continue;
        const room = RULE_CHARS_MAX - rulesUsed;
        const clipped = content.length > room ? `${content.slice(0, room)}\n... (truncated)` : content;
        repositoryRules.set(rulePath, clipped);
        rulesUsed += clipped.length;
      } catch (err) {
        warnings.push(`rules: reading ${rulePath} at base failed: ${errMessage(err)}`);
      }
    }
    if (ruleRequests < rulePaths.length && ruleRequests >= RULE_REQUESTS_MAX) warnings.push(`rules: skipped ${rulePaths.length - ruleRequests} candidate paths after ${RULE_REQUESTS_MAX} requests.`);
    const rules = renderRepositoryRules(repositoryRules, pr.baseSha);

    const historyFor = (...paths: Array<string | null>): HistoricalPr[] => {
      const merged = new Map<number, HistoricalPr>();
      for (const path of paths) {
        if (!path) continue;
        for (const entry of historical.byPath.get(path) ?? []) {
          const current = merged.get(entry.number);
          if (!current) {
            merged.set(entry.number, entry);
            continue;
          }
          const findings = [...current.findings];
          for (const finding of entry.findings) {
            if (!findings.some((f) => f.path === finding.path && f.line === finding.line && f.title === finding.title)) findings.push(finding);
          }
          merged.set(entry.number, { ...current, findings });
        }
      }
      return [...merged.values()];
    };

    // Fetch the PR head once for the whole review: the search index only knows the
    // base branch, so without this the model judges new code against old exports.
    const fetchable = parsed
      .filter((f) => f.status !== 'deleted' && !f.binary && !hasGeneratedHeader(f) && f.newPath && isReviewablePath(f.newPath, deps.ignorePatterns) && !headFetched.has(f.newPath))
      .map((f) => f.newPath!);
    const toFetch = fetchable.slice(0, HEAD_FILES_MAX);
    if (fetchable.length > toFetch.length) {
      warnings.push(
        `Post-change content fetched for ${toFetch.length} of ${fetchable.length} changed files (limit ${HEAD_FILES_MAX}).`,
      );
    }
    await mapPool(toFetch, HEAD_FETCH_CONCURRENCY, async (path) => {
      try {
        const content = await github.getFileContent(repo.owner, repo.name, path, pr.headSha);
        if (content === null) {
          // Absence is not a failure (a path can be unreadable or gone at the head);
          // the file is simply reviewed without its post-change content.
          log(`review: ${path}: no post-change content at ${shortSha(pr.headSha)}`);
          return;
        }
        headContents.set(path, content);
      } catch (err) {
        const msg = `${path}: fetching post-change content failed: ${errMessage(err)}`;
        warnings.push(msg);
        log(`review: ${msg}`);
      }
    });

    const exportsByPath = buildExportIndex(headContents);
    const staticEvidence: StaticEvidenceFact[] = [...headContents].flatMap(([path, content]) => collectStaticEvidence(path, content));
    const verifierStaticEvidence = (candidateFindings: Finding[]): StaticEvidenceFact[] => {
      const candidatePaths = new Set(candidateFindings.map((finding) => finding.path));
      const relevant = staticEvidence.filter((fact) => candidatePaths.has(fact.path));
      const other = staticEvidence.filter((fact) => !candidatePaths.has(fact.path));
      return [...relevant, ...other].slice(0, STATIC_EVIDENCE_VERIFIER_MAX);
    };

    // Each file review is an expensive inference call: bail before it if the PR moved on.
    const assertHeadUnchanged = async () => {
      let sha: string | undefined;
      try {
        sha = (await github.getPull(repo.owner, repo.name, opts.prNumber)).headSha;
      } catch {
        return; // a flaky API call must not abort a review that could still be posted
      }
      if (sha && sha !== pr.headSha) throw new ReviewSupersededError(pr.headSha, sha);
    };

    const relevantContextByPath = new Map<string, string>();
    const relevantChunksByPath = new Map<string, RetrievedChunk[]>();
    const referencedHeadContents = new Map<string, string>();
    const referencedHeadContentsByVerifierPath = new Map<string, Map<string, string>>();
    const referencedHeadLinesByVerifierPath = new Map<string, Map<string, number[]>>();
    const referencedHeadFetched = new Set<string>();
    // The precision/recall arm uses two independent Qwen views and the
    // independent verifier; keep older staged/non-Qwen callers unchanged.
    const complementaryDiscovery = Boolean(deps.dualDiscovery) && budgeted && Boolean(verifierLlm) && !escalationLlm && /qwen/i.test(llm.model);
    let batch: { findings: Finding[] } | undefined;
    if (budgeted) {
      const req: CompleteRequest = {
        system: lineage.previous ? FOLLOWUP_BATCH_REVIEW_SYSTEM_PROMPT : BATCH_REVIEW_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify({
          prTitle: pr.title, prBody: pr.body, instructions: repo.instructions,
          overview: lineage.overview, commits: lineage.commits,
          previous: lineage.previous ? { ...lineage.previous, summary: undefined, delta: undefined } : undefined,
          files: files.map((f) => ({
            path: f.newPath ?? f.oldPath!, status: f.status, diff: hunkText(f, Infinity),
            allowedFindingLines: [...allowedFindingLines(f)].sort((a, b) => a - b),
            delta: lineage.previous ? deltaForFile(lineage.previous, f.newPath ?? f.oldPath!) : undefined,
          })),
        }) }],
        json: true, maxTokens: REVIEW_MAX_OUTPUT, reviewBudget: true, reviewStage: 'initial',
      };
      // Reject the core prompt before the retrieval loop or any inference call.
      const coreCost = reviewCostUpperBound(req);
      if (coreCost > REVIEW_MAX_USD) {
        throw new Error('Review exceeds the $0.50 budget; split this pull request into smaller reviews.');
      }
      // Reserve half the ceiling for one retry while keeping the full core diff.
      // The complementary system prompt is longer, so account for that fixed
      // overhead before splitting the cap between the two worst-case calls.
      const complementaryOverhead = complementaryDiscovery
        ? reviewCostUpperBound({ ...req, system: CONTRACT_CONCURRENCY_DISCOVERY_SYSTEM_PROMPT }) - coreCost
        : 0;
      const optionalContextBudget = complementaryDiscovery
        ? (REVIEW_MAX_USD - complementaryOverhead) / 2
        : maxRetries > 0 ? Math.max(coreCost, REVIEW_MAX_USD / 2) : REVIEW_MAX_USD;
      // Share each context block once across all files; changed code always gets
      // its full diff before optional context consumes any of the budget.
      let omitted = 0;
      const seenContext = new Set<string>();
      const addContext = (block: string) => {
        if (!block.trim() || seenContext.has(block)) return;
        seenContext.add(block);
        const previous = req.messages[0]!.content;
        req.messages[0]!.content += `\n\n${block}`;
        if (reviewCostUpperBound(req) > optionalContextBudget) {
          req.messages[0]!.content = previous;
          omitted++;
        }
      };
      for (const file of files) {
        const path = file.newPath ?? file.oldPath!;
        const added = file.hunks.flatMap((h) => h.lines.filter((l) => l.type === 'add').map((l) => l.content)).join('\n');
        const headContext = buildHeadContext({ path, addedText: added, relevantLines: headRelevantLines(file), headContents, exportsByPath });
        if (headContext) addContext(`Relevant post-change context for ${path} (authoritative):\n${headContext}`);
      }
      if (staticEvidence.length) addContext(`Advisory static evidence (bounded heuristics; not authoritative citations):\n${JSON.stringify(staticEvidence)}`);
      if (rules) addContext(rules);
      const batchHistory = historyFor(...historyPaths);
      if (batchHistory.length) addContext(renderHistoricalContext(batchHistory));
      const seen = new Set<number>();
      for (const file of files) {
        const path = file.newPath ?? file.oldPath!;
        const changedText = file.hunks.flatMap((h) => h.lines.filter((l) => l.type === 'add' || l.type === 'del').map((l) => l.content)).join('\n');
        try {
          const selected = await retrieveTargetedChunks(retrieve, opts.repoId, path, changedText, identifiers, changedPaths);
          relevantChunksByPath.set(path, selected);
          relevantContextByPath.set(path, formatContext(selected));
          for (const chunk of selected) {
            if (seen.has(chunk.chunkId)) continue;
            seen.add(chunk.chunkId);
            addContext(`Related code from the base-branch index:\n${formatContext([chunk])}`);
          }
        } catch (err) {
          warnings.push(`${path}: retrieval failed: ${errMessage(err)}`);
        }
      }
      if (omitted) warnings.push(`${omitted} optional context blocks omitted to keep the review within $0.50; all file diffs included.`);
      initialOmittedContext = omitted;
      const providers = [llm, ...(llm.reviewFallbacks ?? [])];
      if (providers.some((p) => !p.supportsBatchReview)) throw new Error('Review fallbacks must support budgeted batch reviews');
      let providerIndex = 0;
      let lastRetryError: unknown;
      let attemptReq = req;
      const allowedPathsAndLines = files.map((file) => ({ path: file.newPath ?? file.oldPath!, lines: [...allowedFindingLines(file)].sort((a, b) => a - b) }));
      const parseBatchResponse = (raw: string, providerName: string) => {
        const obj = extractJson(raw) as Record<string, unknown>;
        if (!obj || !Array.isArray(obj.findings) || typeof obj.summary !== 'string' || !obj.summary.trim() ||
            !toVerdict(obj.verdict) || !hasExactReviewedPaths(obj.reviewedPaths, files.map((f) => f.newPath ?? f.oldPath!)) ||
            obj.findings.some((f: unknown) => !f || typeof f !== 'object' || !files.some((file) => (file.newPath ?? file.oldPath) === (f as { path?: unknown }).path))) {
          throw new IncompleteResponseError(providerName, 'Incomplete review response; no review was published.');
        }
        let findings: Finding[];
        try {
          findings = files.flatMap((file) => parseFindings(JSON.stringify({
            findings: (obj.findings as Array<{ path?: string } | null>).filter((f) => f?.path === (file.newPath ?? file.oldPath)),
          }), file));
        } catch (err) {
          throw new IncompleteResponseError(providerName, errMessage(err));
        }
        return { findings };
      };
      if (complementaryDiscovery) {
        await assertHeadUnchanged();
        const complementaryReq: CompleteRequest = { ...req, system: CONTRACT_CONCURRENCY_DISCOVERY_SYSTEM_PROMPT };
        const combinedEstimate = reviewCostUpperBound(req) + reviewCostUpperBound(complementaryReq);
        if (combinedEstimate > REVIEW_MAX_USD) {
          throw new Error(`Combined discovery passes exceed the $0.50 review budget; estimated $${combinedEstimate.toFixed(6)}; no review was published.`);
        }
        // Reserve both worst-case calls before either provider starts.
        reservedUsd += combinedEstimate;
        const [localCall, contractCall] = await Promise.all([
          completeCall(req, activeLlm, true),
          completeCall(complementaryReq, llm, true),
        ]);
        if (localCall.failed) throw localCall.error;
        if (contractCall.failed) throw contractCall.error;
        let local: { findings: Finding[] };
        let contract: { findings: Finding[] };
        try { local = parseBatchResponse(localCall.raw!, activeLlm.name); }
        catch (err) { markTraceValidation(localCall.traceIndex, err); throw err; }
        try { contract = parseBatchResponse(contractCall.raw!, llm.name); }
        catch (err) { markTraceValidation(contractCall.traceIndex, err); throw err; }
        const findings = [...local.findings, ...contract.findings]
          .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.path.localeCompare(b.path) || a.line - b.line);
        batch = { findings };
      } else for (let attempt = 0; ; attempt++) {
        await assertHeadUnchanged();
        let traceIndex: number | undefined;
        try {
          const call = await completeCall(attemptReq);
          traceIndex = call.traceIndex;
          if (call.failed) throw call.error;
          batch = parseBatchResponse(call.raw!, activeLlm.name);
          break;
        } catch (err) {
          const malformed = err instanceof JsonExtractError || err instanceof IncompleteResponseError;
          if (malformed) {
            markTraceValidation(traceIndex, err);
            if (!consumeRetryAllowance(true)) throw err;
            attemptReq = withCorrection(req, errMessage(err), allowedPathsAndLines);
            const previous = activeLlm.model;
            activeLlm = providers[Math.min(++providerIndex, providers.length - 1)]!;
            const message = `${previous}: ${errMessage(err)}; corrective retry with ${activeLlm.model}`;
            warnings.push(message);
            log(`review: ${message}`);
            continue;
          }
          const retryable = err instanceof JsonExtractError || err instanceof IncompleteResponseError ||
            err instanceof NetworkProviderError || err instanceof ProviderError && (err.status === 408 || err.status === 429 || (err.status ?? 0) >= 500);
          if (correctiveRetryUsed) throw err;
          if (!retryable || !consumeRetryAllowance()) {
            if (lastRetryError && /budget/i.test(errMessage(err))) {
              throw new Error(`${errMessage(err)} Last retry error: ${errMessage(lastRetryError)}.`);
            }
            throw err;
          }
          lastRetryError = err;
          attemptReq = req;
          const previous = activeLlm.model;
          activeLlm = providers[Math.min(++providerIndex, providers.length - 1)]!;
          const message = `${previous}: ${errMessage(err)}; retry ${retryAttemptsUsed}/${maxRetries} with ${activeLlm.model}`;
          warnings.push(message);
          log(`review: ${message}`);
          if (err instanceof ProviderError && err.status === 429) {
            await (deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(
              Math.min(60_000, 15_000 * 2 ** (retryAttemptsUsed - 1)),
            );
          }
        }
      }
    }

    const perFile = batch ? [batch.findings] : await mapPool(files, llm.concurrency, async (file) => {
      const path = file.newPath ?? file.oldPath!;
      const changedText = file.hunks
        .flatMap((h) => h.lines.filter((l) => l.type === 'add' || l.type === 'del').map((l) => l.content))
        .join('\n');
      const headContext = buildHeadContext({ path, addedText: changedText, relevantLines: headRelevantLines(file), headContents, exportsByPath });
      let context = '';
      try {
        // Excluding every changed path keeps pre-change chunks of this PR's files
        // out of the prompt; their post-change content is in `headContext` instead.
        const selected = await retrieveTargetedChunks(retrieve, opts.repoId, path, changedText, identifiers, changedPaths);
        relevantChunksByPath.set(path, selected);
        context = formatContext(selected);
        relevantContextByPath.set(path, context);
      } catch (err) {
        warnings.push(`${path}: retrieval failed: ${errMessage(err)}`);
      }
      await assertHeadUnchanged();
      try {
        const call = await completeCall({
          system: FILE_REVIEW_SYSTEM_PROMPT,
          messages: [
            {
              role: 'user',
              content: buildFileReviewMessage({
                prTitle: pr.title,
                prBody: pr.body,
                path,
                status: file.status,
                hunkText: hunkText(file),
                headContext,
                context,
                instructions: repo.instructions,
                rules,
                staticEvidence: staticEvidence.filter((fact) => fact.path === path),
                lineage,
                delta: lineage.previous ? deltaForFile(lineage.previous, path) : undefined,
                historical: historyFor(file.oldPath, file.newPath),
              }),
            },
          ],
          json: true,
          maxTokens: 2000,
          reviewStage: 'initial',
        });
        if (call.failed) {
          if (call.error instanceof JsonExtractError || call.error instanceof IncompleteResponseError) markTraceValidation(call.traceIndex, call.error);
          throw call.error;
        }
        try {
          return parseFindings(call.raw!, file);
        } catch (err) {
          markTraceValidation(call.traceIndex, err);
          throw err;
        }
      } catch (err) {
        const msg = `${path}: ${errMessage(err)}`;
        warnings.push(msg);
        log(`review: ${msg}`);
        throw new Error(`file review failed for ${path}: ${errMessage(err)}`);
      }
    });

    let findings = perFile.flat().sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.path.localeCompare(b.path) || a.line - b.line);
    primaryTrace = findings.slice();
    const riskyFiles = files.flatMap((file) => {
      const hunks = file.hunks.filter((_, index) => {
        const risk = assessChange({ ...file, hunks: [file.hunks[index]!] });
        return risk.score >= 4 || risk.signals.includes('security');
      });
      return hunks.length ? [{ ...file, hunks }] : [];
    });
    const buildVerifierFiles = (candidateFindings: Finding[], trimOptionalContext: boolean) => {
      const seenContext = new Set<string>();
      return files.flatMap((file) => {
        const path = file.newPath ?? file.oldPath!;
        const lines = candidateFindings.filter((finding) => finding.path === path).map(findingLine);
        const hunks = file.hunks.filter((_, index) => lines.some((line) => hunkContainsLine(file, index, line)));
        if (!hunks.length) return [];
        const scopedReferencedHeadContents = referencedHeadContentsByVerifierPath.get(path);
        const scopedReferencedHeadLines = referencedHeadLinesByVerifierPath.get(path);
        const headEvidence = buildHeadEvidence({
          path, addedText: hunkText({ ...file, hunks }, Infinity),
          relevantLines: [...headRelevantLines(file, hunks), ...lines], headContents,
          referencedHeadContents: scopedReferencedHeadContents, referencedHeadLines: scopedReferencedHeadLines, exportsByPath,
        });
        const context = relevantContextByPath.get(path);
        const packedContext = context && !seenContext.has(context) ? (seenContext.add(context), context) : undefined;
        return [{
          path, status: file.status, diff: hunkText({ ...file, hunks }, Infinity),
          currentEvidence: hunks.flatMap((hunk) => hunk.lines.flatMap((line) => line.type === 'del' || line.newLine === undefined ? [] : [{
            line: line.newLine, kind: line.type === 'add' ? 'added' : 'context', content: line.content,
          }])),
          removedEvidence: hunks.flatMap((hunk) => hunk.lines.flatMap((line) => line.type !== 'del' || line.oldLine === undefined ? [] : [{
            line: line.oldLine, kind: 'removed', content: line.content,
          }])),
          headEvidence: trimOptionalContext ? headEvidence.filter((snippet) => snippet.path === path) : headEvidence,
          ...(!trimOptionalContext && packedContext ? { relevantContext: packedContext } : {}),
        }];
      });
    };
    const verifierRequest = (candidateFindings: Finding[], trimOptionalContext = false, system = VERIFIER_SYSTEM_PROMPT, candidateIds?: number[]): CompleteRequest => ({
      system,
      messages: [{ role: 'user', content: JSON.stringify({
        rules, files: buildVerifierFiles(candidateFindings, trimOptionalContext),
        ...(!trimOptionalContext && staticEvidence.length ? { staticEvidence: verifierStaticEvidence(candidateFindings) } : {}),
        findings: candidateFindings.map((finding, id) => ({ id: candidateIds?.[id] ?? id, finding })),
      }) }],
      json: true, maxTokens: 4000, reviewBudget: budgeted, reviewStage: 'verification',
    });
    if (escalationLlm && riskyFiles.length) {
      await assertHeadUnchanged();
      const paths = riskyFiles.map((file) => file.newPath ?? file.oldPath!);
      const seenEscalationContext = new Set<string>();
      const packEscalationContext = (context: string) => {
        if (!context.trim() || seenEscalationContext.has(context)) return undefined;
        seenEscalationContext.add(context);
        return context;
      };
      const escalationPayload: {
        prTitle: string;
        prBody: string;
        files: Array<{
          path: string;
          status: string;
          risk: ChangeRisk;
          diff: string;
          allowedFindingLines: number[];
          headContext?: string;
          relevantContext?: string;
          historical?: string;
        }>;
        rules?: string;
        provisionalFindings: Array<{ id: string; finding: Finding }>;
      } = {
        prTitle: pr.title,
        prBody: pr.body,
        files: riskyFiles.map((file) => {
          const path = file.newPath ?? file.oldPath!;
          const headContext = buildHeadContext({ path, addedText: hunkText(file, Infinity), relevantLines: headRelevantLines(file), headContents, exportsByPath });
          const relevantContext = packEscalationContext(relevantContextByPath.get(path) ?? '');
          const historical = packEscalationContext(renderHistoricalContext(historyFor(file.oldPath, file.newPath)));
          return {
            path, status: file.status, risk: assessChange(file), diff: hunkText(file, Infinity),
            allowedFindingLines: [...allowedFindingLines(file)].sort((a, b) => a - b),
            ...(headContext ? { headContext } : {}),
            ...(relevantContext ? { relevantContext } : {}),
            ...(historical ? { historical } : {}),
          };
        }),
        ...(rules ? { rules } : {}),
        provisionalFindings: [],
      };
      const primaryFindings = findings.filter((finding) => riskyFiles.some((file) =>
        (file.newPath ?? file.oldPath) === finding.path && allowedFindingLines(file).has(findingLine(finding))));
      const primaryIds = primaryFindingIds(primaryFindings);
      const primaryById = new Map(primaryIds.map((id, index) => [id, primaryFindings[index]!]));
      escalationPayload.provisionalFindings = primaryFindings.map((finding, index) => ({ id: primaryIds[index]!, finding }));
      const escalationRequest = () => ({
        system: ESCALATION_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify(escalationPayload) }],
        json: true, jsonSchema: buildEscalationJsonSchema(paths, primaryIds), maxTokens: REVIEW_ESCALATION_MAX_OUTPUT,
        reviewBudget: budgeted, reviewStage: 'escalation',
      } satisfies CompleteRequest);
      const verifierReserve = budgeted && verifierLlm ? (() => {
        const full = verifierRequest(findings);
        const trimmed = verifierRequest(findings, true);
        // ponytail: reserve four UTF-8 bytes per possible escalation output token;
        // replace with provider tokenization if added-finding payloads need tighter packing.
        full.messages[0]!.content += `\n${' '.repeat(REVIEW_ESCALATION_MAX_OUTPUT * 4)}`;
        trimmed.messages[0]!.content += `\n${' '.repeat(REVIEW_ESCALATION_MAX_OUTPUT * 4)}`;
        const reserve = reviewCostUpperBound(full) <= REVIEW_MAX_USD - reservedUsd ? full : trimmed;
        return reviewCostUpperBound(reserve);
      })() : 0;
      const remaining = budgeted ? REVIEW_MAX_USD - reservedUsd - verifierReserve : Number.POSITIVE_INFINITY;
      const optionalFields: Array<'relevantContext' | 'historical' | 'headContext' | 'rules'> = ['relevantContext', 'historical', 'headContext', 'rules'];
      let omitted = 0;
      let req = escalationRequest();
      while (reviewCostUpperBound(req) > remaining && optionalFields.length) {
        const field = optionalFields.shift()!;
        if (field === 'rules') delete escalationPayload.rules;
        else for (const file of escalationPayload.files) delete file[field];
        omitted++;
        req = escalationRequest();
      }
      const escalationEstimate = reviewCostUpperBound(req);
      if (escalationEstimate > remaining) {
        throw new Error(`Escalation core exceeds the remaining $0.50 review budget; reserved $${reservedUsd.toFixed(6)}, verifier reserve $${verifierReserve.toFixed(6)}, core $${escalationEstimate.toFixed(6)}; no review was published.`);
      }
      if (omitted) warnings.push(`Escalation omitted ${omitted} optional context block${omitted === 1 ? '' : 's'} to stay within the remaining review budget; risky diff hunks were preserved.`);
      escalationOmittedContext = omitted;
      const parseEscalation = (raw: string) => {
        const obj = extractJson(raw) as Record<string, unknown>;
        if (!obj || !hasExactReviewedPaths(obj.reviewedPaths, paths)) {
          throw new IncompleteResponseError(escalationLlm.name, 'Invalid escalation response: reviewedPaths must contain exactly every selected path; no review was published.');
        }
        const decisions = Array.isArray(obj.decisions) ? obj.decisions as Array<Record<string, unknown>> : [];
        const decisionIds = decisions.map((decision) => decision && typeof decision === 'object' && !Array.isArray(decision) ? decision.id : undefined);
        if (decisions.some((decision) => !decision || typeof decision !== 'object' || Array.isArray(decision) ||
            Object.keys(decision).some((key) => key !== 'id' && key !== 'decision')) ||
            decisions.length !== primaryIds.length || new Set(decisionIds).size !== primaryIds.length ||
            decisionIds.some((id) => typeof id !== 'string' || !primaryById.has(id)) ||
            decisions.some((decision) => !['retain', 'reject', 'uncertain'].includes(String(decision.decision)))) {
          throw new IncompleteResponseError(escalationLlm.name, 'Invalid escalation response: decisions must contain exactly one retain, reject, or uncertain decision for every primary finding; no review was published.');
        }
        if (!Array.isArray(obj.findings) || obj.findings.some((finding: unknown) =>
          !finding || typeof finding !== 'object' || Array.isArray(finding) ||
          !paths.includes((finding as { path?: string }).path ?? ''))) {
          throw new IncompleteResponseError(escalationLlm.name, 'Invalid escalation response: findings must be objects whose path is one of the selected paths; no review was published.');
        }
        let escalated: Finding[];
        try {
          escalated = riskyFiles.flatMap((file) => parseFindings(JSON.stringify({
            findings: (obj.findings as Array<{ path?: string }>).filter((finding) => finding.path === (file.newPath ?? file.oldPath)),
          }), file));
        } catch (err) {
          throw new IncompleteResponseError(escalationLlm.name, `Invalid escalation response: ${errMessage(err)}`);
        }
        return { decisions, escalated };
      };
      const escalationResult = await completeStructured(req, escalationLlm, parseEscalation,
        riskyFiles.map((file) => ({ path: file.newPath ?? file.oldPath!, lines: [...allowedFindingLines(file)].sort((a, b) => a - b) })),
        () => consumeRetryAllowance(true));
      const { decisions, escalated } = escalationResult;
      escalationDecisionsTrace = decisions.map((decision) => ({ id: decision.id as string, decision: String(decision.decision) }));
      escalationFindingsTrace = escalated.slice();
      const rejected = new Set(decisions.filter((decision) => decision.decision === 'reject').map((decision) => primaryById.get(decision.id as string)));
      findings = findings.filter((finding) => !rejected.has(finding));
      findings.push(...escalated.filter((finding) => ![...rejected].some((primary) => primary &&
        primary.path === finding.path && findingLine(primary) === findingLine(finding) && rootCauseMarker(primary) === rootCauseMarker(finding))));
    }

    findings = deduplicateProvisionalCandidates(findings);
    findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.path.localeCompare(b.path) || a.line - b.line);
    findings = await validateRepositoryRuleFindings(findings, github, repo, pr.baseSha, warnings);
    if (verifierLlm && findings.length) {
      await assertHeadUnchanged();
      // The initial retrieval only knows the diff. Refresh each finding's
      // context with its implicated identifiers/callees before verification.
      for (const path of new Set(findings.map((finding) => finding.path))) {
        const file = files.find((candidate) => (candidate.newPath ?? candidate.oldPath) === path);
        if (!file) continue;
        const changedText = file.hunks.flatMap((hunk) => hunk.lines
          .filter((line) => line.type === 'add' || line.type === 'del')
          .map((line) => line.content)).join('\n');
        const focusText = findings.filter((finding) => finding.path === path).map((finding) => [
          finding.title, finding.body, finding.rootCause, finding.evidence?.trigger, finding.evidence?.consequence,
        ].filter(Boolean).join(' ')).join('\n');
        try {
          const focused = await retrieveTargetedChunks(retrieve, opts.repoId, path, changedText, identifiers, changedPaths, focusText);
          if (focused.length) {
            const merged = mergeRelevantChunks(relevantChunksByPath.get(path) ?? [], focused);
            relevantChunksByPath.set(path, merged);
            relevantContextByPath.set(path, formatContext(merged));
            const scopedContents = referencedHeadContentsByVerifierPath.get(path) ?? new Map<string, string>();
            const scopedLines = referencedHeadLinesByVerifierPath.get(path) ?? new Map<string, number[]>();
            for (const chunk of focused) {
              if (changedPaths.includes(chunk.path)) continue;
              if (!referencedHeadFetched.has(chunk.path)) {
                if (referencedHeadFetched.size >= REFERENCED_HEAD_FILES_MAX) break;
                referencedHeadFetched.add(chunk.path);
                try {
                  const content = await github.getFileContent(repo.owner, repo.name, chunk.path, pr.headSha);
                  if (content !== null) {
                    referencedHeadContents.set(chunk.path, content);
                  }
                } catch (err) {
                  warnings.push(`${chunk.path}: fetching referenced head content failed: ${errMessage(err)}`);
                }
              }
              const content = referencedHeadContents.get(chunk.path);
              if (content !== undefined) {
                scopedContents.set(chunk.path, content);
                scopedLines.set(chunk.path, [...new Set([...(scopedLines.get(chunk.path) ?? []), chunk.startLine, chunk.endLine])]);
              }
            }
            referencedHeadContentsByVerifierPath.set(path, scopedContents);
            referencedHeadLinesByVerifierPath.set(path, scopedLines);
          }
        } catch (err) {
          warnings.push(`${path}: finding retrieval failed: ${errMessage(err)}`);
        }
      }
      await assertHeadUnchanged();
      const fullVerifierReq = verifierRequest(findings);
      const verifierReq = !budgeted || reviewCostUpperBound(fullVerifierReq) <= REVIEW_MAX_USD - reservedUsd
        ? fullVerifierReq : verifierRequest(findings, true);
      verifierOmittedContext = verifierReq === fullVerifierReq ? 0 : 1;
      const verifierPayload = JSON.parse(verifierReq.messages[0]!.content) as { files: VerifierContextFile[] };
      const verifierFiles = verifierPayload.files;
      verifierSelectedPaths = new Set(verifierFiles.map((file) => file.path));
      const allowedByPath = new Map<string, Set<number>>();
      for (const file of verifierFiles) for (const citation of verifierCitationLines(file)) {
        const split = citation.lastIndexOf(':');
        if (split <= 0) continue;
        const citationPath = citation.slice(0, split);
        const line = Number(citation.slice(split + 1));
        if (!Number.isInteger(line) || line <= 0) continue;
        const lines = allowedByPath.get(citationPath) ?? new Set<number>();
        lines.add(line);
        allowedByPath.set(citationPath, lines);
      }
      const allowedVerifierLines = [...allowedByPath].map(([path, lines]) => ({ path, lines: [...lines].sort((a, b) => a - b) }));
      verifierExecuted = true;
      verifierFindingsTrace = findings.slice();
      if (experimentTrace) {
        experimentVerificationCandidates = findings.map((finding, id) => ({ id, rootCauseMarker: rootCauseMarker(finding), finding }));
      }
      const parseVerification = (raw: string) => {
        const obj = extractJson(raw) as Record<string, unknown>;
        const decisions = Array.isArray(obj?.decisions) ? obj.decisions as Array<Record<string, unknown>> : [];
        const ids = decisions.map((decision) => decision && typeof decision === 'object' && !Array.isArray(decision) ? decision.id : undefined);
        if (decisions.some((decision) => !decision || typeof decision !== 'object' || Array.isArray(decision)) ||
            decisions.length !== findings.length || new Set(ids).size !== findings.length ||
            ids.some((id) => !Number.isInteger(id) || (id as number) < 0 || (id as number) >= findings.length) ||
            decisions.some((decision) => !['supported', 'contradicted', 'uncertain'].includes(String(decision.decision)) ||
              typeof decision.explanation !== 'string' || !decision.explanation.trim() ||
              (decision.decision === 'supported' || decision.decision === 'contradicted') && !hasValidVerifierCitation(decision, verifierFiles))) {
          throw new IncompleteResponseError(verifierLlm.name, 'Invalid verification response; no review was published.');
        }
        return decisions;
      };
      const decisions = await completeStructured(verifierReq, verifierLlm, parseVerification, allowedVerifierLines,
        () => consumeRetryAllowance(true));
      if (experimentTrace) {
        experimentVerificationDecisions = decisions.map((decision) => ({
          id: decision.id as number, decision: String(decision.decision), explanation: String(decision.explanation),
          ...(decision.evidence !== undefined ? { evidence: decision.evidence } : {}),
        }));
      }
      const supported = new Set(decisions.filter((decision) => decision.decision === 'supported').map((decision) => decision.id as number));
      const uncertainCandidates = decisions.filter((decision) => decision.decision === 'uncertain')
        .map((decision) => ({ id: decision.id as number, finding: findings[decision.id as number] }))
        .filter((candidate): candidate is { id: number; finding: Finding } => Boolean(candidate.finding));
      const uncertainFindings = uncertainCandidates.map(({ finding }) => finding);
      verifierDecisionsTrace = decisions.map((decision) => ({ id: decision.id as number, decision: String(decision.decision) }));
      findings = findings.filter((finding, id) => supported.has(id) && finding.confidence === 'high' && finding.severity !== 'nit');

      if (uncertainFindings.length && !deps.focusedVerification) {
        verifierFocusedSkipped = 'disabled';
      } else if (uncertainFindings.length) {
        const focusedSystem = focusedVerifierSystemPrompt();
        const uncertainIds = uncertainCandidates.map(({ id }) => id);
        const fullFocusedReq = verifierRequest(uncertainFindings, false, focusedSystem, uncertainIds);
        const trimmedFocusedReq = verifierRequest(uncertainFindings, true, focusedSystem, uncertainIds);
        const remaining = REVIEW_MAX_USD - reservedUsd;
        const focusedReq = !budgeted || reviewCostUpperBound(fullFocusedReq) <= remaining
          ? fullFocusedReq : trimmedFocusedReq;
        if (budgeted && reviewCostUpperBound(focusedReq) > remaining) {
          verifierFocusedSkipped = 'budget';
        } else {
          await assertHeadUnchanged();
          const focusedPayload = JSON.parse(focusedReq.messages[0]!.content) as { files: VerifierContextFile[] };
          const focusedFiles = focusedPayload.files;
          const focusedCall = await completeCall(focusedReq, verifierLlm, false, 'focused');
          if (focusedCall.failed) {
            if (focusedCall.error instanceof JsonExtractError || focusedCall.error instanceof IncompleteResponseError) markTraceValidation(focusedCall.traceIndex, focusedCall.error);
            throw focusedCall.error;
          }
          let focusedDecisions: Array<Record<string, unknown>>;
          try {
            const focusedObj = extractJson(focusedCall.raw!) as Record<string, unknown>;
            focusedDecisions = Array.isArray(focusedObj?.decisions) ? focusedObj.decisions as Array<Record<string, unknown>> : [];
            const focusedIds = focusedDecisions.map((decision) => decision && typeof decision === 'object' && !Array.isArray(decision) ? decision.id : undefined);
            if (focusedDecisions.some((decision) => !decision || typeof decision !== 'object' || Array.isArray(decision)) ||
                focusedDecisions.length !== uncertainIds.length || new Set(focusedIds).size !== uncertainIds.length ||
                focusedIds.some((id) => !Number.isInteger(id) || !uncertainIds.includes(id as number)) ||
                focusedDecisions.some((decision) => !['supported', 'contradicted'].includes(String(decision.decision)) ||
                  typeof decision.explanation !== 'string' || !decision.explanation.trim() || !hasValidVerifierCitation(decision, focusedFiles))) {
              throw new IncompleteResponseError(verifierLlm.name, 'Invalid focused verification response; no review was published.');
            }
          } catch (err) {
            markTraceValidation(focusedCall.traceIndex, err);
            throw err;
          }
          verifierFocusedDecisionsTrace = focusedDecisions.map((decision) => ({ id: decision.id as number, decision: String(decision.decision) }));
          if (experimentTrace) {
            experimentFocusedDecisions = focusedDecisions.map((decision) => ({
              id: decision.id as number, decision: String(decision.decision), explanation: String(decision.explanation),
              ...(decision.evidence !== undefined ? { evidence: decision.evidence } : {}),
            }));
          }
          const focusedSupported = new Set(focusedDecisions.filter((decision) => decision.decision === 'supported').map((decision) => decision.id as number));
          findings.push(...uncertainCandidates.filter(({ id, finding }) => focusedSupported.has(id) && finding.confidence === 'high' && finding.severity !== 'nit').map(({ finding }) => finding));
        }
      }
    }
    findings = selectPostedFindings(findings);

    const experiment = experimentTrace ? {
      discovery: [...primaryTrace, ...(escalationFindingsTrace ?? [])],
      verificationCandidates: experimentVerificationCandidates,
      verificationDecisions: experimentVerificationDecisions,
      ...(experimentFocusedDecisions ? { focusedDecisions: experimentFocusedDecisions } : {}),
      publishedFindings: findings.map((finding) => ({
        id: experimentVerificationCandidates.find((candidate) => provisionalCandidateKey(candidate.finding) === provisionalCandidateKey(finding))?.id ?? null,
        rootCauseMarker: rootCauseMarker(finding), finding,
      })),
    } : undefined;

    await assertHeadUnchanged();
    const summary = buildFindingSummary(findings);
    const verdict = verdictForFindings(findings);
    const traceStage = (stage: 'initial' | 'escalation' | 'verification' | 'final', selected: DiffFile[], omittedContext: number, extra: { primaryFindings?: Finding[]; decisions?: Array<{ id: string | number; decision: string }>; focusedDecisions?: Array<{ id: string | number; decision: string }>; focusedSkipped?: 'budget' | 'disabled'; findings?: Finding[] } = {}) => ({
      stage,
      selectedPaths: selected.map((file) => file.newPath ?? file.oldPath ?? ''),
      hunks: traceHunks(selected),
      omittedContext,
      calls: traceCalls.filter((call) => call.stage === stage),
      findingCount: extra.findings?.length ?? extra.primaryFindings?.length ?? 0,
      ...(extra.primaryFindings ? { primaryFindings: extra.primaryFindings.map(traceFinding) } : {}),
      ...(extra.decisions ? { decisions: extra.decisions } : {}),
      ...(extra.focusedDecisions ? { focusedDecisions: extra.focusedDecisions } : {}),
      ...(extra.focusedSkipped ? { focusedSkipped: extra.focusedSkipped } : {}),
      ...(extra.findings ? { findings: extra.findings.map(traceFinding) } : {}),
    });
    const trace: ReviewTrace = {
      version: 1,
      identity: { repoId: opts.repoId, prNumber: opts.prNumber, headSha: pr.headSha, baseSha: pr.baseSha, provider: activeLlm.name, model: activeLlm.model, config: { maxRetries, maxFiles } },
      stages: [
        traceStage('initial', files, initialOmittedContext, { primaryFindings: primaryTrace }),
        ...(escalationLlm && riskyFiles.length ? [traceStage('escalation', riskyFiles, escalationOmittedContext, { primaryFindings: primaryTrace.filter((finding) => riskyFiles.some((file) => (file.newPath ?? file.oldPath) === finding.path)), decisions: escalationDecisionsTrace, findings: escalationFindingsTrace })] : []),
        ...(verifierExecuted ? [traceStage('verification', files.filter((file) => verifierSelectedPaths.has(file.newPath ?? file.oldPath ?? '')), verifierOmittedContext, { decisions: verifierDecisionsTrace, focusedDecisions: verifierFocusedDecisionsTrace, focusedSkipped: verifierFocusedSkipped, findings: verifierFindingsTrace })] : []),
        traceStage('final', files, 0, { findings: findings.slice() }),
      ],
      finalFindings: findings.map(traceFinding),
      ...(experiment ? { experiment } : {}),
    };

    if (!repo.last_commit) {
      warnings.push('Repository has not been indexed; review ran without codebase context.');
    }

    const row = db.insertReview({
      repo_id: opts.repoId,
      pr_number: opts.prNumber,
      head_sha: pr.headSha,
      status: 'done',
      cost_usd: costUsd,
      provider: activeLlm.name,
      model: activeLlm.model,
      summary,
      verdict,
      comments_json: JSON.stringify(findings),
      posted: 0,
      error: null,
    });

    const result: ReviewResult = {
      reviewId: row.id,
      prNumber: opts.prNumber,
      headSha: pr.headSha,
      summary,
      verdict,
      findings,
      posted: false,
      skippedFiles,
      warnings,
      riskMetadata: files.map((file) => ({ path: file.newPath ?? file.oldPath!, risk: assessChange(file) })),
      trace,
    };

    postCtx.llm = activeLlm;
    if (post) await postReview(postCtx, result);

    return result;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
