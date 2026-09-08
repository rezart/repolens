import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type Db } from '../../src/db.js';
import { NetworkProviderError, ProviderError, type CompleteRequest, type LLMProvider } from '../../src/llm/types.js';
import type { RetrieveFn, RetrievedChunk } from '../../src/search/types.js';
import type {
  PullRequest,
  CreateReviewInput,
  ExistingReviewComment,
  CommitStatusInput,
  PathCommit,
  HistoricalPullRequest,
} from '../../src/review/github.js';
import { FILE_REVIEW_SYSTEM_PROMPT, BATCH_REVIEW_SYSTEM_PROMPT, SUMMARY_SYSTEM_PROMPT, FOLLOWUP_BATCH_REVIEW_SYSTEM_PROMPT, FOLLOWUP_SUMMARY_SYSTEM_PROMPT, ESCALATION_SYSTEM_PROMPT, VERIFIER_SYSTEM_PROMPT } from '../../src/review/prompts.js';
import { reviewCostUpperBound, REVIEW_ESCALATION_MAX_OUTPUT, REVIEW_MAX_OUTPUT, REVIEW_MAX_USD } from '../../src/review/budget.js';
import { UsageTracker } from '../../src/usage/tracker.js';
import { OpenRouterProvider } from '../../src/llm/openrouter.js';
import { JobQueue } from '../../src/jobs.js';
import { hunkText, parseUnifiedDiff } from '../../src/review/diff.js';
import {
  reviewPullRequest as runReviewPullRequest,
  ReviewExecutionError,
  ReviewSupersededError,
  isReviewablePath,
  hasGeneratedHeader,
  buildReviewBody,
  defaultIdentifiers,
  defaultFormatContext,
  contextQuery,
  buildHeadContext,
  hasValidVerifierCitation,
  selectRelevantChunks,
  repositoryRulePaths,
  renderRepositoryRules,
  statusForFindings,
  selectPostedFindings,
  parseFindings,
  type ReviewDeps,
  type Finding,
} from '../../src/review/reviewer.js';

describe('review finding posting', () => {
  it('keeps one representative per root cause and folds related locations into the strongest comment', () => {
    const finding = (path: string, line: number, severity: Finding['severity'], rootCause: string): Finding => ({
      path, line, severity, title: `${rootCause} at ${path}`, body: 'Fix it.', rootCause,
      category: 'correctness', confidence: 'high', evidence: { path, line, trigger: 'input', consequence: 'failure' },
    });
    const selected = selectPostedFindings([
      finding('a.ts', 1, 'warning', 'shared'), finding('b.ts', 2, 'critical', 'shared'),
      finding('c.ts', 3, 'warning', 'second'), finding('d.ts', 4, 'nit', 'third'), finding('e.ts', 5, 'warning', 'fourth'),
    ]);
    expect(selected).toHaveLength(4);
    expect(selected[0]).toMatchObject({ path: 'b.ts', line: 2, rootCause: 'shared' });
    expect(selected[0]!.body).toContain('Related locations: a.ts:1');
    expect(selected.map((f) => f.rootCause)).toEqual(['shared', 'second', 'fourth', 'third']);
  });

  it('suppresses test gaps but keeps real findings in test files', () => {
    const finding = (category: Finding['category'], title: string): Finding => ({
      path: 'tests/app.test.ts', line: 4, severity: 'warning', title, body: 'Details.', rootCause: title,
      category, confidence: 'high', evidence: { path: 'tests/app.test.ts', line: 4, trigger: 'input', consequence: 'failure' },
    });
    expect(selectPostedFindings([
      finding('test_gap', 'Missing coverage'), finding('correctness', 'Test crashes'),
    ]).map((item) => item.title)).toEqual(['Test crashes']);
  });

  it('groups root causes using the same normalized marker as reruns', () => {
    const finding = (line: number, severity: Finding['severity'], rootCause: string): Finding => ({
      path: `src/${line}.ts`, line, severity, title: `Issue ${line}`, body: 'Fix it.', rootCause,
      category: 'correctness', confidence: 'high', evidence: { path: `src/${line}.ts`, line, trigger: 'input', consequence: 'failure' },
    });
    const selected = selectPostedFindings([
      finding(1, 'warning', 'Shared  cause'), finding(2, 'critical', ' shared cause '),
    ]);
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ line: 2, rootCause: ' shared cause ' });
    expect(selected[0]!.body).toContain('Related locations: src/1.ts:1');
  });
});

describe('fresh finding evidence validation', () => {
  const file = parseUnifiedDiff(DIFF).find((entry) => entry.newPath === 'src/app.ts')!;
  const base = { line: 4, severity: 'warning', category: 'correctness', confidence: 'high', rootCause: 'bad guard',
    evidence: { path: 'src/app.ts', line: 4, trigger: 'n is zero', consequence: 'the guard assigns instead of compares' }, title: 'Bad guard', body: 'Use ===.' };

  it('rejects an unknown category', () => {
    expect(() => parseFindings(JSON.stringify({ findings: [{ ...base, category: 'style' }] }), file)).toThrow('category');
  });

  it('rejects evidence that does not cite the changed finding line', () => {
    expect(() => parseFindings(JSON.stringify({ findings: [{ ...base, evidence: { ...base.evidence, line: 3 } }] }), file)).toThrow('evidence');
  });

  it('requires an exact repository rule citation', () => {
    expect(() => parseFindings(JSON.stringify({ findings: [{ ...base, category: 'repository_rule' }] }), file)).toThrow('evidence');
    expect(() => parseFindings(JSON.stringify({ findings: [{ ...base, category: 'repository_rule', evidence: { ...base.evidence, rule: { path: 'CLAUDE.md', line: 0, quote: '' } } }] }), file)).toThrow('evidence');
  });

  it('suppresses repository-rule findings whose base rule citation is fabricated', async () => {
    const llm = fakeLlm({ file: JSON.stringify({ findings: [{ ...base, category: 'repository_rule', evidence: {
      ...base.evidence, rule: { path: 'CLAUDE.md', line: 999, quote: 'made up rule' },
    } }] }) });
    const ruleDb = openDb(':memory:');
    ruleDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    ruleDb.setRepoStatus(REPO_ID, 'ready', { last_commit: PR.baseSha });
    const result = await reviewPullRequest({ db: ruleDb, llm: llm.provider, retrieve: retrieveOne, github: fakeGithub().github }, { repoId: REPO_ID, prNumber: 42, post: false });
    ruleDb.close();
    expect(result.findings).toEqual([]);
    expect(result.warnings.some((warning) => warning.includes('Suppressed repository rule finding'))).toBe(true);
  });

  it('deduplicates an entire root-cause group on a rerun', async () => {
    const findings = [
      { ...base, line: 4, title: 'Shared issue A' },
      { ...base, line: 3, title: 'Shared issue B', evidence: { ...base.evidence, line: 3 } },
    ];
    const makeLlm = () => fakeLlm({ file: JSON.stringify({ findings }) });
    const ruleDb = openDb(':memory:');
    ruleDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    ruleDb.setRepoStatus(REPO_ID, 'ready', { last_commit: PR.baseSha });
    const firstGithub = fakeGithub();
    await reviewPullRequest({ db: ruleDb, llm: makeLlm().provider, retrieve: retrieveOne, github: firstGithub.github }, { repoId: REPO_ID, prNumber: 42 });
    const firstComment = firstGithub.reviews[0]!.input.comments[0]!;
    expect(firstComment.body).toContain('Related locations:');
    const secondGithub = fakeGithub(DIFF, PR, { existingComments: [{ ...firstComment, line: firstComment.line, user: 'repolens' }] });
    const second = await reviewPullRequest({ db: ruleDb, llm: makeLlm().provider, retrieve: retrieveOne, github: secondGithub.github }, { repoId: REPO_ID, prNumber: 42, force: true });
    expect(secondGithub.reviews[0]!.input.comments).toEqual([]);
    expect(second.warnings).toContain('Skipped 1 findings already commented');
    ruleDb.close();
  });
});

describe('review context selection', () => {
  it('prioritizes exact response-shape symbols and paths over prose-frequency tokens', () => {
    const query = contextQuery('src/calcom/response.ts', 'return response.data from getBookingResponse()', () => [
      'response', 'response', 'shape', 'getBookingResponse', 'data', 'return',
    ]);
    expect(query.stem).toBe('response');
    expect(query.symbols.slice(0, 3)).toEqual(['getBookingResponse', 'response', 'data']);
    expect(query.symbols).not.toContain('shape');
    expect(query.symbols).not.toContain('return');
  });

  it('keeps caller-contract identifiers ahead of repeated prose terms', () => {
    const query = contextQuery('src/keycloak/handler.ts', 'caller invokes authorizeRequest(client)', () => [
      'caller', 'caller', 'invokes', 'authorizeRequest', 'client',
    ]);
    expect(query.symbols.slice(0, 2)).toEqual(['authorizeRequest', 'client']);
    expect(query.symbols).not.toContain('caller');
    expect(query.symbols).not.toContain('invokes');
  });

  it('does not promote capitalized prose ahead of exact callees', () => {
    const query = contextQuery('src/calcom/booking.ts', 'The Authorize response shape changed; getBookingResponse() returns data.', () => [
      'The', 'Authorize', 'response', 'shape', 'getBookingResponse', 'returns', 'data',
    ]);
    expect(query.symbols[0]).toBe('getBookingResponse');
    expect(query.symbols.indexOf('The')).toBeGreaterThan(query.symbols.indexOf('getBookingResponse'));
    expect(query.symbols.indexOf('Authorize')).toBeGreaterThan(query.symbols.indexOf('getBookingResponse'));
  });

  it('prioritizes at most two declarations over repeated implementation variables', () => {
    const query = contextQuery('lib/thing.rb', [
      'def save?(record)',
      '  implementation_value = record',
      'end',
      'def publish(record)',
      '  implementation_value = save?(record)',
      'end',
    ].join('\n'), () => ['implementation_value', 'record', 'implementation_value']);
    expect(query.symbols.slice(0, 2)).toEqual(['save?', 'publish']);
    expect(query.symbols.slice(0, 6).filter((symbol) => ['save?', 'publish'].includes(symbol))).toHaveLength(2);
  });

  it('recognizes parenthesis-free Ruby declarations within the retrieval budget', () => {
    const query = contextQuery('lib/website.rb', [
      'def include_website_name',
      '  implementation_value = record',
      'end',
      'implementation_value = implementation_value.strip',
    ].join('\n'), () => ['implementation_value', 'implementation_value', 'record']);
    expect(query.symbols.slice(0, 6)).toContain('include_website_name');
    expect(query.symbols.slice(0, 2)[0]).toBe('include_website_name');
  });

  it('keeps numbered bounded head windows for oversized files around every relevant line', () => {
    const lines = Array.from({ length: 4_000 }, (_, index) => `line-${index + 1}`);
    const context = buildHeadContext({
      path: 'src/large.ts', addedText: 'guard()',
      headContents: new Map([['src/large.ts', lines.join('\n')]]),
      relevantLines: [100, 300],
    });
    expect(context).toContain('### src/large.ts (content after this pull request; bounded windows)');
    expect(context).toContain('100 | line-100');
    expect(context).toContain('300 | line-300');
    expect(context).toContain('80 | line-80');
    expect(context).toContain('320 | line-320');
    expect(context).not.toMatch(/(?:^|\n)1 \| line-1(?:\n|$)/);
    expect(context.length).toBeLessThanOrEqual(12_000);
  });

  it('keeps endpoints when a relevant hunk spans many head lines', () => {
    const lines = Array.from({ length: 4_000 }, (_, index) => `line-${index + 1}`);
    const context = buildHeadContext({
      path: 'src/large.ts', addedText: 'guard()',
      headContents: new Map([['src/large.ts', lines.join('\n')]]),
      relevantLines: Array.from({ length: 500 }, (_, index) => index + 100),
    });
    expect(context).toMatch(/(?:^|\n)100 \| line-100(?:\n|$)/);
    expect(context).toMatch(/(?:^|\n)599 \| line-599(?:\n|$)/);
  });

  it('numbers small own head files so nearby guards can be cited', () => {
    const context = buildHeadContext({
      path: 'src/small.ts', addedText: 'return value;',
      headContents: new Map([['src/small.ts', 'function run(input: string) {\n  if (!input) return;\n  return value;\n}']]),
      relevantLines: [3],
    });
    expect(context).toContain('### src/small.ts (content after this pull request; bounded windows)');
    expect(context).toContain('2 |   if (!input) return;');
    expect(context).toContain('3 |   return value;');
  });

  it('keeps matching definitions and callers while dropping unrelated chunks', () => {
    const chunks: RetrievedChunk[] = [
      { ...CHUNK, chunkId: 1, path: 'src/helper.ts', content: 'export function helper() {}' },
      { ...CHUNK, chunkId: 2, path: 'tests/helper.test.ts', content: 'expect(helper()).toBe(1)' },
      { ...CHUNK, chunkId: 3, path: 'src/unrelated.ts', content: 'export function other() {}' },
    ];
    expect(selectRelevantChunks(chunks, ['helper'], 'src/app.ts').map((c) => c.chunkId)).toEqual([1, 2]);
  });

  it('returns no arbitrary context when no exact symbol or path term matches', () => {
    const chunks: RetrievedChunk[] = [{ ...CHUNK, path: 'src/unrelated.ts', content: 'export function other() {}' }];
    expect(selectRelevantChunks(chunks, ['missing'], 'src/app.ts')).toEqual([]);
    expect(selectRelevantChunks(chunks, [], 'src/app.ts')).toEqual([]);
  });

  it('reserves only a test chunk that matches the changed symbol or stem', () => {
    const chunks: RetrievedChunk[] = [
      { ...CHUNK, chunkId: 1, path: 'tests/unrelated.test.ts', content: 'otherThing()' },
      { ...CHUNK, chunkId: 2, path: 'tests/helper.test.ts', content: 'helper()' },
    ];
    expect(selectRelevantChunks(chunks, ['helper'], 'src/app.ts').map((chunk) => chunk.chunkId)).toEqual([2]);
  });

  it('finds only root and applicable nested repository rule files', () => {
    expect(repositoryRulePaths(['src/review/app.ts', 'tests/review/app.test.ts'])).toEqual([
      'AGENTS.md', 'CLAUDE.md',
      'src/review/AGENTS.md', 'src/review/CLAUDE.md', 'src/AGENTS.md', 'src/CLAUDE.md',
      'tests/review/AGENTS.md', 'tests/review/CLAUDE.md', 'tests/AGENTS.md', 'tests/CLAUDE.md',
    ]);
  });

  it('renders rule sources with their base revision citation', () => {
    expect(renderRepositoryRules(new Map([['src/AGENTS.md', 'Run focused tests.']]), 'base123'))
      .toContain('### src/AGENTS.md (base base123)\n1 | Run focused tests.');
  });

  it('prioritizes the closest deep rule before ancestor candidates', () => {
    const paths = repositoryRulePaths(['a/b/c/d/e/f/g/h/file.ts']);
    expect(paths.slice(0, 2)).toEqual(['AGENTS.md', 'CLAUDE.md']);
    expect(paths.slice(2, 6)).toEqual(['a/b/c/d/e/f/g/h/AGENTS.md', 'a/b/c/d/e/f/g/h/CLAUDE.md', 'a/b/c/d/e/f/g/AGENTS.md', 'a/b/c/d/e/f/g/CLAUDE.md']);
  });
});

describe('verifier decision citations', () => {
  it('accepts only structured citations for paths containing spaces', () => {
    const files = [{
      path: 'src/my file.ts',
      currentEvidence: [{ line: 7 }],
      headContext: '### src/my file.ts (content after this pull request; bounded windows)\n```\n7 | return value;\n```',
    }];
    expect(hasValidVerifierCitation({ evidence: { path: 'src/my file.ts', line: 7 }, explanation: 'Supported.' }, files)).toBe(true);
    expect(hasValidVerifierCitation({ explanation: 'Supported at src/my file.ts:7.' }, files)).toBe(false);
    expect(hasValidVerifierCitation({ evidence: { path: 'src/my file.ts', line: 8 } }, files)).toBe(false);
    expect(hasValidVerifierCitation({ evidence: { path: 'src/my file.ts', line: '7' } }, files)).toBe(false);
    expect(VERIFIER_SYSTEM_PROMPT).toContain('Supported and contradicted decisions must include evidence:{path:string,line:number}');
  });
});

const REPO_ID = 'github:o/r';

const DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,5 +1,6 @@',
  " import { x } from './x.js';",
  ' ',
  '-export function run() {',
  '+export function run(n: number) {',
  '+  if (n = 0) return;',
  '   return x();',
  ' }',
  'diff --git a/package-lock.json b/package-lock.json',
  '--- a/package-lock.json',
  '+++ b/package-lock.json',
  '@@ -1,2 +1,2 @@',
  '-  "version": "1.0.0",',
  '+  "version": "1.0.1",',
  '   "x": 1',
  'diff --git a/assets/logo.png b/assets/logo.png',
  'index ddddddd..eeeeeee 100644',
  'Binary files a/assets/logo.png and b/assets/logo.png differ',
  'diff --git a/src/gone.ts b/src/gone.ts',
  'deleted file mode 100644',
  '--- a/src/gone.ts',
  '+++ /dev/null',
  '@@ -1,1 +0,0 @@',
  '-const gone = true;',
  '',
].join('\n');

const PR: PullRequest = {
  number: 42,
  title: 'Add run()',
  body: 'Adds a guard.',
  headSha: 'head-sha-1',
  baseSha: 'base-sha-1',
  headRef: 'feature',
  baseRef: 'main',
  author: 'octocat',
  htmlUrl: 'https://github.com/o/r/pull/42',
  draft: false,
  updatedAt: '2026-01-01T00:00:00Z',
};

const CHUNK: RetrievedChunk = {
  chunkId: 1,
  repoId: REPO_ID,
  path: 'src/x.ts',
  startLine: 1,
  endLine: 3,
  content: 'export function x() { return 1; }',
  score: 0.9,
};

interface FakeLlmOptions {
  file?: string | (() => string);
  summary?: string;
  allowDeleted?: boolean;
}

function fakeLlm(opts: FakeLlmOptions = {}) {
  const calls: CompleteRequest[] = [];
  const provider: LLMProvider = {
    name: 'fake',
    model: 'm1',
    concurrency: 2,
    async complete(req) {
      calls.push(req);
      if (req.system === FILE_REVIEW_SYSTEM_PROMPT) {
        if (!opts.allowDeleted && req.messages[0]!.content.includes('File under review: src/gone.ts')) return '{"findings":[]}';
        if (opts.allowDeleted && !req.messages[0]!.content.includes('File under review: src/gone.ts')) return '{"findings":[]}';
        const f = opts.file ?? '{"findings":[]}';
        return typeof f === 'function' ? f() : f;
      }
      if (req.system === SUMMARY_SYSTEM_PROMPT || req.system === FOLLOWUP_SUMMARY_SYSTEM_PROMPT) {
        return opts.summary ?? '{"summary":"Adds a guard to run().","verdict":"comment"}';
      }
      throw new Error('unexpected system prompt');
    },
  };
  return { calls, provider, fileCalls: () => calls.filter((c) => c.system === FILE_REVIEW_SYSTEM_PROMPT) };
}

interface FakeGithubOptions {
  /** Comments already on the PR, returned by listReviewComments. */
  existingComments?: ExistingReviewComment[];
  /** Make createReview reject. */
  createReviewError?: () => Error | null;
  /** Make listReviewComments reject. */
  listError?: Error;
  /** Make getPullDiff reject (stands in for any failure inside the review). */
  diffError?: Error;
  /** Make createCommitStatus reject. */
  statusError?: Error;
  /** Post-change content by path, as returned by getFileContent (missing path → null). */
  headFiles?: Record<string, string>;
  /** Make getFileContent reject for the given path. */
  fileContentError?: (path: string) => Error | null;
  /** Commits returned by listPullCommits. */
  commits?: Array<{ sha: string; message: string }>;
  /** Diff returned by compareDiff (null = GitHub cannot compare). */
  compare?: string | null;
  /** Historical path commits and associated PRs. */
  historyCommits?: PathCommit[];
  historyCommitsByPath?: Record<string, PathCommit[]>;
  historyPulls?: HistoricalPullRequest[];
  historyPullsByCommit?: Record<string, HistoricalPullRequest[]>;
}

interface StatusCall {
  owner: string;
  repo: string;
  sha: string;
  input: CommitStatusInput;
}

function fakeGithub(diff = DIFF, pr: PullRequest = PR, opts: FakeGithubOptions = {}) {
  const reviews: Array<{ owner: string; repo: string; number: number; input: CreateReviewInput }> = [];
  const listCalls: Array<{ owner: string; repo: string; number: number }> = [];
  const statuses: StatusCall[] = [];
  const contentCalls: Array<{ path: string; ref: string }> = [];
  const compareCalls: Array<{ base: string; head: string }> = [];
  const historyCalls: string[] = [];
  const github: ReviewDeps['github'] = {
    async listPullCommits() {
      return opts.commits ?? [];
    },
    async listCommitPulls(_owner: string, _repo: string, sha: string) {
      return opts.historyPullsByCommit?.[sha] ?? opts.historyPulls ?? [];
    },
    async listPathCommits(_owner: string, _repo: string, path: string, ref: string) {
      historyCalls.push(`${path}@${ref}`);
      return opts.historyCommitsByPath?.[path] ?? opts.historyCommits ?? [];
    },
    async compareDiff(_owner: string, _repo: string, base: string, head: string) {
      compareCalls.push({ base, head });
      return opts.compare === undefined ? null : opts.compare;
    },
    async getPull() {
      return pr;
    },
    async getPullDiff() {
      if (opts.diffError) throw opts.diffError;
      return diff;
    },
    async getFileContent(_owner: string, _repo: string, path: string, ref: string) {
      contentCalls.push({ path, ref });
      const err = opts.fileContentError?.(path);
      if (err) throw err;
      return opts.headFiles?.[path] ?? null;
    },
    async createCommitStatus(owner: string, repo: string, sha: string, input: CommitStatusInput) {
      statuses.push({ owner, repo, sha, input });
      if (opts.statusError) throw opts.statusError;
    },
    async listReviewComments(owner: string, repo: string, number: number) {
      listCalls.push({ owner, repo, number });
      if (opts.listError) throw opts.listError;
      return opts.existingComments ?? [];
    },
    async createReview(owner: string, repo: string, number: number, input: CreateReviewInput) {
      const err = opts.createReviewError?.();
      if (err) throw err;
      reviews.push({ owner, repo, number, input });
      return { id: 7, htmlUrl: 'https://github.com/o/r/pull/42#pullrequestreview-7' };
    },
  };
  return { reviews, listCalls, statuses, contentCalls, compareCalls, historyCalls, github };
}

const retrieveOne: RetrieveFn = async () => [CHUNK];

// Existing fixtures predate mandatory evidence. Keep them focused on their original
// behavior while production parsing remains strict; new contract tests use explicit fields.
function enrichLegacyFindingResponse(raw: string, request: CompleteRequest): string {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return raw; }
  const findings = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && Array.isArray((parsed as { findings?: unknown }).findings)
    ? (parsed as { findings: unknown[] }).findings : null;
  if (!findings) return raw;
  const fileMatch = request.messages[0]?.content.match(/File under review: ([^ (]+)/);
  const files = fileMatch ? [fileMatch[1]!] : [];
  const enriched = findings.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const finding = item as Record<string, unknown>;
    const path = typeof finding.path === 'string' ? finding.path : files[0] ?? 'unknown.ts';
    const line = typeof finding.line === 'number' ? finding.line : Number(finding.line);
    return {
      ...finding,
      category: finding.category ?? 'correctness',
      confidence: finding.confidence ?? 'high',
      rootCause: finding.rootCause ?? `${path}:${line}:${String(finding.title ?? '')}`,
      evidence: finding.evidence ?? { path, line, trigger: 'fixture input', consequence: 'fixture behavior changes' },
    };
  });
  return JSON.stringify(Array.isArray(parsed) ? enriched : { ...(parsed as object), findings: enriched });
}

function reviewPullRequest(deps: ReviewDeps, opts: Parameters<typeof runReviewPullRequest>[1]) {
  const wrap = (llm: LLMProvider): LLMProvider => ({
    ...llm,
    async complete(req) { return enrichLegacyFindingResponse(await llm.complete(req), req); },
    reviewFallbacks: llm.reviewFallbacks?.map(wrap),
  });
  return runReviewPullRequest({
    ...deps,
    llm: wrap(deps.llm),
    escalationLlm: deps.escalationLlm ? wrap(deps.escalationLlm) : undefined,
    verifierLlm: deps.verifierLlm ? wrap(deps.verifierLlm) : undefined,
  }, opts);
}

function makeDeps(db: Db, overrides: Partial<ReviewDeps> = {}): ReviewDeps {
  const llm = fakeLlm();
  return { db, llm: llm.provider, retrieve: retrieveOne, github: fakeGithub().github, ...overrides };
}

describe('reviewPullRequest', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
    db.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    // Indexed at the PR base by default, so no staleness note or "never indexed" warning.
    db.setRepoStatus(REPO_ID, 'ready', { last_commit: PR.baseSha });
  });
  afterEach(() => db.close());

  it('fresh reviews ignore prior review lineage and existing GitHub comments while keeping full findings', async () => {
    db.insertReview({
      repo_id: REPO_ID, pr_number: 42, head_sha: PR.headSha, status: 'done',
      summary: 'old review', verdict: 'request_changes', comments_json: JSON.stringify([
        { path: 'src/app.ts', line: 4, severity: 'critical', title: 'Old', body: 'Old finding.' },
      ]), posted: 1, error: null,
    });
    const llm = fakeLlm({
      file: JSON.stringify({ findings: [{ line: 4, severity: 'critical', title: 'Fresh', body: 'Use ===.' }] }),
    });
    const gh = fakeGithub(DIFF, PR, {
      existingComments: [{ path: 'src/app.ts', line: 4, body: '**[critical] Fresh**', user: 'repolens' }],
    });

    const result = await reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, {
      repoId: REPO_ID, prNumber: 42, fresh: true,
    });

    expect(result.findings).toMatchObject([{ path: 'src/app.ts', line: 4, title: 'Fresh', category: 'correctness', confidence: 'high' }]);
    expect(result.reviewId).not.toBe(1);
    expect(gh.listCalls).toEqual([]);
    expect(gh.reviews[0]!.input.comments).toHaveLength(1);
  });

  it.each([
    { costs: [0.012, 0.003], expected: 0.015 },
    { costs: [0, 0, 0], expected: 0 },
    { costs: [0.012, null], expected: null },
    { costs: [0.012, undefined], expected: null },
    { costs: [[0.01, 0.002], 0.003], expected: 0.015 },
    { costs: [[0.01, 0.002], undefined], expected: null },
  ])('stores the review cost for $costs and preserves it on cache hits', async ({ costs, expected }) => {
    const tracker = new UsageTracker({ db, pricing: null });
    const fake = fakeLlm();
    const record = { provider: 'fake', model: 'm1', inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1 };
    const llm = { ...fake.provider, async complete(req: CompleteRequest) {
      const costUsd = costs[fake.calls.length];
      tracker.sinkFor('chat')({ ...record, costUsd: 1 });
      for (const value of Array.isArray(costUsd) ? costUsd : [costUsd]) {
        if (value !== undefined) tracker.sinkFor('review')({ ...record, costUsd: value });
      }
      return fake.provider.complete(req);
    } };
    const deps = makeDeps(db, { llm });
    const result = await reviewPullRequest(deps, { repoId: REPO_ID, prNumber: 42, post: false });
    expect(fake.calls).toHaveLength(2); // modified file, deleted file
    expect(db.getReview(result.reviewId)?.cost_usd).toEqual(expected);
    await reviewPullRequest(deps, { repoId: REPO_ID, prNumber: 42, post: false });
    expect(fake.calls).toHaveLength(2);
    expect(db.listReviews(REPO_ID)[0]?.cost_usd).toEqual(expected);
  });

  it('keeps concurrent review costs separate', async () => {
    const tracker = new UsageTracker({ db, pricing: null });
    const results = await Promise.all([0.01, 0.02].map(async (costUsd, i) => {
      const fake = fakeLlm();
      const llm = { ...fake.provider, async complete(req: CompleteRequest) {
        await new Promise((resolve) => setTimeout(resolve, i ? 1 : 5));
        tracker.sinkFor('review')({ provider: 'fake', model: 'm1', inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1, costUsd });
        return fake.provider.complete(req);
      } };
      return reviewPullRequest(makeDeps(db, { llm }), { repoId: REPO_ID, prNumber: 42 + i, post: false });
    }));
    expect(results.map((r) => db.getReview(r.reviewId)?.cost_usd)).toEqual([0.02, 0.04]);
  });

  it('reviews forty Qwen files and summarizes in one bounded call, sharing context once', async () => {
    const paths = Array.from({ length: 40 }, (_, i) => `src/file${i}.ts`);
    const diff = paths.map((path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${'n'.repeat(2000)}\n`).join('');
    const gh = fakeGithub(diff);
    const calls: CompleteRequest[] = [];
    const lexicalOnlyRequests: (boolean | undefined)[] = [];
    const llm: LLMProvider = { name: 'openrouter', model: 'qwen/qwen3-coder', supportsBatchReview: true, concurrency: 4, async complete(req) {
      calls.push(req);
      return JSON.stringify({ reviewedPaths: paths, summary: 'Updates the files.', verdict: 'request_changes', findings: [
        { path: paths[39], line: 1, severity: 'critical', title: 'Bug', body: 'Fix it.' },
        { path: paths[0], line: 1, severity: 'warning', title: 'Valid line', body: 'Not ignored.' },
      ] });
    } };
    const retrieve: RetrieveFn = async (req) => {
      lexicalOnlyRequests.push(req.lexicalOnly);
      expect(req.excludePaths).toEqual(paths);
      return [CHUNK, { ...CHUNK, chunkId: 2, content: '💸'.repeat(200000) }];
    };
    const result = await reviewPullRequest({ db, llm, retrieve, github: gh.github }, { repoId: REPO_ID, prNumber: 42, post: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.reviewBudget).toBe(true);
    expect(reviewCostUpperBound(calls[0]!)).toBeGreaterThan(0.045);
    expect(reviewCostUpperBound(calls[0]!)).toBeLessThanOrEqual(REVIEW_MAX_USD);
    expect(calls[0]!.messages[0]!.content.split(CHUNK.content)).toHaveLength(1);
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]!.path).toBe(paths[39]);
    expect(result.verdict).toBe('request_changes');
    expect(lexicalOnlyRequests.every((value) => value === undefined)).toBe(true);
  });

  it('deduplicates equivalent evidence before packing and leaves room for a retry', async () => {
    const evidence = `run DUPLICATE_EVIDENCE ${'x'.repeat(350_000)}`;
    const calls: CompleteRequest[] = [];
    const llm: LLMProvider = { ...fakeLlm().provider, supportsBatchReview: true, async complete(req) {
      calls.push(req);
      return JSON.stringify({ reviewedPaths: ['src/app.ts', 'src/gone.ts'], summary: 'Reviewed.', verdict: 'approve', findings: [] });
    } };
    const retrieve: RetrieveFn = async () => [
      { ...CHUNK, chunkId: 101, path: 'src/helper.ts', content: evidence },
      { ...CHUNK, chunkId: 102, path: 'src/helper.ts', content: evidence },
    ];
    await reviewPullRequest({ db, llm, retrieve, github: fakeGithub().github, maxRetries: 0 }, { repoId: REPO_ID, prNumber: 42, post: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.messages[0]!.content.match(/DUPLICATE_EVIDENCE/g)).toHaveLength(1);
    expect(reviewCostUpperBound(calls[0]!) * 2).toBeLessThanOrEqual(REVIEW_MAX_USD);
  });

  it('deduplicates shared evidence in escalation and verifier payloads before reserving their costs', async () => {
    const diff = [
      'diff --git a/src/one.ts b/src/one.ts', '--- a/src/one.ts', '+++ b/src/one.ts', '@@ -1 +1 @@', '-old', '+if (token) return sharedContract();',
      'diff --git a/src/two.ts b/src/two.ts', '--- a/src/two.ts', '+++ b/src/two.ts', '@@ -1 +1 @@', '-old', '+if (token) return sharedContract();',
    ].join('\n');
    const paths = ['src/one.ts', 'src/two.ts'];
    const finding = (path: string): Finding => ({
      path, line: 1, severity: 'warning', title: 'Shared contract', body: 'Check the shared contract.',
      category: 'correctness', confidence: 'high', rootCause: 'shared contract',
      evidence: { path, line: 1, trigger: 'the call reaches the shared contract', consequence: 'the contract rejects valid input' },
    });
    let escalationRequest: CompleteRequest | undefined;
    let verifierRequest: CompleteRequest | undefined;
    const initial: LLMProvider = { ...fakeLlm().provider, supportsBatchReview: true, async complete() {
      return JSON.stringify({ reviewedPaths: paths, summary: 'Reviewed.', verdict: 'comment', findings: paths.map(finding) });
    } };
    const escalation: LLMProvider = { ...initial, model: 'escalation', async complete(req) {
      escalationRequest = req;
      const payload = JSON.parse(req.messages[0]!.content) as { provisionalFindings: Array<{ id: string }> };
      return JSON.stringify({ reviewedPaths: paths, decisions: payload.provisionalFindings.map(({ id }) => ({ id, decision: 'retain' })), findings: [] });
    } };
    const verifier: LLMProvider = { ...initial, model: 'verifier', async complete(req) {
      verifierRequest = req;
      const payload = JSON.parse(req.messages[0]!.content) as { findings: Array<{ id: number; finding: Finding }> };
      return JSON.stringify({ decisions: payload.findings.map(({ id, finding: item }) => ({ id, decision: 'supported', explanation: 'The current evidence supports it.', evidence: { path: item.path, line: 1 } })) });
    } };
    const shared = { ...CHUNK, chunkId: 55, path: 'src/shared.ts', content: `SHARED_EVIDENCE sharedContract() ${'x'.repeat(50_000)}` };
    await reviewPullRequest({ db, llm: initial, escalationLlm: escalation, verifierLlm: verifier, retrieve: async () => [shared], github: fakeGithub(diff).github }, { repoId: REPO_ID, prNumber: 42, post: false, force: true });
    expect(escalationRequest).toBeDefined();
    expect(escalationRequest!.messages[0]!.content.match(/SHARED_EVIDENCE/g)).toHaveLength(1);
    expect(verifierRequest).toBeDefined();
    expect(verifierRequest!.messages[0]!.content.match(/SHARED_EVIDENCE/g)).toHaveLength(1);
    expect(reviewCostUpperBound(escalationRequest!)).toBeLessThanOrEqual(REVIEW_MAX_USD);
    expect(reviewCostUpperBound(verifierRequest!)).toBeLessThanOrEqual(REVIEW_MAX_USD);
  });

  it('lists exactly the validator-allowed finding lines for normal, deleted and deletion-only files', async () => {
    const diff = [
      'diff --git a/src/app.ts b/src/app.ts', '--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1,2 +1,2 @@',
      ' context', '-old', '+new',
      'diff --git a/src/gone.ts b/src/gone.ts', 'deleted file mode 100644', '--- a/src/gone.ts', '+++ /dev/null', '@@ -10,2 +0,0 @@',
      '-gone', '-also gone',
      'diff --git a/src/auth.ts b/src/auth.ts', '--- a/src/auth.ts', '+++ b/src/auth.ts', '@@ -4,3 +4,1 @@',
      ' context', '-const auth = true;', '-const allowed = true;', '',
    ].join('\n');
    const requests: CompleteRequest[] = [];
    const llm: LLMProvider = { name: 'fake', model: 'batch', supportsBatchReview: true, concurrency: 1, async complete(req) {
      requests.push(req);
      return JSON.stringify({ reviewedPaths: ['src/app.ts', 'src/gone.ts', 'src/auth.ts'], summary: 'Reviewed.', verdict: 'request_changes', findings: [
        { path: 'src/app.ts', line: 2, severity: 'warning', title: 'Normal', body: 'Check.' },
        { path: 'src/gone.ts', line: 10, severity: 'critical', title: 'Deleted', body: 'Restore.' },
        { path: 'src/auth.ts', line: 4, severity: 'warning', title: 'Deletion only', body: 'Check.' },
      ] });
    } };
    const result = await reviewPullRequest({ db, llm, retrieve: async () => [], github: fakeGithub(diff).github }, { repoId: REPO_ID, prNumber: 42, post: false });
    const payload = JSON.parse(requests[0]!.messages[0]!.content) as { files: Array<{ path: string; allowedFindingLines: number[] }> };
    expect(payload.files.map((file) => [file.path, file.allowedFindingLines])).toEqual([
      ['src/app.ts', [2]],
      ['src/gone.ts', [10, 11]],
      ['src/auth.ts', [4, 5, 6]],
    ]);
    expect(result.findings.map((finding) => [finding.path, finding.line])).toEqual([
      ['src/gone.ts', 0], ['src/app.ts', 2], ['src/auth.ts', 0],
    ]);
  });

  it('fails oversized Qwen reviews before inference without posting or caching a clean review', async () => {
    const llm = { ...fakeLlm().provider, name: 'openrouter', model: 'qwen/qwen3-coder', supportsBatchReview: true, complete: async () => { throw new Error('must not call'); } };
    const gh = fakeGithub(DIFF.replace('+  if (n = 0) return;', '+' + '💸'.repeat(500000)));
    let retrievals = 0;
    const retrieve: RetrieveFn = async () => { retrievals++; return [CHUNK]; };
    await expect(reviewPullRequest({ db, llm, retrieve, github: gh.github, statusContext: 'repolens/review' }, { repoId: REPO_ID, prNumber: 42 })).rejects.toThrow('$0.50');
    expect(retrievals).toBe(0);
    expect(gh.statuses.map((s) => s.input.state)).toEqual(['pending', 'error']);
    expect(gh.reviews).toHaveLength(0);
    expect(db.findReview(REPO_ID, 42, PR.headSha)).toBeUndefined();
  });

  it.each([40, 2])('rejects reviews above the %i-file limit before inference', async (maxFiles) => {
    const paths = Array.from({ length: maxFiles + 1 }, (_, i) => `src/file${i}.ts`);
    const diff = paths.map((path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`).join('');
    const gh = fakeGithub(diff);
    const llm = { ...fakeLlm().provider, name: 'openrouter', model: 'qwen/qwen3-coder' };
    await expect(reviewPullRequest({ db, llm, maxFiles, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 })).rejects.toThrow('file limit');
    expect(gh.contentCalls.filter((c) => c.ref === PR.headSha)).toHaveLength(maxFiles + 1);
    expect(gh.reviews).toHaveLength(0);
  });

  it('filters every generated candidate before applying the file limit', async () => {
    const paths = Array.from({ length: 41 }, (_, i) => `src/generated-client-${i}.ts`);
    const diff = paths.map((path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -100 +100 @@\n-old\n+new\n`).join('');
    const headFiles = Object.fromEntries(paths.map((path) => [path, '// Code generated by tool. DO NOT EDIT.\nold\nnew\n']));
    const gh = fakeGithub(diff, PR, { headFiles });
    const result = await reviewPullRequest({ db, llm: fakeLlm().provider, maxFiles: 40, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42, post: false });
    expect(result.skippedFiles).toHaveLength(paths.length);
    expect(result.findings).toEqual([]);
  });

  it('records malformed Qwen JSON as an error and continues processing jobs', async () => {
    const gh = fakeGithub(DIFF.replace('+  if (n = 0) return;', '+' + 'n'.repeat(300_000)));
    const llm = { ...fakeLlm().provider, name: 'openrouter', model: 'qwen/qwen3-coder', supportsBatchReview: true, complete: async () => 'not JSON' };
    const queue = new JobQueue(db);
    const failed = queue.enqueue('review', REPO_ID, (ctx) => reviewPullRequest({ db, llm, maxRetries: 3, retrieve: retrieveOne, github: gh.github, log: (m) => ctx.progress(m), statusContext: 'repolens/review' }, { repoId: REPO_ID, prNumber: 42 }));
    const next = queue.enqueue('review', REPO_ID, async () => 'still running');
    await queue.idle();
    expect(db.getJob(failed.id)?.status).toBe('error');
    expect(db.getJob(failed.id)?.error).toContain('No JSON object found in model output');
    expect(db.getJob(failed.id)?.progress).toContain('commit status error');
    expect(db.getJob(next.id)?.status).toBe('done');
    expect(gh.statuses.map((s) => s.input.state)).toEqual(['pending', 'error']);
    expect(gh.reviews).toHaveLength(0);
    expect(db.findReview(REPO_ID, 42, PR.headSha)).toBeUndefined();
  });

  it('rejects a Qwen response that omitted a reviewed path', async () => {
    const llm = { ...fakeLlm().provider, name: 'openrouter', model: 'qwen/qwen3-coder', supportsBatchReview: true, complete: async () => JSON.stringify({ findings: [], summary: 'Fine', verdict: 'approve', reviewedPaths: [] }) };
    const gh = fakeGithub();
    await expect(reviewPullRequest({ db, llm, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 })).rejects.toThrow('Incomplete review');
    expect(gh.reviews).toHaveLength(0);
    expect(db.findReview(REPO_ID, 42, PR.headSha)).toBeUndefined();
  });

  it.each(['not JSON', JSON.stringify({ findings: [], summary: 'Fine', verdict: 'approve', reviewedPaths: [] })])('uses one corrective retry for malformed batch responses: %s', async (invalid) => {
    const gh = fakeGithub();
    let calls = 0;
    const llm = { ...fakeLlm().provider, name: 'openrouter', model: 'qwen/qwen3-coder', supportsBatchReview: true, complete: async () => {
      calls++;
      return calls === 1 ? invalid : JSON.stringify({ findings: [], summary: 'Reviewed all changes.', verdict: 'approve', reviewedPaths: ['src/app.ts', 'src/gone.ts'] });
    } };
    const result = await reviewPullRequest({ db, llm, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 });
    expect(calls).toBe(2);
    expect(result.posted).toBe(true);
    expect(result.summary).toBe('The review found no actionable issues in the supplied changes.');
    expect(gh.reviews).toHaveLength(1);
  });

  it('retries an incomplete Qwen batch with the deleted file and publishes its body-only finding', async () => {
    const gh = fakeGithub();
    const deletedDiff = [
      '@@ -1,1 +0,0 @@',
      '    1 - const gone = true;',
    ].join('\n');
    const requests: CompleteRequest[] = [];
    let calls = 0;
    const llm = { ...fakeLlm().provider, name: 'openrouter', model: 'qwen/qwen3-coder', supportsBatchReview: true, complete: async (req: CompleteRequest) => {
      calls++;
      requests.push(req);
      if (calls === 1) return JSON.stringify({ findings: [], summary: 'Incomplete.', verdict: 'approve', reviewedPaths: ['src/app.ts'] });
      return JSON.stringify({
        reviewedPaths: ['src/app.ts', 'src/gone.ts'], summary: 'Auth was removed.', verdict: 'request_changes',
        findings: [{ path: 'src/gone.ts', line: 1, severity: 'critical', title: 'Auth removed', body: 'Restore the check.' }],
      });
    } };

    const result = await reviewPullRequest({ db, llm, retrieve: retrieveOne, github: gh.github, statusContext: 'repolens/review' }, { repoId: REPO_ID, prNumber: 42 });

    expect(calls).toBe(2);
    expect(requests).toHaveLength(2);
    for (const req of requests) {
      const payload = JSON.parse(req.messages[0]!.content.split('\n\n', 1)[0]!) as { files: Array<{ path: string; status: string; diff: string }> };
      expect(payload.files.find((file) => file.path === 'src/gone.ts')).toMatchObject({ status: 'deleted', diff: deletedDiff });
    }
    expect(result.status?.state).toBe('failure');
    expect(result.findings).toMatchObject([{ path: 'src/gone.ts', line: 0, severity: 'critical' }]);
    expect(gh.reviews[0]!.input.body).toContain('Auth removed');
    expect(gh.reviews[0]!.input.comments).toEqual([]);
  });

  it('retries a Qwen batch whose finding points outside the diff', async () => {
    const gh = fakeGithub();
    let calls = 0;
    const llm = { ...fakeLlm().provider, name: 'openrouter', model: 'qwen/qwen3-coder', supportsBatchReview: true, complete: async () => {
      calls++;
      return JSON.stringify({
        reviewedPaths: ['src/app.ts', 'src/gone.ts'], summary: 'Reviewed all changes.', verdict: 'approve',
        findings: calls === 1
          ? [{ path: 'src/app.ts', line: 999, severity: 'warning', title: 'Outside diff', body: 'Invalid line.' }]
          : [],
      });
    } };

    const result = await reviewPullRequest({ db, llm, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 });

    expect(calls).toBe(2);
    expect(result.posted).toBe(true);
    expect(gh.reviews).toHaveLength(1);
  });

  it.each([undefined, 1])('stops malformed response retries after one correction %s', async (maxRetries) => {
    const gh = fakeGithub();
    let calls = 0;
    const llm = { ...fakeLlm().provider, name: 'openrouter', model: 'qwen/qwen3-coder', supportsBatchReview: true, complete: async () => { calls++; return '{}'; } };
    await expect(reviewPullRequest({ db, llm, maxRetries, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 })).rejects.toThrow('Incomplete review');
    expect(calls).toBe(2);
    expect(gh.reviews).toHaveLength(0);
    expect(db.findReview(REPO_ID, 42, PR.headSha)).toBeUndefined();
  });

  it('does not retry malformed output when maxRetries is zero', async () => {
    const gh = fakeGithub();
    let calls = 0;
    const llm = { ...fakeLlm().provider, supportsBatchReview: true, complete: async () => { calls++; return '{}'; } };
    await expect(reviewPullRequest({ db, llm, maxRetries: 0, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 })).rejects.toThrow('Incomplete review');
    expect(calls).toBe(1);
    expect(gh.reviews).toHaveLength(0);
  });

  it('stops retries when the next attempt would exceed the total review budget', async () => {
    const gh = fakeGithub(DIFF.replace('+  if (n = 0) return;', '+' + 'n'.repeat(800000)));
    let reserved = 0;
    let calls = 0;
    const llm = { ...fakeLlm().provider, name: 'openrouter', model: 'qwen/qwen3-coder', supportsBatchReview: true, complete: async (req: CompleteRequest) => {
      calls++;
      reserved += reviewCostUpperBound(req);
      return '{}';
    } };
    await expect(reviewPullRequest({ db, llm, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 })).rejects.toThrow('budget');
    expect(calls).toBe(1);
    expect(reserved).toBeLessThanOrEqual(REVIEW_MAX_USD);
    expect(gh.reviews).toHaveLength(0);
  });

  it('leaves retry budget after admitting optional context while preserving the full diff and history', async () => {
    const calls: CompleteRequest[] = [];
    const invalid = JSON.stringify({ reviewedPaths: ['src/app.ts', 'src/gone.ts'], summary: 'Incomplete.', verdict: 'approve',
      findings: [{ path: 'src/app.ts', line: 999, severity: 'critical', title: 'Bad', body: 'Fix.' }] });
    const valid = JSON.stringify({ reviewedPaths: ['src/app.ts', 'src/gone.ts'], summary: 'Complete.', verdict: 'approve', findings: [] });
    const fallback: LLMProvider = { name: 'fake', model: 'fallback', concurrency: 1, supportsBatchReview: true, complete: async (req) => {
      calls.push(req);
      return valid;
    } };
    const primary: LLMProvider = { name: 'fake', model: 'primary', concurrency: 1, supportsBatchReview: true, reviewFallbacks: [fallback], complete: async (req) => {
      calls.push(req);
      return invalid;
    } };
    const gh = fakeGithub(DIFF, PR, {
      headFiles: { 'src/app.ts': 'x'.repeat(50_000) },
      historyCommits: [{ sha: 'history-commit', message: 'history', htmlUrl: 'https://github.com/o/r/commit/history-commit' }],
      historyPulls: [{ number: 7, title: 'Old fix', body: 'Historical description', htmlUrl: 'https://github.com/o/r/pull/7', mergedAt: '2025-01-01', repository: 'o/r' }],
    });
    const result = await reviewPullRequest({ db, llm: primary, retrieve: async () => [{ ...CHUNK, content: 'x'.repeat(300_000) }], github: gh.github }, { repoId: REPO_ID, prNumber: 42, post: false });
    expect(result.summary).toBe('The review found no actionable issues in the supplied changes.');
    expect(calls).toHaveLength(2);
    const primaryContent = calls[0]!.messages[0]!.content;
    expect(calls[1]!.messages[0]!.content).toContain('validationError');
    expect(calls[1]!.messages[0]!.content).toContain('Historical description');
    expect(primaryContent).toContain('Historical description');
    const payload = JSON.parse(primaryContent.split('\n\n', 1)[0]!) as { files: Array<{ path: string; status: string; diff: string }> };
    const expected = parseUnifiedDiff(DIFF)
      .filter((file) => file.newPath === 'src/app.ts' || file.oldPath === 'src/gone.ts')
      .map((file) => ({ path: file.newPath ?? file.oldPath!, status: file.status, diff: hunkText(file, Infinity) }));
    expect(payload.files.map(({ path, status, diff }) => ({ path, status, diff }))).toEqual(expected);
    expect(reviewCostUpperBound(calls[0]!) * 2).toBeLessThanOrEqual(REVIEW_MAX_USD);
  });

  it('retries truncated provider output and counts the cost of both attempts', async () => {
    const gh = fakeGithub(DIFF.replace('+  if (n = 0) return;', '+' + 'n'.repeat(300_000)));
    const tracker = new UsageTracker({ db, pricing: null });
    let calls = 0;
    const llm = new OpenRouterProvider({
      apiKey: 'fake', model: 'qwen/qwen3-coder', onUsage: tracker.sinkFor('review'),
      fetch: async () => {
        calls++;
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ findings: [], summary: 'Complete.', verdict: 'approve', reviewedPaths: ['src/app.ts', 'src/gone.ts'] }) }, finish_reason: calls === 1 ? 'length' : 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 100, cost: 0.01 },
        }), { status: 200 });
      },
    });
    const result = await reviewPullRequest({ db, llm, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 });
    expect(calls).toBe(2);
    expect(result.posted).toBe(true);
    expect(db.getReview(result.reviewId)?.cost_usd).toBeCloseTo(0.02);
    expect(gh.reviews).toHaveLength(1);
  });

  it.each([
    { name: 'missing', costs: [] },
    { name: 'null then valid', costs: [null, 0.02] },
    { name: 'negative then positive', costs: [-0.01, 0.02] },
    { name: 'positive then negative', costs: [0.02, -0.01] },
    { name: 'NaN', costs: [Number.NaN, 0.02] },
    { name: 'Infinity', costs: [Number.POSITIVE_INFINITY, 0.02] },
    { name: 'aggregate overflow', costs: [Number.MAX_VALUE, Number.MAX_VALUE] },
  ])('keeps a full reservation for $name billing', async ({ costs }) => {
    const gh = fakeGithub(DIFF.replace('+  if (n = 0) return;', '+' + 'n'.repeat(800_000)));
    const tracker = new UsageTracker({ db, pricing: null });
    let calls = 0;
    const record = { provider: 'fake', model: 'm1', inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1 };
    const llm: LLMProvider = {
      name: 'openrouter', model: 'qwen/qwen3-coder-next', supportsBatchReview: true, concurrency: 1,
      async complete() {
        calls++;
        for (const costUsd of costs) tracker.sinkFor('review')({ ...record, costUsd });
        return '{}';
      },
    };
    await expect(reviewPullRequest({ db, llm, maxRetries: 2, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 })).rejects.toThrow('budget');
    expect(calls).toBe(1);
    expect(gh.reviews).toHaveLength(0);
  });

  it.each([0, 0.02])('reconciles cheap invalid calls billed at %s across model fallback', async (costUsd) => {
    const gh = fakeGithub(DIFF.replace('+  if (n = 0) return;', '+' + 'n'.repeat(800_000)));
    const tracker = new UsageTracker({ db, pricing: null });
    const models: string[] = [];
    const provider = (model: string): LLMProvider => ({
      name: 'openrouter', model, supportsBatchReview: true, concurrency: 1,
      async complete(req: CompleteRequest) {
        expect(reviewCostUpperBound(req) * 2).toBeGreaterThan(REVIEW_MAX_USD);
        expect(costUsd + reviewCostUpperBound(req)).toBeLessThanOrEqual(REVIEW_MAX_USD);
        models.push(model);
        // Multiple valid events are summed for this attempt.
        const record = { provider: 'openrouter', model, inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1 };
        tracker.sinkFor('review')({ ...record, costUsd: costUsd / 2 });
        tracker.sinkFor('review')({ ...record, costUsd: costUsd / 2 });
        return models.length < 2 ? '{}' : JSON.stringify({ findings: [], summary: 'Complete.', verdict: 'approve', reviewedPaths: ['src/app.ts', 'src/gone.ts'] });
      },
    });
    const llm = { ...provider('qwen/qwen3-coder-next'), reviewFallbacks: [provider('qwen/qwen3-coder')] };
    const result = await reviewPullRequest({ db, llm, maxRetries: 2, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 });
    expect(models).toEqual(['qwen/qwen3-coder-next', 'qwen/qwen3-coder']);
    expect(result.posted).toBe(true);
    expect(db.getReview(result.reviewId)?.cost_usd).toBeCloseTo(costUsd * 2);
  });

  it('releases unbilled transient reservations before retrying near the cap', async () => {
    const gh = fakeGithub(DIFF.replace('+  if (n = 0) return;', '+' + 'n'.repeat(800_000)));
    const tracker = new UsageTracker({ db, pricing: null });
    let calls = 0;
    const delays: number[] = [];
    const llm: LLMProvider = {
      name: 'openrouter', model: 'qwen/qwen3-coder-next', supportsBatchReview: true, concurrency: 1,
      async complete() {
        calls++;
        if (calls < 3) throw new ProviderError('openrouter', 'HTTP 429', 429);
        tracker.sinkFor('review')({ provider: 'openrouter', model: 'qwen/qwen3-coder-next', inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1, costUsd: 0.01 });
        return JSON.stringify({ findings: [], summary: 'Complete.', verdict: 'approve', reviewedPaths: ['src/app.ts', 'src/gone.ts'] });
      },
    };
    const result = await reviewPullRequest({ db, llm, maxRetries: 3, sleep: async (ms) => { delays.push(ms); }, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 });
    expect(calls).toBe(3);
    expect(delays).toEqual([15_000, 30_000]);
    expect(result.posted).toBe(true);
  });

  it('keeps the reservation after an unreported network failure', async () => {
    const gh = fakeGithub(DIFF.replace('+  if (n = 0) return;', '+' + 'n'.repeat(800_000)));
    let calls = 0;
    const llm: LLMProvider = {
      name: 'openrouter', model: 'qwen/qwen3-coder-next', supportsBatchReview: true, concurrency: 1,
      async complete() {
        calls++;
        throw new NetworkProviderError('openrouter', 'timeout');
      },
    };
    await expect(reviewPullRequest({ db, llm, maxRetries: 1, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 })).rejects.toThrow('budget');
    expect(calls).toBe(1);
  });

  it('keeps a reservation when a transient failure reports unknown-cost usage', async () => {
    const gh = fakeGithub(DIFF.replace('+  if (n = 0) return;', '+' + 'n'.repeat(800_000)));
    const tracker = new UsageTracker({ db, pricing: null });
    let calls = 0;
    const llm: LLMProvider = {
      name: 'openrouter', model: 'qwen/qwen3-coder-next', supportsBatchReview: true, concurrency: 1,
      async complete() {
        calls++;
        tracker.sinkFor('review')({ provider: 'openrouter', model: 'qwen/qwen3-coder-next', inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1, costUsd: null });
        throw new ProviderError('openrouter', 'HTTP 429', 429);
      },
    };
    await expect(reviewPullRequest({ db, llm, maxRetries: 1, sleep: async () => {}, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 })).rejects.toThrow('budget');
    expect(calls).toBe(1);
  });

  it.each([0, 1])('consumes the retry allowance for malformed zero-cost calls (maxRetries=%s)', async (maxRetries) => {
    const gh = fakeGithub();
    const tracker = new UsageTracker({ db, pricing: null });
    let calls = 0;
    const llm = { ...fakeLlm().provider, supportsBatchReview: true, async complete() {
      calls++;
      tracker.sinkFor('review')({ provider: 'fake', model: 'm1', inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1, costUsd: 0 });
      return '{}';
    } };
    await expect(reviewPullRequest({ db, llm, maxRetries, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 })).rejects.toThrow('Incomplete review');
    expect(calls).toBe(maxRetries + 1);
  });

  it.each([{ costUsd: 0.2, content: '{}' }, { costUsd: 0.5, content: JSON.stringify({ findings: [], summary: 'Complete.', verdict: 'approve', reviewedPaths: ['src/app.ts', 'src/gone.ts'] }) }])('retains the total cap when reported cost is $costUsd', async ({ costUsd, content }) => {
    const gh = fakeGithub(DIFF.replace('+  if (n = 0) return;', '+' + 'n'.repeat(800_000)));
    const tracker = new UsageTracker({ db, pricing: null });
    let calls = 0;
    const llm = { ...fakeLlm().provider, supportsBatchReview: true, async complete() {
      calls++;
      tracker.sinkFor('review')({ provider: 'fake', model: 'm1', inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1, costUsd });
      return content;
    } };
    await expect(reviewPullRequest({ db, llm, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 })).rejects.toThrow(`used $${costUsd.toFixed(6)}`);
    expect(calls).toBe(1);
    expect(gh.reviews).toHaveLength(0);
  });

  it.each([undefined, null, false, 0])('preserves a provider rejection of %s', async (failure) => {
    const llm = { ...fakeLlm().provider, supportsBatchReview: true, complete: async () => { throw failure; } };
    await expect(reviewPullRequest(makeDeps(db, { llm }), { repoId: REPO_ID, prNumber: 42 })).rejects.toBe(failure);
  });

  it('does not retry provider authentication failures', async () => {
    const gh = fakeGithub();
    let calls = 0;
    const llm = new OpenRouterProvider({ apiKey: 'fake', model: 'qwen/qwen3-coder', fetch: async () => {
      calls++;
      return new Response('unauthorized', { status: 401 });
    } });
    await expect(reviewPullRequest({ db, llm, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 })).rejects.toThrow('401');
    expect(calls).toBe(1);
    expect(gh.reviews).toHaveLength(0);
  });

  it('abandons retries if the PR changes after an invalid response', async () => {
    const gh = fakeGithub();
    let calls = 0;
    const llm = { ...fakeLlm().provider, name: 'openrouter', model: 'qwen/qwen3-coder', supportsBatchReview: true, complete: async () => {
      calls++;
      gh.github.getPull = async () => ({ ...PR, headSha: 'moved' });
      return '{}';
    } };
    await expect(reviewPullRequest({ db, llm, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 })).rejects.toBeInstanceOf(ReviewSupersededError);
    expect(calls).toBe(1);
    expect(gh.reviews).toHaveLength(0);
  });

  it.each(['qwen/qwen3-coder-next', 'other/coder'])('batches reviews for %s without a model-name special case', async (model) => {
    const gh = fakeGithub(DIFF, PR, {
      historyCommits: [{ sha: 'history-commit', message: 'history', htmlUrl: 'https://github.com/o/r/commit/history-commit' }],
      historyPulls: [{ number: 7, title: 'Old fix', body: 'Historical description', htmlUrl: 'https://github.com/o/r/pull/7', mergedAt: '2025-01-01', repository: 'o/r' }],
    });
    const calls: CompleteRequest[] = [];
    const llm = new OpenRouterProvider({ apiKey: 'fake', model, fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe(model);
      expect(body.provider.max_price).toEqual({ prompt: 0.4, completion: 2, request: 0 });
      expect(body.messages[0].content).toBe(BATCH_REVIEW_SYSTEM_PROMPT);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ findings: [], summary: 'Complete.', verdict: 'approve', reviewedPaths: ['src/app.ts', 'src/gone.ts'] }) }, finish_reason: 'stop' }] }));
    } });
    const wrapped = { name: llm.name, model: llm.model, concurrency: llm.concurrency, supportsBatchReview: true,
      complete: (req: CompleteRequest) => { calls.push(req); return llm.complete(req); } };
    const result = await reviewPullRequest({ db, llm: wrapped, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 });
    expect(result.posted).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.messages[0]!.content).toContain('Historical description');
  });

  it.each(['408', '429', '503', 'timeout', 'invalid', 'truncated', 'missing content', 'invalid finding'])('falls back on %s with the same prompt and attributes the actual model', async (failure) => {
    const gh = fakeGithub(DIFF, PR, {
      historyCommits: [{ sha: 'history-commit', message: 'history', htmlUrl: 'https://github.com/o/r/commit/history-commit' }],
      historyPulls: [{ number: 7, title: 'Old fix', body: 'Historical description', htmlUrl: 'https://github.com/o/r/pull/7', mergedAt: '2025-01-01', repository: 'o/r' }],
    });
    const tracker = new UsageTracker({ db, pricing: null });
    const sent: Array<{ model: string; messages: unknown; provider: unknown }> = [];
    const response = (content: string, finish_reason = 'stop') => new Response(JSON.stringify({
      choices: [{ message: { content }, finish_reason }],
      usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.01 },
    }));
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      sent.push(body);
      if (body.model === 'qwen/qwen3-coder') {
        if (failure === '408' || failure === '429' || failure === '503') return new Response('unavailable', { status: Number(failure) });
        if (failure === 'timeout') throw new Error('timeout');
        if (failure === 'missing content') return new Response(JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.01 } }));
        if (failure === 'invalid finding') return response(JSON.stringify({ findings: [{ path: 'src/app.ts', line: 999, severity: 'critical', title: 'Bad', body: 'Fix' }], summary: 'Complete.', verdict: 'request_changes', reviewedPaths: ['src/app.ts', 'src/gone.ts'] }));
        return response('{}', failure === 'truncated' ? 'length' : 'stop');
      }
      return response(JSON.stringify({ findings: [], summary: 'Complete.', verdict: 'approve', reviewedPaths: ['src/app.ts', 'src/gone.ts'] }));
    };
    const fallback = new OpenRouterProvider({ apiKey: 'fake', model: 'qwen/qwen3-coder-next', fetch, onUsage: tracker.sinkFor('review') });
    const llm = Object.assign(new OpenRouterProvider({ apiKey: 'fake', model: 'qwen/qwen3-coder', fetch, onUsage: tracker.sinkFor('review') }), { reviewFallbacks: [fallback] });
    const result = await reviewPullRequest({ db, llm, sleep: async () => {}, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42, post: false });
    expect(sent.map((r) => r.model)).toEqual(['qwen/qwen3-coder', 'qwen/qwen3-coder-next']);
    if (['invalid', 'truncated', 'missing content', 'invalid finding'].includes(failure)) {
      expect(JSON.stringify(sent[1]!.messages)).toContain('validationError');
    } else {
      expect(sent[1]!.messages).toEqual(sent[0]!.messages);
    }
    expect(JSON.stringify(sent[1]!.messages)).toContain('Historical description');
    expect(sent.every((r) => (r.provider as { allow_fallbacks: boolean }).allow_fallbacks === true)).toBe(true);
    expect(result.warnings.join(' ')).toContain('qwen/qwen3-coder-next');
    expect(db.getReview(result.reviewId)?.model).toBe('qwen/qwen3-coder-next');
    if (['invalid', 'truncated', 'missing content', 'invalid finding'].includes(failure)) {
      expect(db.getReview(result.reviewId)?.cost_usd).toBeCloseTo(0.02);
      expect((await tracker.report(1)).rows.map((r) => r.model).sort()).toEqual(['qwen/qwen3-coder', 'qwen/qwen3-coder-next']);
    } else {
      expect(db.getReview(result.reviewId)?.cost_usd).toBeNull();
    }
    // Posting a saved review later must preserve the generating model.
    await reviewPullRequest({ db, llm, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 });
    expect(sent).toHaveLength(2);
    expect(gh.reviews[0]!.input.body).toContain('qwen/qwen3-coder-next');
  });

  it.each([400, 401, 402, 403])('does not fall back on HTTP %s', async (status) => {
    const gh = fakeGithub();
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => { calls++; return new Response('rejected', { status }); };
    const fallback = new OpenRouterProvider({ apiKey: 'fake', model: 'qwen/qwen3-coder-next', fetch });
    const llm = Object.assign(new OpenRouterProvider({ apiKey: 'fake', model: 'qwen/qwen3-coder', fetch }), { reviewFallbacks: [fallback] });
    await expect(reviewPullRequest({ db, llm, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 })).rejects.toThrow(`HTTP ${status}`);
    expect(calls).toBe(1);
    expect(gh.reviews).toHaveLength(0);
  });

  it.each([0, 1, 3])('stops the fallback chain at the shared retry limit %s', async (maxRetries) => {
    const gh = fakeGithub();
    const models: string[] = [];
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      models.push(JSON.parse(String(init?.body)).model);
      return new Response('unavailable', { status: 503 });
    };
    const alternatives = ['second/coder', 'third/coder'].map((model) => new OpenRouterProvider({ apiKey: 'fake', model, fetch }));
    const llm = Object.assign(new OpenRouterProvider({ apiKey: 'fake', model: 'first/coder', fetch }), { reviewFallbacks: alternatives });
    await expect(reviewPullRequest({ db, llm, maxRetries, retrieve: retrieveOne, github: gh.github, statusContext: 'repolens/review' }, { repoId: REPO_ID, prNumber: 42 })).rejects.toThrow('503');
    expect(models).toEqual(['first/coder', 'second/coder', 'third/coder', 'third/coder'].slice(0, maxRetries + 1));
    expect(gh.reviews).toHaveLength(0);
    expect(gh.statuses.map((s) => s.input.state)).toEqual(['pending', 'error']);
  });

  it('starts each review at the primary without mutating shared providers', async () => {
    const gh = fakeGithub();
    const models: string[] = [];
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      const model = JSON.parse(String(init?.body)).model;
      models.push(model);
      if (models.length === 1) return new Response('unavailable', { status: 503 });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ findings: [], summary: 'Complete.', verdict: 'approve', reviewedPaths: ['src/app.ts', 'src/gone.ts'] }) }, finish_reason: 'stop' }] }));
    };
    const llm = Object.assign(new OpenRouterProvider({ apiKey: 'fake', model: 'first/coder', fetch }), {
      reviewFallbacks: [new OpenRouterProvider({ apiKey: 'fake', model: 'second/coder', fetch })],
    });
    const deps = { db, llm, retrieve: retrieveOne, github: gh.github };
    await reviewPullRequest(deps, { repoId: REPO_ID, prNumber: 42, post: false });
    await reviewPullRequest(deps, { repoId: REPO_ID, prNumber: 42, force: true, post: false });
    expect(models).toEqual(['first/coder', 'second/coder', 'first/coder']);
    expect(llm.model).toBe('first/coder');
  });

  it('abandons the review without posting when the PR head moves mid-review', async () => {
    const llm = fakeLlm();
    const gh = fakeGithub();
    let calls = 0;
    gh.github.getPull = async () => (calls++ === 0 ? PR : { ...PR, headSha: 'moved' });
    await expect(
      reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github, statusContext: 'repolens/review' }, { repoId: REPO_ID, prNumber: 42 }),
    ).rejects.toBeInstanceOf(ReviewSupersededError);
    expect(llm.fileCalls()).toHaveLength(0);
    expect(gh.reviews).toHaveLength(0);
    expect(gh.statuses.map((s) => s.input.state)).toEqual(['pending']);
    expect(db.findReview(REPO_ID, 42, PR.headSha)).toBeUndefined();
  });

  it('fails closed when a finding points outside the reviewable diff', async () => {
    const llm = fakeLlm({ allowDeleted: true,
      file: JSON.stringify({
        findings: [
          { line: 4, severity: 'critical', title: 'Assignment in condition', body: 'Use `===`.' },
          { line: 999, severity: 'warning', title: 'Not in diff', body: 'nope' },
          { line: 5, severity: 'warning', title: 'Context line', body: 'not an added line' },
        ],
      }),
      summary: '{"summary":"Adds a guard.","verdict":"request_changes"}',
    });
    const gh = fakeGithub();
    await expect(reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, {
      repoId: REPO_ID,
      prNumber: 42,
    })).rejects.toThrow('invalid finding line');
  });

  it('reviews only reviewable files and reports the rest as skipped', async () => {
    const llm = fakeLlm();
    const gh = fakeGithub();
    const res = await reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, {
      repoId: REPO_ID,
      prNumber: 42,
    });
    expect(llm.fileCalls()).toHaveLength(2);
    expect(llm.fileCalls().some((call) => call.messages[0]!.content.includes('src/app.ts'))).toBe(true);
    expect(res.skippedFiles.sort()).toEqual(['assets/logo.png', 'package-lock.json']);
  });

  it('posts a review with the head sha and severity-tagged inline comments', async () => {
    const llm = fakeLlm({
      file: JSON.stringify({ findings: [{ line: 4, severity: 'critical', title: 'Assignment', body: 'Use `===`.' }] }),
    });
    const gh = fakeGithub();
    const res = await reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, {
      repoId: REPO_ID,
      prNumber: 42,
    });

    expect(gh.reviews).toHaveLength(1);
    const { owner, repo, number, input } = gh.reviews[0]!;
    expect({ owner, repo, number }).toEqual({ owner: 'o', repo: 'r', number: 42 });
    expect(input.commitId).toBe('head-sha-1');
    expect(input.event).toBe('REQUEST_CHANGES');
    expect(input.comments).toHaveLength(1);
    expect(input.comments[0]).toMatchObject({ path: 'src/app.ts', line: 4, body: expect.stringContaining('**[critical] Assignment**\n\nUse `===`.') });
    expect(input.comments[0]!.body).toMatch(/repolens-root-cause:[a-f0-9]{16}/);
    expect(input.body).toContain('## RepoLens review');
    expect(input.body).toContain('| critical | src/app.ts:4 | Assignment |');
    expect(res.posted).toBe(true);
    expect(res.reviewUrl).toContain('pullrequestreview-7');
    expect(db.getReview(res.reviewId)!.posted).toBe(1);
  });

  it('posts REQUEST_CHANGES only when the verdict says so', async () => {
    const llm = fakeLlm({
      file: JSON.stringify({ findings: [{ line: 3, severity: 'critical', title: 'Bad', body: 'boom' }] }),
      summary: '{"summary":"Risky.","verdict":"request_changes"}',
    });
    const gh = fakeGithub();
    await reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 });
    expect(gh.reviews[0]!.input.event).toBe('REQUEST_CHANGES');
  });

  it('never sends APPROVE: an approve verdict posts as COMMENT', async () => {
    const llm = fakeLlm({ summary: '{"summary":"Looks good.","verdict":"approve"}' });
    const gh = fakeGithub();
    const res = await reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, {
      repoId: REPO_ID,
      prNumber: 42,
    });
    expect(res.verdict).toBe('approve');
    expect(gh.reviews[0]!.input.event).toBe('COMMENT');
  });

  it('downgrades request_changes to comment when there is no critical finding', async () => {
    const llm = fakeLlm({
      file: JSON.stringify({ findings: [{ line: 4, severity: 'nit', title: 'Minor', body: 'meh' }] }),
      summary: '{"summary":"Small change.","verdict":"request_changes"}',
    });
    const gh = fakeGithub();
    const res = await reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, {
      repoId: REPO_ID,
      prNumber: 42,
    });
    expect(res.verdict).toBe('comment');
    expect(gh.reviews[0]!.input.event).toBe('COMMENT');
  });

  it('does not post when post:false', async () => {
    const llm = fakeLlm();
    const gh = fakeGithub();
    const res = await reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, {
      repoId: REPO_ID,
      prNumber: 42,
      post: false,
    });
    expect(gh.reviews).toHaveLength(0);
    expect(res.posted).toBe(false);
    expect(db.getReview(res.reviewId)!.posted).toBe(0);
  });

  it('returns the cached review for the same head sha without calling the LLM again', async () => {
    const llm = fakeLlm({
      file: JSON.stringify({ findings: [{ line: 4, severity: 'warning', title: 'Hmm', body: 'check' }] }),
    });
    const gh = fakeGithub();
    const deps = { db, llm: llm.provider, retrieve: retrieveOne, github: gh.github };
    const first = await reviewPullRequest(deps, { repoId: REPO_ID, prNumber: 42 });
    const callsAfterFirst = llm.calls.length;

    const second = await reviewPullRequest(deps, { repoId: REPO_ID, prNumber: 42 });
    expect(llm.calls).toHaveLength(callsAfterFirst);
    expect(gh.reviews).toHaveLength(1);
    expect(second.reviewId).toBe(first.reviewId);
    expect(second.posted).toBe(true);
    expect(second.findings).toEqual(first.findings);
    expect(second.verdict).toBe(first.verdict);
  });

  it('derives the cached verdict from the accepted findings', async () => {
    const llm = fakeLlm({
      file: JSON.stringify({ findings: [{ line: 4, severity: 'critical', title: 'Critical issue', body: 'Fix it.' }] }),
      summary: JSON.stringify({ summary: 'Approve this.', verdict: 'approve' }),
    });
    const deps = { db, llm: llm.provider, retrieve: retrieveOne, github: fakeGithub().github };
    const first = await reviewPullRequest(deps, { repoId: REPO_ID, prNumber: 42, post: false });
    expect(first.verdict).toBe('request_changes');
    db.raw.prepare('update reviews set verdict=? where id=?').run('approve', first.reviewId);
    const second = await reviewPullRequest(deps, { repoId: REPO_ID, prNumber: 42, post: false });
    expect(second.verdict).toBe('request_changes');
  });

  it('re-reviews when force is set', async () => {
    const llm = fakeLlm();
    const gh = fakeGithub();
    const deps = { db, llm: llm.provider, retrieve: retrieveOne, github: gh.github };
    const first = await reviewPullRequest(deps, { repoId: REPO_ID, prNumber: 42 });
    const second = await reviewPullRequest(deps, { repoId: REPO_ID, prNumber: 42, force: true });
    expect(second.reviewId).not.toBe(first.reviewId);
    expect(gh.reviews).toHaveLength(2);
  });

  it('fails closed when a file review returns garbage', async () => {
    const llm = fakeLlm({ file: 'I am not JSON at all.' });
    const gh = fakeGithub();
    await expect(reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, {
      repoId: REPO_ID,
      prNumber: 42,
    })).rejects.toThrow('file review failed');
    expect(gh.reviews).toHaveLength(0);
  });

  it('uses a deterministic summary without a non-batch summary call', async () => {
    const llm = fakeLlm({
      file: JSON.stringify({ findings: [{ line: 4, severity: 'warning', title: 'Hmm', body: 'check' }] }),
      summary: 'not json',
    });
    const gh = fakeGithub();
    const result = await reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, {
      repoId: REPO_ID,
      prNumber: 42,
    });
    expect(result.summary).toContain('The review found 1 actionable issue');
    expect(llm.calls.every((call) => call.system !== SUMMARY_SYSTEM_PROMPT && call.system !== FOLLOWUP_SUMMARY_SYSTEM_PROMPT)).toBe(true);
  });

  it('passes repo instructions and retrieved context to the file prompt', async () => {
    db.setRepoInstructions(REPO_ID, 'Always check for SQL injection.');
    const llm = fakeLlm();
    const gh = fakeGithub();
    await reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 });
    const msg = llm.fileCalls().find((call) => call.messages[0]!.content.includes('File under review: src/app.ts'))!.messages[0]!.content;
    expect(msg).toContain('Always check for SQL injection.');
    expect(msg).not.toContain('src/x.ts:1-3');
    expect(msg).toContain('if (n = 0) return;');
    expect(llm.fileCalls()[0]!.json).toBe(true);
    expect(llm.fileCalls()[0]!.maxTokens).toBe(2000);
  });

  it('builds the retrieval query from the path and added-line identifiers', async () => {
    const seen: string[] = [];
    const lexicalOnlyRequests: (boolean | undefined)[] = [];
    const retrieve: RetrieveFn = async (req) => {
      lexicalOnlyRequests.push(req.lexicalOnly);
      seen.push(req.query);
      // Every changed path, including the ones that are not reviewed: their index
      // chunks describe the base branch, not this PR.
      expect(req.excludePaths).toEqual(['src/app.ts', 'package-lock.json', 'assets/logo.png']);
      expect(req.limit).toBe(8);
      expect(req.repoIds).toEqual([REPO_ID]);
      return [];
    };
    const llm = fakeLlm();
    await reviewPullRequest({ db, llm: llm.provider, retrieve, github: fakeGithub().github }, { repoId: REPO_ID, prNumber: 42 });
    expect(seen).toContain('run');
    expect(seen.some((query) => query.includes('gone'))).toBe(true);
    expect(seen).not.toContain('number');
    expect(seen.length).toBeLessThanOrEqual(9);
    expect(lexicalOnlyRequests.every((value) => value === undefined)).toBe(true);
  });

  it.each([false, true])('includes test context keywords in %s batch mode queries', async (batch) => {
    const diff = [
      'diff --git a/src/app.ts b/src/app.ts', '--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1 +1 @@', '-old', '+runThing();',
      'diff --git a/tests/app.test.ts b/tests/app.test.ts', '--- a/tests/app.test.ts', '+++ b/tests/app.test.ts', '@@ -1 +1 @@', '-old', '+runThing();',
    ].join('\n');
    const queries: string[] = [];
    const fake = fakeLlm();
    const llm: LLMProvider = batch ? { ...fake.provider, supportsBatchReview: true, async complete(req) {
      if (req.system === BATCH_REVIEW_SYSTEM_PROMPT) return JSON.stringify({ reviewedPaths: ['src/app.ts', 'tests/app.test.ts'], summary: 'Reviewed.', verdict: 'approve', findings: [] });
      return fake.provider.complete(req);
    } } : fake.provider;
    const matchingTest = { ...CHUNK, chunkId: 99, path: 'tests/other.test.ts', content: 'runThing() assertion' };
    const noisySources = Array.from({ length: 8 }, (_, i) => ({ ...CHUNK, chunkId: 100 + i, path: `src/helper${i}.ts`, content: 'runThing() implementation' }));
    await reviewPullRequest({ db, llm, retrieve: async (req) => {
      queries.push(req.query);
      return req.query.includes('test') ? [...noisySources, matchingTest] : [];
    }, github: fakeGithub(diff).github }, { repoId: REPO_ID, prNumber: 42, post: false });
    expect(queries.some((query) => query.includes('test'))).toBe(true);
    if (!batch) {
      expect(fake.calls.some((call) => call.messages[0]!.content.includes('tests/other.test.ts:1-3'))).toBe(true);
      expect(fake.calls.every((call) => !call.messages[0]!.content.includes('src/helper0.ts:1-3') || call.messages[0]!.content.includes('tests/other.test.ts:1-3'))).toBe(true);
    }
  });

  it('fails closed on maxFiles overflow for every provider', async () => {
    const llm = fakeLlm();
    const gh = fakeGithub();
    await expect(reviewPullRequest(
      { db, llm: llm.provider, retrieve: retrieveOne, github: gh.github, maxFiles: 0 },
      { repoId: REPO_ID, prNumber: 42 },
    )).rejects.toThrow('file limit');
    expect(llm.fileCalls()).toHaveLength(0);
  });

  it('reviews deleted source files and keeps findings in the body', async () => {
    const llm = fakeLlm({ allowDeleted: true,
      file: JSON.stringify({ findings: [{ line: 1, severity: 'critical', title: 'Auth bypass', body: 'Do not remove this check.' }] }),
    });
    const gh = fakeGithub(DIFF);
    const res = await reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, {
      repoId: REPO_ID, prNumber: 42,
    });
    const finding = res.findings.find((f) => f.path === 'src/gone.ts');
    expect(finding).toMatchObject({ line: 0, severity: 'critical' });
    expect(gh.reviews[0]!.input.comments.some((c) => c.path === 'src/gone.ts')).toBe(false);
    expect(gh.reviews[0]!.input.body).toContain('Auth bypass');
  });

  it('reviews deletion-only auth removal and blocks without inline comments', async () => {
    const diff = 'diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,2 +1 @@\n-checkAuth();\n serve();\n';
    const llm = fakeLlm({ file: JSON.stringify({ findings: [{ line: 1, severity: 'critical', title: 'Auth removed', body: 'Restore the check.' }] }) });
    const gh = fakeGithub(diff);
    const result = await reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github, statusContext: 'repolens/review' }, { repoId: REPO_ID, prNumber: 42 });
    expect(llm.fileCalls()).toHaveLength(1);
    expect(result.status?.state).toBe('failure');
    expect(result.findings[0]).toMatchObject({ path: 'src/auth.ts', line: 0 });
    expect(gh.reviews[0]!.input.comments).toEqual([]);
    expect(gh.reviews[0]!.input.body).toContain('Restore the check.');
  });

  it.each(['provider failure', 'invalid severity'])('reports error and does not cache success on %s', async (failure) => {
    const llm = fakeLlm({ file: () => {
      if (failure === 'provider failure') throw new Error('unavailable');
      return JSON.stringify({ findings: [{ line: 4, severity: 'severe', title: 'Auth removed', body: 'Restore the check.' }] });
    } });
    const gh = fakeGithub();
    await expect(reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github, statusContext: 'repolens/review' }, { repoId: REPO_ID, prNumber: 42 })).rejects.toThrow('file review failed');
    expect(gh.statuses.map((s) => s.input.state)).toEqual(['pending', 'error']);
    expect(db.findReview(REPO_ID, 42, PR.headSha)).toBeUndefined();
    expect(gh.reviews).toEqual([]);
  });

  it('carries partial cost and trace telemetry on terminal provider failures', async () => {
    const llm: LLMProvider = {
      name: 'openrouter', model: 'qwen', concurrency: 1, supportsBatchReview: true,
      async complete() { throw new ProviderError('openrouter', 'fatal', 400); },
    };
    await expect(reviewPullRequest({ db, llm, retrieve: retrieveOne, github: fakeGithub().github }, {
      repoId: REPO_ID, prNumber: 42, fresh: true, post: false,
    })).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ReviewExecutionError);
      const telemetry = (error as ReviewExecutionError).telemetry;
      expect(telemetry.headSha).toBe(PR.headSha);
      expect(telemetry.costUsd).toBeNull();
      expect(telemetry.trace?.identity).toMatchObject({ repoId: REPO_ID, prNumber: 42, headSha: PR.headSha });
      expect(telemetry.trace?.stages[0]?.calls[0]).toMatchObject({ stage: 'initial', outcome: 'error', model: 'qwen' });
      return true;
    });
  });

  it('reviews deleted source files in Qwen batch mode and blocks on body findings', async () => {
    const deleted = [
      'diff --git a/src/auth.ts b/src/auth.ts', 'deleted file mode 100644',
      '--- a/src/auth.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@',
      '-checkAuth(user);', '-return secret;', '',
    ].join('\n');
    const llm = { ...fakeLlm().provider, name: 'openrouter', model: 'qwen/qwen3-coder', supportsBatchReview: true, complete: async (req: CompleteRequest) => {
      if (req.system === BATCH_REVIEW_SYSTEM_PROMPT) return JSON.stringify({
        reviewedPaths: ['src/auth.ts'], summary: 'Removed auth.', verdict: 'request_changes',
        findings: [{ path: 'src/auth.ts', line: 1, severity: 'critical', title: 'Auth removed', body: 'Restore the check.' }],
      });
      throw new Error('unexpected call');
    } };
    const gh = fakeGithub(deleted);
    const res = await reviewPullRequest({ db, llm, retrieve: retrieveOne, github: gh.github, statusContext: 'repolens/review' }, {
      repoId: REPO_ID, prNumber: 42,
    });
    expect(res.findings).toMatchObject([{ path: 'src/auth.ts', line: 0, severity: 'critical' }]);
    expect(res.status).toEqual({ state: 'failure', description: '1 critical' });
    expect(gh.reviews[0]!.input.comments).toEqual([]);
    expect(gh.reviews[0]!.input.body).toContain('Auth removed');
  });

  it('keeps the stored review and warns when posting throws', async () => {
    const llm = fakeLlm({
      file: JSON.stringify({ findings: [{ line: 4, severity: 'warning', title: 'Hmm', body: 'check' }] }),
    });
    const gh = fakeGithub(DIFF, PR, { createReviewError: () => new Error('GitHub 502 POST reviews') });
    const res = await reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, {
      repoId: REPO_ID,
      prNumber: 42,
    });

    expect(res.posted).toBe(false);
    expect(res.reviewUrl).toBeUndefined();
    expect(res.warnings.some((w) => w.includes('GitHub 502'))).toBe(true);
    const row = db.getReview(res.reviewId)!;
    expect(row.posted).toBe(0);
    expect(row.status).toBe('done');
  });

  it('retries the post for a cached review that was never posted, without calling the LLM', async () => {
    const llm = fakeLlm({
      file: JSON.stringify({ findings: [{ line: 4, severity: 'warning', title: 'Hmm', body: 'check' }] }),
    });
    let fail = true;
    const gh = fakeGithub(DIFF, PR, { createReviewError: () => (fail ? new Error('boom') : null) });
    const deps = { db, llm: llm.provider, retrieve: retrieveOne, github: gh.github };

    const first = await reviewPullRequest(deps, { repoId: REPO_ID, prNumber: 42 });
    expect(first.posted).toBe(false);
    expect(gh.reviews).toHaveLength(0);
    const callsAfterFirst = llm.calls.length;

    fail = false;
    const second = await reviewPullRequest(deps, { repoId: REPO_ID, prNumber: 42 });
    expect(llm.calls).toHaveLength(callsAfterFirst);
    expect(second.reviewId).toBe(first.reviewId);
    expect(second.posted).toBe(true);
    expect(second.findings).toEqual(first.findings);
    expect(gh.reviews).toHaveLength(1);
    expect(gh.reviews[0]!.input.comments).toHaveLength(1);
    expect(db.getReview(second.reviewId)!.posted).toBe(1);
  });

  it('drops findings that already have an identical review comment', async () => {
    const llm = fakeLlm({
      file: JSON.stringify({
        findings: [
          { line: 4, severity: 'warning', title: 'Assignment in condition', body: 'Use `===`.' },
          { line: 3, severity: 'nit', title: 'Fresh one', body: 'new' },
        ],
      }),
    });
    const gh = fakeGithub(DIFF, PR, {
      existingComments: [
        { path: 'src/app.ts', line: 4, body: '**[warning] Assignment in condition**\n\nUse `===`.', user: 'repolens[bot]' },
      ],
    });
    const res = await reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, {
      repoId: REPO_ID,
      prNumber: 42,
    });

    expect(gh.listCalls).toEqual([{ owner: 'o', repo: 'r', number: 42 }]);
    expect(res.findings).toHaveLength(2);
    expect(gh.reviews[0]!.input.comments).toHaveLength(1);
    expect(gh.reviews[0]!.input.comments[0]).toMatchObject({ path: 'src/app.ts', line: 3, body: expect.stringContaining('**[nit] Fresh one**\n\nnew') });
    expect(res.warnings).toContain('Skipped 1 findings already commented');
  });

  it('posts every finding when listing existing comments fails', async () => {
    const llm = fakeLlm({
      file: JSON.stringify({ findings: [{ line: 4, severity: 'warning', title: 'Hmm', body: 'check' }] }),
    });
    const gh = fakeGithub(DIFF, PR, { listError: new Error('GitHub 403 GET comments') });
    const res = await reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, {
      repoId: REPO_ID,
      prNumber: 42,
    });
    expect(res.posted).toBe(true);
    expect(gh.reviews[0]!.input.comments).toHaveLength(1);
    expect(res.warnings.some((w) => w.includes('GitHub 403'))).toBe(true);
  });

  it('notes in the body when the index is older than the PR base', async () => {
    db.setRepoStatus(REPO_ID, 'ready', { last_commit: 'older-commit-sha' });
    const llm = fakeLlm();
    const gh = fakeGithub();
    await reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 });
    expect(gh.reviews[0]!.input.body).toContain('<sub>Context indexed at older-c; PR base is base-sh.</sub>');
  });

  it('warns when the repository has never been indexed', async () => {
    db.setRepoStatus(REPO_ID, 'queued', { last_commit: null });
    const llm = fakeLlm();
    const gh = fakeGithub();
    const res = await reviewPullRequest({ db, llm: llm.provider, retrieve: retrieveOne, github: gh.github }, {
      repoId: REPO_ID,
      prNumber: 42,
    });
    expect(res.warnings).toContain('Repository has not been indexed; review ran without codebase context.');
    expect(gh.reviews[0]!.input.body).not.toContain('Context indexed at');
  });

  it('throws for an unknown repo', async () => {
    await expect(reviewPullRequest(makeDeps(db), { repoId: 'github:nope/nope', prNumber: 1 })).rejects.toThrow(/Unknown repo/);
  });
});

describe('reviewPullRequest PR-head context', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
    db.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    db.setRepoStatus(REPO_ID, 'ready', { last_commit: PR.baseSha });
  });
  afterEach(() => db.close());

  // a.ts uses a helper that b.ts adds in this same PR: the index still has the old b.ts.
  const TWO_FILE_DIFF = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,3 @@',
    " import { helper } from './b.js';",
    ' ',
    '+export const value = helper(2);',
    'diff --git a/src/b.ts b/src/b.ts',
    '--- a/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -1,1 +1,3 @@',
    ' export const base = 1;',
    '+',
    '+export function helper(n: number) { return n + base; }',
    '',
  ].join('\n');

  const A_HEAD = "import { helper } from './b.js';\n\nexport const value = helper(2);\n";
  const B_HEAD = 'export const base = 1;\n\nexport function helper(n: number) { return n + base; }\n';
  const HEAD_FILES = { 'src/a.ts': A_HEAD, 'src/b.ts': B_HEAD };

  const AUTHORITATIVE = '## Files changed in this pull request (post-change content, authoritative)';
  const INDEXED = "## Related code from the base-branch index (may not reflect this PR's changes)";

  /** A stale chunk for a changed path plus an unrelated one, filtered like the real retriever. */
  function stalyRetrieve(seen: string[][]): RetrieveFn {
    const chunks: RetrievedChunk[] = [
      { chunkId: 1, repoId: REPO_ID, path: 'src/b.ts', startLine: 1, endLine: 1, content: 'export const base = 1; // STALE b.ts', score: 1 },
      { chunkId: 2, repoId: REPO_ID, path: 'src/other.ts', startLine: 1, endLine: 1, content: 'export const other = 2;', score: 0.5 },
    ];
    return async (req) => {
      seen.push(req.excludePaths ?? []);
      const excluded = new Set(req.excludePaths ?? []);
      return chunks.filter((c) => !excluded.has(c.path));
    };
  }

  it('gives the reviewer the post-change content of the files a change references', async () => {
    const llm = fakeLlm();
    const gh = fakeGithub(TWO_FILE_DIFF, PR, { headFiles: HEAD_FILES });
    const excludes: string[][] = [];
    await reviewPullRequest(
      { db, llm: llm.provider, retrieve: stalyRetrieve(excludes), github: gh.github },
      { repoId: REPO_ID, prNumber: 42 },
    );

    // Lineage reads overview docs at the base sha; the post-change fetches are the head ones.
    const headCalls = gh.contentCalls.filter((c) => c.ref === PR.headSha);
    expect(headCalls.map((c) => c.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);

    const msg = llm.fileCalls().find((c) => c.messages[0]!.content.includes('File under review: src/a.ts'))!.messages[0]!.content;
    // b.ts's new content is present, under the authoritative heading and before the index one.
    expect(msg).toContain(AUTHORITATIVE);
    expect(msg).toContain('### src/b.ts (content after this pull request)');
    expect(msg).toContain('export function helper(n: number) { return n + base; }');
    expect(msg.indexOf(AUTHORITATIVE)).toBeLessThan(msg.indexOf('### src/b.ts (content after this pull request)'));
    expect(msg).not.toContain(INDEXED);
    // The reviewed file's own new content is there too, so the model sees past the hunk.
    expect(msg).toContain('### src/a.ts (content after this pull request; bounded windows)');

    // Every changed path is excluded from retrieval, so no stale chunk survives.
    for (const paths of excludes) expect(paths).toEqual(['src/a.ts', 'src/b.ts']);
    expect(msg).not.toContain('STALE b.ts');
    expect(msg).not.toContain('export const other = 2;');
  });

  it('matches an added identifier to the changed file that exports it', async () => {
    // c.ts has no import of b.ts at all; only the added line mentions `helper`.
    const diff = [
      'diff --git a/src/c.ts b/src/c.ts',
      '--- a/src/c.ts',
      '+++ b/src/c.ts',
      '@@ -1,1 +1,2 @@',
      ' const n = 1;',
      '+const out = helper(n);',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1,1 +1,3 @@',
      ' export const base = 1;',
      '+',
      '+export function helper(n: number) { return n + base; }',
      '',
    ].join('\n');
    const llm = fakeLlm();
    const gh = fakeGithub(diff, PR, { headFiles: { 'src/c.ts': 'const n = 1;\nconst out = helper(n);\n', 'src/b.ts': B_HEAD } });
    await reviewPullRequest({ db, llm: llm.provider, retrieve: async () => [], github: gh.github }, { repoId: REPO_ID, prNumber: 42 });

    const msg = llm.fileCalls().find((c) => c.messages[0]!.content.includes('File under review: src/c.ts'))!.messages[0]!.content;
    expect(msg).toContain('### src/b.ts (content after this pull request)');
    expect(msg).toContain('export function helper(n: number) { return n + base; }');
  });

  it('keeps oversized head content for bounded context, while warning only on fetch failures', async () => {
    const llm = fakeLlm();
    const gh = fakeGithub(TWO_FILE_DIFF, PR, {
      headFiles: { 'src/a.ts': 'x'.repeat(60_001) },
      fileContentError: (p) => (p === 'src/b.ts' ? new Error('GitHub 502 GET contents') : null),
    });
    const res = await reviewPullRequest(
      { db, llm: llm.provider, retrieve: async () => [], github: gh.github },
      { repoId: REPO_ID, prNumber: 42 },
    );

    expect(res.findings).toEqual([]);
    expect(llm.fileCalls()).toHaveLength(2);
    expect(res.warnings.some((w) => w.includes('src/a.ts: post-change content skipped'))).toBe(false);
    expect(res.warnings.some((w) => w.includes('src/b.ts: fetching post-change content failed: GitHub 502'))).toBe(true);
    const msg = llm.fileCalls().find((call) => call.messages[0]!.content.includes('File under review: src/a.ts'))!.messages[0]!.content;
    expect(msg).toContain('### src/a.ts (content after this pull request; bounded windows)');
  });

  it('logs, but does not warn, when a changed file has no content at the head sha', async () => {
    const llm = fakeLlm();
    const gh = fakeGithub(TWO_FILE_DIFF, PR, { headFiles: { 'src/a.ts': A_HEAD } });
    const logs: string[] = [];
    const res = await reviewPullRequest(
      { db, llm: llm.provider, retrieve: async () => [], github: gh.github, log: (m) => logs.push(m) },
      { repoId: REPO_ID, prNumber: 42 },
    );
    expect(res.warnings).toEqual([]);
    expect(logs.some((l) => l.includes('src/b.ts: no post-change content at head-sh'))).toBe(true);
    // a.ts still gets its own content; b.ts is simply not quoted.
    const msg = llm.fileCalls().find((c) => c.messages[0]!.content.includes('File under review: src/a.ts'))!.messages[0]!.content;
    expect(msg).toContain('### src/a.ts (content after this pull request; bounded windows)');
    expect(msg).not.toContain('### src/b.ts');
  });
});

describe('reviewPullRequest lineage', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
    db.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    db.setRepoStatus(REPO_ID, 'ready', { last_commit: PR.baseSha });
  });
  afterEach(() => db.close());

  const DELTA = [
    'diff --git a/src/app.ts b/src/app.ts',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -4,2 +4,2 @@',
    '-  if (n = 0) return;',
    '+  if (n === 0) return;',
    '',
  ].join('\n');

  it('feeds the previous review, the delta and the commits to the prompts and notes the review number in the body', async () => {
    db.insertReview({
      repo_id: REPO_ID, pr_number: 42, head_sha: 'head-sha-0', status: 'done', summary: 'First pass.', verdict: 'request_changes',
      comments_json: JSON.stringify([{ path: 'src/app.ts', line: 5, severity: 'critical', title: 'Assignment in condition', body: 'Use ===.' }]),
      posted: 1, error: null,
    });
    const llm = fakeLlm();
    const gh = fakeGithub(DIFF, PR, {
      commits: [{ sha: 'head-sha-0', message: 'feat: run' }, { sha: 'head-sha-1', message: 'fix: compare' }],
      compare: DELTA,
    });
    const result = await reviewPullRequest(makeDeps(db, { llm: llm.provider, github: gh.github }), { repoId: REPO_ID, prNumber: 42 });

    expect(gh.compareCalls).toEqual([{ base: 'head-sha-0', head: 'head-sha-1' }]);
    const file = llm.fileCalls().find((call) => call.messages[0]!.content.includes('File under review: src/app.ts'))!.messages[0]!.content as string;
    expect(file).toContain('review 1 at head-sh');
    expect(file).toContain('- [critical] src/app.ts:5 — Assignment in condition');
    expect(file).toMatch(/\+\s+if \(n === 0\) return;/);
    expect(file).toContain('- head-sh fix: compare');
    expect(result.summary).toBe('The review found no actionable issues in the supplied changes.');
    expect(gh.reviews[0]!.input.body).toContain('Review 2 of this pull request; 1 commit since head-sh');
    expect(result.warnings).toEqual([]);
  });

  it('uses delta-only summary instructions for batch follow-ups', async () => {
    db.insertReview({ repo_id: REPO_ID, pr_number: 42, head_sha: 'head-sha-0', status: 'done',
      summary: 'Original PR overview.', verdict: 'comment', comments_json: '[]', posted: 1, error: null });
    const calls: CompleteRequest[] = [];
    const llm: LLMProvider = { ...fakeLlm().provider, supportsBatchReview: true, complete: async (req) => {
      calls.push(req);
      return JSON.stringify({ reviewedPaths: ['src/app.ts', 'src/gone.ts'], findings: [],
        summary: 'Since the previous review, the condition now checks equality.', verdict: 'approve' });
    } };
    const gh = fakeGithub(DIFF, PR, { compare: DELTA });
    await reviewPullRequest(makeDeps(db, { llm, github: gh.github }), { repoId: REPO_ID, prNumber: 42 });
    expect(calls[0]!.system).toBe(FOLLOWUP_BATCH_REVIEW_SYSTEM_PROMPT);
    expect(calls[0]!.system).not.toContain('what the pull request changes');
    expect(calls[0]!.messages[0]!.content).not.toContain('Original PR overview.');
    expect(calls[0]!.messages[0]!.content).toContain('if (n === 0) return;');
    expect(gh.reviews[0]!.input.body).toContain('The review found no actionable issues in the supplied changes.');
  });

  it('reads overview docs at the base sha and puts them in the file prompt', async () => {
    const llm = fakeLlm();
    const gh = fakeGithub(DIFF, PR, { headFiles: { 'CLAUDE.md': 'One Node process, no external services.' } });
    await reviewPullRequest(makeDeps(db, { llm: llm.provider, github: gh.github }), { repoId: REPO_ID, prNumber: 42 });
    expect(gh.contentCalls).toContainEqual({ path: 'CLAUDE.md', ref: 'base-sha-1' });
    expect(llm.fileCalls()[0]!.messages[0]!.content).toContain('One Node process, no external services.');
  });

  it('carries no previous review on a first review and does not call compare', async () => {
    const llm = fakeLlm();
    const gh = fakeGithub();
    await reviewPullRequest(makeDeps(db, { llm: llm.provider, github: gh.github }), { repoId: REPO_ID, prNumber: 42 });
    expect(gh.compareCalls).toEqual([]);
    expect(llm.fileCalls()[0]!.messages[0]!.content).not.toContain('Previous RepoLens review');
    expect(gh.reviews[0]!.input.body).not.toContain('Review 1 of');
  });

  it('warns and still reviews when lineage fetches fail', async () => {
    db.insertReview({ repo_id: REPO_ID, pr_number: 42, head_sha: 'head-sha-0', status: 'done', summary: 's', verdict: 'comment', comments_json: '[]', posted: 1, error: null });
    const llm = fakeLlm();
    const gh = fakeGithub(DIFF, PR, {});
    gh.github.listPullCommits = async () => { throw new Error('commits down'); };
    const result = await reviewPullRequest(makeDeps(db, { llm: llm.provider, github: gh.github }), { repoId: REPO_ID, prNumber: 42 });
    expect(result.warnings.join('\n')).toContain('commits down');
    expect(llm.fileCalls()[0]!.messages[0]!.content).toContain('Delta unavailable');
  });

  it('includes relevant historical PR context in per-file review prompts', async () => {
    db.insertReview({ repo_id: REPO_ID, pr_number: 7, head_sha: 'old', status: 'done', summary: 'Old summary', verdict: 'comment',
      comments_json: JSON.stringify([{ path: 'src/app.ts', line: 3, severity: 'warning', title: 'Old issue', body: 'Check this.' }]), posted: 1, error: null });
    const llm = fakeLlm();
    const gh = fakeGithub(DIFF, PR, {
      historyCommits: [{ sha: 'abc1234', message: 'old change', htmlUrl: 'https://github.com/o/r/commit/abc1234' }],
      historyPulls: [{ number: 7, title: 'Old fix', body: 'Description', htmlUrl: 'https://github.com/o/r/pull/7', mergedAt: '2025-01-01', repository: 'o/r' }],
    });
    await reviewPullRequest(makeDeps(db, { llm: llm.provider, github: gh.github }), { repoId: REPO_ID, prNumber: 42, post: false });
    const file = llm.fileCalls().find((call) => call.messages[0]!.content.includes('File under review: src/app.ts'))!.messages[0]!.content;
    expect(file).toContain('[#7 Old fix](https://github.com/o/r/pull/7)');
    expect(file).toContain('[abc1234](https://github.com/o/r/commit/abc1234)');
    expect(file).toContain('Old issue');
  });

  it('adds deduplicated historical context as optional Qwen batch input', async () => {
    const calls: CompleteRequest[] = [];
    const llm: LLMProvider = { name: 'openrouter', model: 'qwen/qwen3-coder', concurrency: 1, supportsBatchReview: true, async complete(req) {
      calls.push(req);
      return JSON.stringify({ reviewedPaths: ['src/app.ts', 'src/gone.ts'], findings: [], summary: 'Reviewed.', verdict: 'approve' });
    } };
    const gh = fakeGithub(DIFF, PR, {
      historyCommits: [{ sha: 'abc1234', message: 'old change', htmlUrl: 'https://github.com/o/r/commit/abc1234' }],
      historyPulls: [{ number: 7, title: 'Old fix', body: 'Description', htmlUrl: 'https://github.com/o/r/pull/7', mergedAt: '2025-01-01', repository: 'o/r' }],
    });
    await reviewPullRequest({ db, llm, retrieve: async () => [], github: gh.github }, { repoId: REPO_ID, prNumber: 42, post: false });
    expect(calls).toHaveLength(1);
    const content = calls[0]!.messages[0]!.content;
    expect(content).toContain('Relevant merged pull requests');
    expect(content.match(/Relevant merged pull requests/g)).toHaveLength(1);
  });

  it('merges rename history into the new-file prompt', async () => {
    const renameDiff = [
      'diff --git a/src/old.ts b/src/new.ts', 'similarity index 80%', 'rename from src/old.ts', 'rename to src/new.ts',
      '--- a/src/old.ts', '+++ b/src/new.ts', '@@ -1,1 +1,2 @@', ' export const value = 1;', '+export const next = 2;', '',
    ].join('\n');
    db.insertReview({ repo_id: REPO_ID, pr_number: 7, head_sha: 'old', status: 'done', summary: 'Old summary', verdict: 'comment',
      comments_json: JSON.stringify([
        { path: 'src/old.ts', line: 1, severity: 'warning', title: 'Old path finding', body: 'Old detail.' },
        { path: 'src/new.ts', line: 2, severity: 'critical', title: 'New path finding', body: 'New detail.' },
      ]), posted: 1, error: null });
    const llm = fakeLlm();
    const gh = fakeGithub(renameDiff, PR, {
      historyCommitsByPath: {
        'src/old.ts': [{ sha: 'old-commit', message: 'old', htmlUrl: 'https://github.com/o/r/commit/old-commit' }],
        'src/new.ts': [{ sha: 'new-commit', message: 'new', htmlUrl: 'https://github.com/o/r/commit/new-commit' }],
      },
      historyPullsByCommit: {
        'old-commit': [{ number: 7, title: 'Old fix', body: 'Description', htmlUrl: 'https://github.com/o/r/pull/7', mergedAt: '2025-01-01', repository: 'o/r' }],
        'new-commit': [{ number: 7, title: 'Old fix', body: 'Description', htmlUrl: 'https://github.com/o/r/pull/7', mergedAt: '2025-01-01', repository: 'o/r' }],
      },
    });
    await reviewPullRequest(makeDeps(db, { llm: llm.provider, github: gh.github }), { repoId: REPO_ID, prNumber: 42, post: false });
    const file = llm.fileCalls()[0]!.messages[0]!.content;
    expect(file).toContain('Old path finding');
    expect(file).toContain('New path finding');
  });

  it('keeps both paths\' historical findings in the Qwen batch context', async () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-a', '+b',
      'diff --git a/src/b.ts b/src/b.ts', '--- a/src/b.ts', '+++ b/src/b.ts', '@@ -1 +1 @@', '-a', '+b', '',
    ].join('\n');
    db.insertReview({ repo_id: REPO_ID, pr_number: 7, head_sha: 'old', status: 'done', summary: 'Old summary', verdict: 'comment',
      comments_json: JSON.stringify([
        { path: 'src/a.ts', line: 1, severity: 'warning', title: 'A finding', body: 'A detail.' },
        { path: 'src/b.ts', line: 1, severity: 'warning', title: 'B finding', body: 'B detail.' },
      ]), posted: 1, error: null });
    const calls: CompleteRequest[] = [];
    const llm: LLMProvider = { name: 'openrouter', model: 'qwen/qwen3-coder', concurrency: 1, supportsBatchReview: true, async complete(req) {
      calls.push(req);
      return JSON.stringify({ reviewedPaths: ['src/a.ts', 'src/b.ts'], findings: [], summary: 'Reviewed.', verdict: 'approve' });
    } };
    const gh = fakeGithub(diff, PR, {
      historyCommitsByPath: {
        'src/a.ts': [{ sha: 'a-commit', message: 'a' }],
        'src/b.ts': [{ sha: 'b-commit', message: 'b' }],
      },
      historyPullsByCommit: {
        'a-commit': [{ number: 7, title: 'Old fix', body: '', htmlUrl: 'https://github.com/o/r/pull/7', mergedAt: '2025-01-01', repository: 'o/r' }],
        'b-commit': [{ number: 7, title: 'Old fix', body: '', htmlUrl: 'https://github.com/o/r/pull/7', mergedAt: '2025-01-01', repository: 'o/r' }],
      },
    });
    await reviewPullRequest({ db, llm, retrieve: async () => [], github: gh.github }, { repoId: REPO_ID, prNumber: 42, post: false });
    expect(calls[0]!.messages[0]!.content).toContain('A finding');
    expect(calls[0]!.messages[0]!.content).toContain('B finding');
  });
});

describe('statusForFindings', () => {
  const critical: Finding = { path: 'a.ts', line: 1, severity: 'critical', title: 'Boom', body: 'b' };
  const warning: Finding = { path: 'a.ts', line: 2, severity: 'warning', title: 'Hmm', body: 'b' };
  const nit: Finding = { path: 'a.ts', line: 3, severity: 'nit', title: 'Tiny', body: 'b' };

  it('fails on criticals in the default mode', () => {
    expect(statusForFindings([critical, warning, warning, nit], 'critical')).toEqual({
      state: 'failure',
      description: '1 critical, 2 warnings, 1 nit',
    });
    expect(statusForFindings([warning, nit], 'critical')).toEqual({ state: 'success', description: '1 warning, 1 nit' });
    expect(statusForFindings([], 'critical')).toEqual({ state: 'success', description: 'No blocking findings' });
  });

  it('fails on warnings too when failOn is warning', () => {
    expect(statusForFindings([warning], 'warning')).toEqual({ state: 'failure', description: '1 warning' });
    expect(statusForFindings([critical], 'warning')).toEqual({ state: 'failure', description: '1 critical' });
    expect(statusForFindings([nit], 'warning')).toEqual({ state: 'success', description: '1 nit' });
  });

  it('never fails when failOn is never', () => {
    expect(statusForFindings([critical, warning], 'never')).toEqual({
      state: 'success',
      description: '1 critical, 1 warning',
    });
    expect(statusForFindings([], 'never')).toEqual({ state: 'success', description: 'No blocking findings' });
  });

  it('defaults to critical', () => {
    expect(statusForFindings([critical]).state).toBe('failure');
    expect(statusForFindings([warning]).state).toBe('success');
  });
});

describe('reviewPullRequest commit statuses', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
    db.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    db.setRepoStatus(REPO_ID, 'ready', { last_commit: PR.baseSha });
  });
  afterEach(() => db.close());

  const CONTEXT = 'repolens/review';
  const criticalFinding = JSON.stringify({
    findings: [{ line: 4, severity: 'critical', title: 'Assignment', body: 'Use `===`.' }],
  });
  const warningFinding = JSON.stringify({
    findings: [{ line: 4, severity: 'warning', title: 'Hmm', body: 'check' }],
  });

  function deps(gh: ReturnType<typeof fakeGithub>, llm: ReturnType<typeof fakeLlm>, overrides: Partial<ReviewDeps> = {}): ReviewDeps {
    return {
      db,
      llm: llm.provider,
      retrieve: retrieveOne,
      github: gh.github,
      statusContext: CONTEXT,
      ...overrides,
    };
  }

  it('posts pending then success for a clean review', async () => {
    const llm = fakeLlm();
    const gh = fakeGithub();
    const res = await reviewPullRequest(deps(gh, llm), { repoId: REPO_ID, prNumber: 42 });

    expect(gh.statuses.map((s) => s.input.state)).toEqual(['pending', 'success']);
    expect(gh.statuses[0]).toEqual({
      owner: 'o',
      repo: 'r',
      sha: 'head-sha-1',
      input: {
        state: 'pending',
        context: CONTEXT,
        description: 'RepoLens review in progress',
        targetUrl: PR.htmlUrl,
      },
    });
    expect(gh.statuses[1]!.input).toEqual({
      state: 'success',
      context: CONTEXT,
      description: 'No blocking findings',
      targetUrl: 'https://github.com/o/r/pull/42#pullrequestreview-7',
    });
    expect(res.status).toEqual({ state: 'success', description: 'No blocking findings' });
    expect(res.warnings).toEqual([]);
  });

  it('fails the check when a critical finding is present', async () => {
    const llm = fakeLlm({ file: criticalFinding });
    const gh = fakeGithub();
    const res = await reviewPullRequest(deps(gh, llm), { repoId: REPO_ID, prNumber: 42 });
    expect(gh.statuses.map((s) => s.input.state)).toEqual(['pending', 'failure']);
    expect(gh.statuses[1]!.input.description).toBe('1 critical');
    expect(res.status).toEqual({ state: 'failure', description: '1 critical' });
  });

  it('fails on a warning only when failOn is warning', async () => {
    const clean = fakeGithub();
    await reviewPullRequest(deps(clean, fakeLlm({ file: warningFinding })), { repoId: REPO_ID, prNumber: 42 });
    expect(clean.statuses[1]!.input.state).toBe('success');

    const strict = fakeGithub();
    const res = await reviewPullRequest(
      deps(strict, fakeLlm({ file: warningFinding }), { failOn: 'warning' }),
      { repoId: REPO_ID, prNumber: 42, force: true },
    );
    expect(strict.statuses[1]!.input).toMatchObject({ state: 'failure', description: '1 warning' });
    expect(res.status!.state).toBe('failure');
  });

  it('always succeeds when failOn is never', async () => {
    const llm = fakeLlm({ file: criticalFinding });
    const gh = fakeGithub();
    const res = await reviewPullRequest(deps(gh, llm, { failOn: 'never' }), { repoId: REPO_ID, prNumber: 42 });
    expect(gh.statuses.map((s) => s.input.state)).toEqual(['pending', 'success']);
    expect(res.status).toEqual({ state: 'success', description: '1 critical' });
  });

  it('reports a single final status for a cached, already posted review', async () => {
    const llm = fakeLlm({ file: criticalFinding });
    const gh = fakeGithub();
    const d = deps(gh, llm);
    await reviewPullRequest(d, { repoId: REPO_ID, prNumber: 42 });
    gh.statuses.length = 0;

    const second = await reviewPullRequest(d, { repoId: REPO_ID, prNumber: 42 });
    expect(gh.statuses).toHaveLength(1);
    expect(gh.statuses[0]!.input).toMatchObject({ state: 'failure', description: '1 critical', targetUrl: PR.htmlUrl });
    expect(second.status).toEqual({ state: 'failure', description: '1 critical' });
  });

  it('sets an error status and rethrows when the review blows up', async () => {
    const llm = fakeLlm();
    const gh = fakeGithub(DIFF, PR, { diffError: new Error('GitHub 500 GET diff') });
    await expect(reviewPullRequest(deps(gh, llm), { repoId: REPO_ID, prNumber: 42 })).rejects.toThrow('GitHub 500 GET diff');
    expect(gh.statuses.map((s) => s.input.state)).toEqual(['pending', 'error']);
    expect(gh.statuses[1]!.input.description).toBe('RepoLens review failed: GitHub 500 GET diff');
  });

  it('sets an error status and rethrows when posting a cached review blows up', async () => {
    const llm = fakeLlm({ file: criticalFinding });
    const gh = fakeGithub();
    const d = deps(gh, llm);
    // Store a review that was never posted, so the next run takes the cached posting path.
    await reviewPullRequest(d, { repoId: REPO_ID, prNumber: 42, post: false });
    gh.statuses.length = 0;

    // A malformed saved finding exercises an unexpected failure while rendering
    // the cached post; metadata now comes from the saved review, not the provider.
    db.raw.prepare('update reviews set comments_json=? where id=?').run('[null]', db.findReview(REPO_ID, 42, PR.headSha)!.id);
    await expect(reviewPullRequest(d, { repoId: REPO_ID, prNumber: 42 })).rejects.toThrow();
    expect(gh.statuses.map((s) => s.input.state)).toEqual(['pending', 'error']);
    expect(gh.statuses[1]!.input.description).toContain('RepoLens review failed:');
  });

  it('truncates a long error description to the 140 characters GitHub allows', async () => {
    const llm = fakeLlm();
    const gh = fakeGithub(DIFF, PR, { diffError: new Error('x'.repeat(300)) });
    await expect(reviewPullRequest(deps(gh, llm), { repoId: REPO_ID, prNumber: 42 })).rejects.toThrow(/x{300}/);
    const description = gh.statuses[1]!.input.description;
    expect(description).toHaveLength(140);
    expect(description.endsWith('…')).toBe(true);
  });

  it('completes the review with a warning when the status endpoint fails', async () => {
    const llm = fakeLlm({ file: criticalFinding });
    const gh = fakeGithub(DIFF, PR, { statusError: new Error('GitHub 403 POST statuses') });
    const res = await reviewPullRequest(deps(gh, llm), { repoId: REPO_ID, prNumber: 42 });

    expect(res.posted).toBe(true);
    expect(gh.reviews).toHaveLength(1);
    // One warning for the pending call, one for the final call.
    const statusWarnings = res.warnings.filter((w) => w.startsWith('posting commit status failed:'));
    expect(statusWarnings).toHaveLength(2);
    expect(statusWarnings[0]).toContain('GitHub 403 POST statuses');
    expect(res.status).toEqual({ state: 'failure', description: '1 critical' });
  });

  it('reports nothing when the status context is blank', async () => {
    const llm = fakeLlm({ file: criticalFinding });
    const gh = fakeGithub();
    const res = await reviewPullRequest(deps(gh, llm, { statusContext: '' }), { repoId: REPO_ID, prNumber: 42 });
    expect(gh.statuses).toEqual([]);
    expect(res.status).toBeUndefined();
  });

  it('does not publish statuses for a fresh dry-run', async () => {
    const llm = fakeLlm();
    const gh = fakeGithub();
    const res = await reviewPullRequest(deps(gh, llm), {
      repoId: REPO_ID, prNumber: 42, fresh: true, post: false,
    });
    expect(gh.statuses).toEqual([]);
    expect(res.status).toBeUndefined();
  });

  it('falls back to the dashboard url when the PR has no html url', async () => {
    const llm = fakeLlm();
    const gh = fakeGithub(DIFF, { ...PR, htmlUrl: '' }, { createReviewError: () => new Error('nope') });
    await reviewPullRequest(deps(gh, llm, { publicUrl: 'https://repolens.example/' }), { repoId: REPO_ID, prNumber: 42 });
    expect(gh.statuses[0]!.input.targetUrl).toBe(`https://repolens.example/#/reviews/${REPO_ID}`);
  });
});

describe('staged review', () => {
  const diff = `diff --git a/src/mixed.ts b/src/mixed.ts
--- a/src/mixed.ts
+++ b/src/mixed.ts
@@ -1,2 +1,2 @@
-const token = oldToken;
+const token = request.token;
 context
@@ -20 +20 @@
-oldCall();
+newCall();
`;
  const paths = ['src/mixed.ts'];
  const finding = (line: number, title: string, confidence = 'high') => ({
    path: 'src/mixed.ts', line, severity: 'warning', title, body: `${title} body`, category: 'correctness', confidence,
    rootCause: title, evidence: { path: 'src/mixed.ts', line, trigger: `${title} trigger`, consequence: `${title} consequence` },
  });

  const candidateDiff = (paths: string[]) => paths.map((path) => [
    `diff --git a/${path} b/${path}`,
    `index ${'1'.repeat(7)}..${'2'.repeat(7)} 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,1 +1,13 @@',
    '-const old = 0;',
    ...Array.from({ length: 13 }, (_, index) => `+if (token) return ${index + 1};`),
  ].join('\n')).join('\n');

  const candidate = (path: string, line: number, rootCause: string, title = rootCause): Finding => ({
    path, line, severity: 'warning', title, body: `${title} body`, category: 'correctness', confidence: 'high', rootCause,
    evidence: { path, line, trigger: `${title} trigger`, consequence: `${title} consequence` },
  });

  async function runCandidateReview(diffText: string, initialFindings: Finding[]) {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    testDb.setRepoStatus(REPO_ID, 'ready', { last_commit: PR.baseSha });
    const paths = [...new Set(initialFindings.map((item) => item.path))];
    let verifierFindings: Finding[] = [];
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete() {
      return JSON.stringify({ reviewedPaths: paths, summary: 'Initial.', verdict: 'request_changes', findings: initialFindings });
    } };
    const escalationLlm: LLMProvider = { ...initial, model: 'strong', async complete(req) {
      const payload = JSON.parse(req.messages[0]!.content) as { provisionalFindings: Array<{ id: string; finding: Finding }> };
      return JSON.stringify({ reviewedPaths: paths, decisions: payload.provisionalFindings.map(({ id }) => ({ id, decision: 'retain' })), findings: payload.provisionalFindings.map(({ finding: item }) => item) });
    } };
    const verifierLlm: LLMProvider = { ...initial, async complete(req) {
      const payload = JSON.parse(req.messages[0]!.content) as { findings: Array<{ finding: Finding }> };
      verifierFindings = payload.findings.map(({ finding: item }) => item);
      return JSON.stringify({ decisions: payload.findings.map(({ finding: item }, id) => ({ id, decision: 'supported', explanation: 'Current evidence supports the finding.', evidence: { path: item.path, line: item.line } })), summary: 'Checked.', verdict: 'comment' });
    } };
    try {
      await reviewPullRequest({ db: testDb, llm: initial, escalationLlm, verifierLlm, retrieve: retrieveOne, github: fakeGithub(diffText, PR).github }, { repoId: REPO_ID, prNumber: 42, post: false, force: true });
      return verifierFindings;
    } finally { testDb.close(); }
  }

  it('deduplicates identical primary and escalation candidates before verification', async () => {
    const item = candidate('src/keycloak.ts', 1, 'same cause');
    const verifierFindings = await runCandidateReview(candidateDiff(['src/keycloak.ts']), [item]);
    expect(verifierFindings).toEqual([item]);
  });

  it('runs local and contract discovery concurrently, unions validated findings, and verifies once', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    testDb.setRepoStatus(REPO_ID, 'ready', { last_commit: PR.baseSha });
    const local = candidate('src/mixed.ts', 1, 'local execution');
    const contract = candidate('src/mixed.ts', 1, 'caller contract');
    const calls: CompleteRequest[] = [];
    let active = 0;
    let maxActive = 0;
    const primary: LLMProvider = { name: 'openrouter', model: 'qwen/qwen3-coder', concurrency: 1, supportsBatchReview: true, async complete(req) {
      calls.push(req);
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      const isContract = req.system?.includes('contract and concurrency');
      return JSON.stringify({ reviewedPaths: paths, summary: 'Discovery.', verdict: 'request_changes', findings: [isContract ? contract : local] });
    } };
    const verifier: LLMProvider = { ...primary, model: 'gpt-5-mini', async complete(req) {
      calls.push(req);
      const payload = JSON.parse(req.messages[0]!.content) as { findings: Array<{ finding: Finding }> };
      expect(payload.findings.map(({ finding }) => finding.rootCause)).toEqual(['local execution', 'caller contract']);
      return JSON.stringify({ decisions: payload.findings.map(({ finding }, id) => ({ id, decision: 'supported', explanation: 'Evidence supports the issue.', evidence: { path: finding.path, line: finding.line } })), summary: 'Checked.', verdict: 'comment' });
    } };
    try {
      const result = await reviewPullRequest({ db: testDb, llm: primary, verifierLlm: verifier, dualDiscovery: true, retrieve: retrieveOne, github: fakeGithub(diff, PR, { headFiles: { 'src/mixed.ts': 'const token = request.token;\nnewCall();' } }).github }, { repoId: REPO_ID, prNumber: 42, post: false, force: true });
      expect(maxActive).toBe(2);
      expect(calls.filter((req) => req.reviewStage === 'initial')).toHaveLength(2);
      expect(calls.filter((req) => req.reviewStage === 'verification')).toHaveLength(1);
      const contractRequest = calls.find((req) => req.system?.includes('contract and concurrency'))!;
      expect(contractRequest.messages[0]!.content).not.toContain('local execution');
      expect(contractRequest.messages[0]!.content).not.toContain('local execution body');
      expect(result.findings.map(({ rootCause }) => rootCause)).toEqual(['caller contract', 'local execution']);
    } finally { testDb.close(); }
  });

  it('fails closed on malformed complementary discovery without spending a serial retry', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    const calls: CompleteRequest[] = [];
    const primary: LLMProvider = { name: 'openrouter', model: 'qwen/qwen3-coder', concurrency: 1, supportsBatchReview: true, async complete(req) {
      calls.push(req);
      return req.system?.includes('contract and concurrency') ? 'not JSON' : JSON.stringify({ reviewedPaths: paths, summary: 'Discovery.', verdict: 'approve', findings: [] });
    } };
    const verifier: LLMProvider = { ...primary, model: 'gpt-5-mini', async complete(req) {
      calls.push(req);
      return JSON.stringify({ decisions: [], summary: 'Checked.', verdict: 'approve' });
    } };
    try {
      await expect(reviewPullRequest({ db: testDb, llm: primary, verifierLlm: verifier, dualDiscovery: true, retrieve: retrieveOne, github: fakeGithub(diff, PR).github }, { repoId: REPO_ID, prNumber: 42, post: false, force: true })).rejects.toThrow(/No JSON object found/);
      expect(calls).toHaveLength(2);
    } finally { testDb.close(); }
  });

  it('keeps Qwen plus verifier on one discovery pass when dual discovery is disabled', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    const item = candidate('src/mixed.ts', 1, 'local only');
    const calls: CompleteRequest[] = [];
    const primary: LLMProvider = { name: 'openrouter', model: 'qwen/qwen3-coder', concurrency: 1, supportsBatchReview: true, async complete(req) {
      calls.push(req);
      return JSON.stringify({ reviewedPaths: paths, summary: 'Discovery.', verdict: 'request_changes', findings: [item] });
    } };
    const verifier: LLMProvider = { ...primary, model: 'gpt-5-mini', async complete(req) {
      calls.push(req);
      return JSON.stringify({ decisions: [{ id: 0, decision: 'supported', explanation: 'Evidence supports it.', evidence: { path: item.path, line: item.line } }], summary: 'Checked.', verdict: 'comment' });
    } };
    try {
      await reviewPullRequest({ db: testDb, llm: primary, verifierLlm: verifier, retrieve: retrieveOne, github: fakeGithub(diff, PR, { headFiles: { 'src/mixed.ts': 'const token = request.token;\nnewCall();' } }).github }, { repoId: REPO_ID, prNumber: 42, post: false, force: true });
      expect(calls.filter((req) => req.reviewStage === 'initial')).toHaveLength(1);
    } finally { testDb.close(); }
  });

  it('deduplicates duplicate B0 candidates before verification', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    testDb.setRepoStatus(REPO_ID, 'ready', { last_commit: PR.baseSha });
    const item = candidate('src/mixed.ts', 1, 'duplicate candidate');
    let verifierCount = 0;
    const primary: LLMProvider = { name: 'openrouter', model: 'qwen', concurrency: 1, supportsBatchReview: true, async complete() {
      return JSON.stringify({ reviewedPaths: ['src/mixed.ts'], summary: 'Initial.', verdict: 'comment', findings: [item, item] });
    } };
    const verifier: LLMProvider = { ...primary, model: 'gpt-5-mini', async complete(req) {
      const payload = JSON.parse(req.messages[0]!.content) as { findings: Array<{ finding: Finding }> };
      verifierCount = payload.findings.length;
      return JSON.stringify({ decisions: payload.findings.map(({ finding }, id) => ({ id, decision: 'supported', explanation: 'Evidence supports it.', evidence: { path: finding.path, line: finding.line } })), summary: 'Checked.', verdict: 'comment' });
    } };
    try {
      await reviewPullRequest({ db: testDb, llm: primary, verifierLlm: verifier, retrieve: retrieveOne, github: fakeGithub(candidateDiff(['src/mixed.ts']), PR).github }, { repoId: REPO_ID, prNumber: 42, post: false, force: true });
      expect(verifierCount).toBe(1);
    } finally { testDb.close(); }
  });

  it('keeps distinct causes at one line and one cause at distinct files and locations', async () => {
    const verifierFindings = await runCandidateReview(candidateDiff(['src/keycloak.ts', 'src/other.ts']), [
      candidate('src/keycloak.ts', 1, 'cause one'),
      candidate('src/keycloak.ts', 1, 'cause two'),
      candidate('src/keycloak.ts', 2, 'cause one'),
      candidate('src/other.ts', 1, 'cause one'),
    ]);
    expect(verifierFindings.map(({ rootCause, path, line }) => `${rootCause}:${path}:${line}`)).toEqual([
      'cause one:src/keycloak.ts:1', 'cause two:src/keycloak.ts:1',
      'cause one:src/keycloak.ts:2', 'cause one:src/other.ts:1',
    ]);
  });

  it('collapses eleven duplicate pairs to eleven verifier candidates', async () => {
    const initial = Array.from({ length: 11 }, (_, index) => candidate('src/discourse.ts', index + 1, `cause ${index + 1}`));
    const verifierFindings = await runCandidateReview(candidateDiff(['src/discourse.ts']), initial);
    expect(verifierFindings).toHaveLength(11);
    expect(new Set(verifierFindings.map(({ rootCause, path, line }) => `${rootCause}:${path}:${line}`)).size).toBe(11);
  });

  it('does not reintroduce a rejected primary through an identical escalation finding', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    testDb.setRepoStatus(REPO_ID, 'ready', { last_commit: PR.baseSha });
    const item = candidate('src/keycloak.ts', 1, 'rejected cause');
    let verifierCalls = 0;
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete() {
      return JSON.stringify({ reviewedPaths: ['src/keycloak.ts'], summary: 'Initial.', verdict: 'request_changes', findings: [item] });
    } };
    const escalationLlm: LLMProvider = { ...initial, model: 'strong', async complete(req) {
      const payload = JSON.parse(req.messages[0]!.content) as { provisionalFindings: Array<{ id: string; finding: Finding }> };
      return JSON.stringify({ reviewedPaths: ['src/keycloak.ts'], decisions: payload.provisionalFindings.map(({ id }) => ({ id, decision: 'reject' })), findings: [item] });
    } };
    const verifierLlm: LLMProvider = { ...initial, async complete() {
      verifierCalls++;
      return JSON.stringify({ decisions: [], summary: 'Checked.', verdict: 'approve' });
    } };
    try {
      const result = await reviewPullRequest({ db: testDb, llm: initial, escalationLlm, verifierLlm, retrieve: retrieveOne, github: fakeGithub(candidateDiff(['src/keycloak.ts']), PR).github }, { repoId: REPO_ID, prNumber: 42, post: false, force: true });
      expect(verifierCalls).toBe(0);
      expect(result.findings).toEqual([]);
    } finally { testDb.close(); }
  });

  it('supplies static facts as advisory evidence to discovery and verification', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    testDb.setRepoStatus(REPO_ID, 'ready', { last_commit: PR.baseSha });
    const item = candidate('src/mixed.ts', 1, 'response contract');
    let verifierPayload: Record<string, unknown> | undefined;
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete(req) {
      expect(req.messages[0]!.content).toContain('Advisory static evidence');
      expect(req.messages[0]!.content).toContain('declared-parameters');
      expect(req.messages[0]!.content).toContain('response-property');
      expect(req.messages[0]!.content).toContain('unawaited-call');
      return JSON.stringify({ reviewedPaths: ['src/mixed.ts'], summary: 'Initial.', verdict: 'comment', findings: [item] });
    } };
    const verifierLlm: LLMProvider = { ...initial, async complete(req) {
      verifierPayload = JSON.parse(req.messages[0]!.content) as Record<string, unknown>;
      return JSON.stringify({ decisions: [{ id: 0, decision: 'supported', explanation: 'The supplied evidence supports the finding.', evidence: { path: item.path, line: item.line } }], summary: 'Checked.', verdict: 'comment' });
    } };
    try {
      await reviewPullRequest({
        db: testDb, llm: initial, verifierLlm, retrieve: retrieveOne,
        github: fakeGithub(candidateDiff(['src/mixed.ts']), PR, { headFiles: {
          'src/mixed.ts': 'function fetchUser(id: string, mode: string) { return id; }\nconst value = response.data;\nsave(value);',
        } }).github,
      }, { repoId: REPO_ID, prNumber: 42, post: false, force: true });
      const facts = verifierPayload?.staticEvidence as Array<{ kind: string }> | undefined;
      expect(facts?.some(({ kind }) => kind === 'declared-parameters')).toBe(true);
      expect(facts?.some(({ kind }) => kind === 'response-property')).toBe(true);
      expect(facts?.some(({ kind }) => kind === 'unawaited-call')).toBe(true);
    } finally { testDb.close(); }
  });

  it('supplies static facts to non-batch per-file discovery', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    testDb.setRepoStatus(REPO_ID, 'ready', { last_commit: PR.baseSha });
    const item = candidate('src/mixed.ts', 1, 'response contract');
    let filePrompt = '';
    const llm: LLMProvider = { name: 'local', model: 'file', concurrency: 1, supportsBatchReview: false, async complete(req) {
      filePrompt = req.messages[0]!.content;
      return JSON.stringify({ findings: [item] });
    } };
    try {
      await reviewPullRequest({
        db: testDb, llm, retrieve: retrieveOne,
        github: fakeGithub(candidateDiff(['src/mixed.ts']), PR, { headFiles: {
          'src/mixed.ts': 'function fetchUser(id: string, mode: string) { return id; }\nconst value = response.data;\nsave(value);',
        } }).github,
      }, { repoId: REPO_ID, prNumber: 42, post: false, force: true });
      expect(filePrompt).toContain('Advisory static evidence');
      expect(filePrompt).toContain('declared-parameters');
      expect(filePrompt).toContain('response-property');
      expect(filePrompt).toContain('unawaited-call');
    } finally { testDb.close(); }
  });

  it('caps verifier static facts globally while retaining candidate-path facts', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    testDb.setRepoStatus(REPO_ID, 'ready', { last_commit: PR.baseSha });
    const target = candidate('src/target.ts', 1, 'target finding');
    const source = Array.from({ length: 50 }, (_, index) => `response.value${index};`).join('\n');
    let verifierPayload: Record<string, unknown> | undefined;
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete() {
      return JSON.stringify({ reviewedPaths: ['src/first.ts', 'src/second.ts', 'src/target.ts'], summary: 'Initial.', verdict: 'comment', findings: [target] });
    } };
    const verifierLlm: LLMProvider = { ...initial, async complete(req) {
      verifierPayload = JSON.parse(req.messages[0]!.content) as Record<string, unknown>;
      return JSON.stringify({ decisions: [{ id: 0, decision: 'supported', explanation: 'The supplied evidence supports the finding.', evidence: { path: target.path, line: target.line } }], summary: 'Checked.', verdict: 'comment' });
    } };
    const multiDiff = candidateDiff(['src/first.ts', 'src/second.ts', 'src/target.ts']);
    try {
      await reviewPullRequest({
        db: testDb, llm: initial, verifierLlm, retrieve: retrieveOne,
        github: fakeGithub(multiDiff, PR, { headFiles: {
          'src/first.ts': source,
          'src/second.ts': source,
          'src/target.ts': source,
        } }).github,
      }, { repoId: REPO_ID, prNumber: 42, post: false, force: true });
      const facts = verifierPayload?.staticEvidence as Array<{ path: string }> | undefined;
      expect(facts).toBeDefined();
      expect(facts!.length).toBeLessThanOrEqual(80);
      expect(facts!.some(({ path }) => path === target.path)).toBe(true);
    } finally { testDb.close(); }
  });

  it('trims escalation context after an unknown-cost initial failure while keeping risky hunks', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    const tracker = new UsageTracker({ db: testDb, pricing: null });
    const initialResponse = JSON.stringify({ reviewedPaths: paths, findings: [], summary: 'Initial.', verdict: 'approve' });
    const calls: CompleteRequest[] = [];
    const primary: LLMProvider = { name: 'openrouter', model: 'primary', concurrency: 1, supportsBatchReview: true, async complete() {
      return 'not JSON';
    } };
    const fallback: LLMProvider = { name: 'openrouter', model: 'fallback', concurrency: 1, supportsBatchReview: true, async complete(req) {
      tracker.sinkFor('review')({ provider: 'openrouter', model: 'fallback', inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1, costUsd: 0.01 });
      calls.push(req);
      return initialResponse;
    } };
    (primary as { reviewFallbacks?: readonly LLMProvider[] }).reviewFallbacks = [fallback];
    const escalation: LLMProvider = { name: 'openrouter', model: 'strong', concurrency: 1, supportsBatchReview: true, async complete(req) {
      tracker.sinkFor('review')({ provider: 'openrouter', model: 'strong', inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1, costUsd: 0.01 });
      calls.push(req);
      return JSON.stringify({ reviewedPaths: paths, findings: [] });
    } };
    const retrieve: RetrieveFn = async () => [{ ...CHUNK, content: `request token ${'x'.repeat(500_000)}` }];
    try {
      const result = await reviewPullRequest({
        db: testDb, llm: primary, escalationLlm: escalation, retrieve,
        github: fakeGithub(diff, PR, { headFiles: { 'src/mixed.ts': 'const token = request.token;\nnewCall();' } }).github,
      }, { repoId: REPO_ID, prNumber: 42, post: false, force: true });
      const escalationRequest = calls.find((call) => call.reviewStage === 'escalation')!;
      const payload = JSON.parse(escalationRequest.messages[0]!.content) as { files: Array<Record<string, unknown>>; rules?: string };
      expect(payload.files[0]).toMatchObject({ path: 'src/mixed.ts', status: 'modified', allowedFindingLines: [1] });
      expect(payload.files[0]!.diff).toContain('request.token');
      expect(payload.files[0]!.relevantContext).toBeUndefined();
      expect(escalationRequest.jsonSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: ['reviewedPaths', 'decisions', 'findings'],
        properties: {
          reviewedPaths: { minItems: paths.length, maxItems: paths.length, items: { enum: paths } },
          findings: { items: { additionalProperties: false, properties: { path: { enum: paths } } } },
        },
      });
      const schema = escalationRequest.jsonSchema as Record<string, any>;
      const evidence = schema.properties.findings.items.properties.evidence;
      expect(evidence).toMatchObject({ additionalProperties: false, required: ['path', 'line', 'trigger', 'consequence', 'rule'] });
      expect(evidence.properties.path.enum).toEqual(paths);
      expect(evidence.properties.rule.anyOf).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'null' }),
        expect.objectContaining({ type: 'object', additionalProperties: false }),
      ]));
      expect(reviewCostUpperBound(escalationRequest) + 0.01).toBeLessThanOrEqual(REVIEW_MAX_USD);
      expect(result.findings).toEqual([]);
    } finally { testDb.close(); }
  });

  it('reports reviewedPaths validation separately for an escalation response', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    const initial: LLMProvider = { name: 'openrouter', model: 'initial', concurrency: 1, supportsBatchReview: true, async complete() {
      return JSON.stringify({ reviewedPaths: paths, findings: [], summary: 'Initial.', verdict: 'approve' });
    } };
    const escalation: LLMProvider = { ...initial, model: 'strong', async complete() {
      return JSON.stringify({ reviewedPaths: [], findings: [] });
    } };
    try {
      await expect(reviewPullRequest({ db: testDb, llm: initial, escalationLlm: escalation, retrieve: async () => [], github: fakeGithub(diff).github }, { repoId: REPO_ID, prNumber: 42, post: false, force: true })).rejects.toThrow(/reviewedPaths/);
    } finally { testDb.close(); }
  });

  it('reports finding path shape validation separately for an escalation response', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    const initial: LLMProvider = { name: 'openrouter', model: 'initial', concurrency: 1, supportsBatchReview: true, async complete() {
      return JSON.stringify({ reviewedPaths: paths, findings: [], summary: 'Initial.', verdict: 'approve' });
    } };
    const escalation: LLMProvider = { ...initial, model: 'strong', async complete() {
      return JSON.stringify({ reviewedPaths: paths, findings: [{}] });
    } };
    try {
      await expect(reviewPullRequest({ db: testDb, llm: initial, escalationLlm: escalation, retrieve: async () => [], github: fakeGithub(diff).github }, { repoId: REPO_ID, prNumber: 42, post: false, force: true })).rejects.toThrow(/finding.*path|findings.*path/i);
    } finally { testDb.close(); }
  });

  it('fails before escalation inference when its core hunks cannot fit the remaining budget', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    const largeDiff = diff.replace('+const token = request.token;', `+const token = request.token;${'x'.repeat(400_000)}`);
    const initial: LLMProvider = { name: 'openrouter', model: 'initial', concurrency: 1, supportsBatchReview: true, async complete() {
      return JSON.stringify({ reviewedPaths: paths, findings: [], summary: 'Initial.', verdict: 'approve' });
    } };
    let escalationCalls = 0;
    const escalation: LLMProvider = { ...initial, model: 'strong', async complete() {
      escalationCalls++;
      return JSON.stringify({ reviewedPaths: paths, findings: [] });
    } };
    try {
      await expect(reviewPullRequest({ db: testDb, llm: initial, escalationLlm: escalation, retrieve: async () => [], github: fakeGithub(largeDiff).github }, { repoId: REPO_ID, prNumber: 42, post: false, force: true })).rejects.toThrow(/escalation.*budget|budget.*escalation/i);
      expect(escalationCalls).toBe(0);
    } finally { testDb.close(); }
  });

  it('rechecks only risky hunks, replaces their findings, and verifies every provisional finding', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    testDb.setRepoStatus(REPO_ID, 'ready', { last_commit: PR.baseSha });
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete(req) {
      expect(req.reviewStage).toBe('initial');
      return JSON.stringify({ reviewedPaths: paths, summary: 'Initial allegation.', verdict: 'request_changes', findings: [
        finding(1, 'Weak risky finding', 'medium'), finding(20, 'Keep low-risk finding'),
      ] });
    } };
    const escalationCalls: CompleteRequest[] = [];
    const escalationLlm: LLMProvider = { name: 'openrouter', model: 'moonshotai/kimi-k2.7-code', concurrency: 1, supportsBatchReview: true, async complete(req) {
      escalationCalls.push(req);
      const payload = JSON.parse(req.messages[0]!.content) as { provisionalFindings: Array<{ id: string; finding: Finding }> };
      return JSON.stringify({ reviewedPaths: paths, decisions: payload.provisionalFindings.map(({ id }) => ({ id, decision: 'reject' })), findings: [finding(1, 'Strong risky finding')] });
    } };
    const verifierLlm: LLMProvider = { ...initial, async complete(req) {
      expect(req.reviewStage).toBe('verification');
      expect(req.maxTokens).toBe(4000);
      const payload = JSON.parse(req.messages[0]!.content) as { findings: Array<{ id: number; finding: { title: string; path: string; line: number } }> };
      expect(payload.findings.map((item) => item.finding.title)).toEqual(['Strong risky finding', 'Keep low-risk finding']);
      return JSON.stringify({ decisions: payload.findings.map(({ id, finding: item }) => ({ id, decision: 'supported', explanation: 'The supplied code demonstrates it.', evidence: { path: item.path, line: item.line } })), summary: 'Two supported issues remain.', verdict: 'approve' });
    } };
    try {
      const result = await reviewPullRequest({ db: testDb, llm: initial, escalationLlm, verifierLlm, retrieve: retrieveOne, github: fakeGithub(diff, PR, { headFiles: { 'src/mixed.ts': 'const token = request.token;\nnewCall();' } }).github }, { repoId: REPO_ID, prNumber: 42, post: false });
      expect(escalationCalls).toHaveLength(1);
      expect(escalationCalls[0]!.reviewStage).toBe('escalation');
      expect(escalationCalls[0]!.maxTokens).toBe(REVIEW_ESCALATION_MAX_OUTPUT);
      expect(escalationCalls[0]!.messages[0]!.content).toContain('request.token');
      expect(escalationCalls[0]!.messages[0]!.content).not.toContain('+newCall();');
      expect(result.findings.map((item) => item.title)).toEqual(['Strong risky finding', 'Keep low-risk finding']);
      expect(result.summary).toContain('The review found 2 actionable issues');
      expect(result.verdict).toBe('comment');
    } finally { testDb.close(); }
  });

  it('requires explicit retain, reject, or uncertain decisions for every risky primary finding', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    testDb.setRepoStatus(REPO_ID, 'ready', { last_commit: PR.baseSha });
    const primaries = ['Retain primary', 'Reject primary', 'Uncertain primary'].map((title) => finding(1, title));
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete() {
      return JSON.stringify({ reviewedPaths: paths, summary: 'Initial.', verdict: 'request_changes', findings: primaries });
    } };
    let verifierTitles: string[] = [];
    const escalationLlm: LLMProvider = { ...initial, model: 'strong', async complete(req) {
      const payload = JSON.parse(req.messages[0]!.content) as { provisionalFindings: Array<{ id: string; finding: Finding }> };
      return JSON.stringify({ reviewedPaths: paths, decisions: payload.provisionalFindings.map(({ id, finding: item }) => ({ id, decision: item.title === 'Reject primary' ? 'reject' : item.title === 'Uncertain primary' ? 'uncertain' : 'retain' })), findings: [] });
    } };
    const verifierLlm: LLMProvider = { ...initial, async complete(req) {
      const payload = JSON.parse(req.messages[0]!.content) as { findings: Array<{ finding: Finding }> };
      verifierTitles = payload.findings.map(({ finding: item }) => item.title);
      return JSON.stringify({ decisions: payload.findings.map(({ finding: item }, id) => ({ id, decision: 'supported', explanation: 'Current evidence supports the finding.', evidence: { path: item.path, line: item.line } })), summary: 'Checked.', verdict: 'comment' });
    } };
    try {
      const result = await reviewPullRequest({ db: testDb, llm: initial, escalationLlm, verifierLlm, retrieve: retrieveOne, github: fakeGithub(diff, PR, { headFiles: { 'src/mixed.ts': 'const token = request.token;\nnewCall();' } }).github }, { repoId: REPO_ID, prNumber: 42, post: false, force: true });
      expect(verifierTitles).toEqual(['Retain primary', 'Uncertain primary']);
      expect(result.findings.map((item) => item.title)).toEqual(['Retain primary', 'Uncertain primary']);
    } finally { testDb.close(); }
  });

  it.each(['missing', 'duplicate', 'unknown'] as const)('fails closed when escalation has an %s primary decision ID', async (failure) => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete() {
      return JSON.stringify({ reviewedPaths: paths, summary: 'Initial.', verdict: 'request_changes', findings: [finding(1, 'Primary')] });
    } };
    const escalationLlm: LLMProvider = { ...initial, model: 'strong', async complete(req) {
      const payload = JSON.parse(req.messages[0]!.content) as { provisionalFindings: Array<{ id: string }> };
      const id = payload.provisionalFindings[0]!.id;
      const decisions = failure === 'missing' ? [] : failure === 'duplicate' ? [{ id, decision: 'retain' }, { id, decision: 'retain' }] : [{ id: 'unknown', decision: 'retain' }];
      return JSON.stringify({ reviewedPaths: paths, decisions, findings: [] });
    } };
    try {
      await expect(reviewPullRequest({ db: testDb, llm: initial, escalationLlm, retrieve: retrieveOne, github: fakeGithub(diff).github }, { repoId: REPO_ID, prNumber: 42, post: false, force: true })).rejects.toThrow(/escalation/i);
    } finally { testDb.close(); }
  });

  it('refreshes verifier retrieval with identifiers implicated by provisional findings', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    testDb.setRepoStatus(REPO_ID, 'ready', { last_commit: PR.baseSha });
    const queries: string[] = [];
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete() {
      return JSON.stringify({ reviewedPaths: paths, summary: 'Initial.', verdict: 'request_changes', findings: [finding(1, 'authorizeRequest accepts an invalid token')] });
    } };
    const verifierLlm: LLMProvider = { ...initial, async complete(req) {
      const payload = JSON.parse(req.messages[0]!.content) as { files: Array<{ relevantContext?: string }> };
      expect(payload.files[0]!.relevantContext).toContain('authorizeRequest');
      expect(payload.files[0]!.relevantContext).toContain('caller invokes request');
      return JSON.stringify({ decisions: [{ id: 0, decision: 'contradicted', explanation: 'The current guard rejects the input.', evidence: { path: 'src/mixed.ts', line: 1 } }], summary: 'No issue.', verdict: 'approve' });
    } };
    try {
      const result = await reviewPullRequest({
        db: testDb, llm: initial, verifierLlm,
        retrieve: async (request) => {
          queries.push(request.query);
          return request.query.includes('authorizeRequest')
            ? [{ ...CHUNK, chunkId: 2, path: 'src/auth.ts', content: 'authorizeRequest checks token' }]
            : [{ ...CHUNK, chunkId: 3, path: 'src/caller.ts', content: 'caller invokes request' }];
        },
        github: fakeGithub(diff, PR, { headFiles: { 'src/mixed.ts': 'const token = request.token;\nnewCall();' } }).github,
      }, { repoId: REPO_ID, prNumber: 42, post: false, force: true });
      expect(queries).toContain('authorizeRequest');
      expect(result.findings).toEqual([]);
    } finally { testDb.close(); }
  });

  it('accepts a citation from a bounded unchanged callee head snippet', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    testDb.setRepoStatus(REPO_ID, 'ready', { last_commit: PR.baseSha });
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete() {
      return JSON.stringify({ reviewedPaths: paths, summary: 'Initial.', verdict: 'request_changes', findings: [finding(1, 'Callee guard')] });
    } };
    const verifierLlm: LLMProvider = { ...initial, async complete(req) {
      const payload = JSON.parse(req.messages[0]!.content) as { files: Array<{ headEvidence?: Array<{ path: string; revision: string; lines: Array<{ line: number; text: string }> }> }> };
      expect(payload.files[0]!.headEvidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'src/callee.ts', revision: 'head', lines: expect.arrayContaining([
          expect.objectContaining({ line: 3, text: 'if (!request) return;' }),
        ]) }),
      ]));
      return JSON.stringify({ decisions: [{ id: 0, decision: 'contradicted', explanation: 'The unchanged callee guard rejects the input.', evidence: { path: 'src/callee.ts', line: 3 } }], summary: 'No issue.', verdict: 'approve' });
    } };
    const baseCallee = { ...CHUNK, chunkId: 9, path: 'src/callee.ts', startLine: 3, endLine: 3, content: 'if (request) return;' };
    try {
      const result = await reviewPullRequest({
        db: testDb, llm: initial, verifierLlm,
        retrieve: async () => [baseCallee],
        github: fakeGithub(diff, PR, { headFiles: {
          'src/mixed.ts': 'const token = request.token;\nnewCall();',
          'src/callee.ts': 'const before = true;\nconst middle = true;\nif (!request) return;\n',
        } }).github,
      }, { repoId: REPO_ID, prNumber: 42, post: false, force: true });
      expect(result.findings).toEqual([]);
    } finally { testDb.close(); }
  });

  it('unions bounded anchors from multiple chunks of the same unchanged callee', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    testDb.setRepoStatus(REPO_ID, 'ready', { last_commit: PR.baseSha });
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete() {
      return JSON.stringify({ reviewedPaths: paths, summary: 'Initial.', verdict: 'request_changes', findings: [finding(1, 'Callee guard')] });
    } };
    const verifierLlm: LLMProvider = { ...initial, async complete(req) {
      const payload = JSON.parse(req.messages[0]!.content) as { files: Array<{ headEvidence?: Array<{ path: string; lines: Array<{ line: number; text: string }> }> }> };
      const callee = payload.files[0]!.headEvidence?.find((snippet) => snippet.path === 'src/callee.ts')!;
      expect(callee.lines).toEqual(expect.arrayContaining([
        expect.objectContaining({ line: 3, text: 'first guard' }),
        expect.objectContaining({ line: 45, text: 'later guard' }),
      ]));
      expect(callee.lines.some(({ line }) => line === 200)).toBe(false);
      return JSON.stringify({ decisions: [{ id: 0, decision: 'supported', explanation: 'The callee evidence supports it.', evidence: { path: 'src/callee.ts', line: 3 } }] });
    } };
    const chunks = [
      { ...CHUNK, chunkId: 21, path: 'src/callee.ts', startLine: 3, endLine: 3, content: 'first guard' },
      { ...CHUNK, chunkId: 22, path: 'src/callee.ts', startLine: 45, endLine: 45, content: 'later guard' },
      { ...CHUNK, chunkId: 23, path: 'src/unrelated.ts', startLine: 200, endLine: 200, content: 'unrelated guard' },
    ];
    const calleeHead = Array.from({ length: 220 }, (_, index) => index === 2 ? 'first guard' : index === 44 ? 'later guard' : index === 199 ? 'unrelated head line' : `line ${index + 1}`).join('\n');
    try {
      const result = await reviewPullRequest({
        db: testDb, llm: initial, verifierLlm, retrieve: async () => chunks,
        github: fakeGithub(diff, PR, { headFiles: { 'src/mixed.ts': 'const token = request.token;\nnewCall();', 'src/callee.ts': calleeHead } }).github,
      }, { repoId: REPO_ID, prNumber: 42, post: false, force: true });
      expect(result.findings).toHaveLength(1);
    } finally { testDb.close(); }
  });

  it('keeps shared callee ranges scoped to each verifier candidate', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    testDb.setRepoStatus(REPO_ID, 'ready', { last_commit: PR.baseSha });
    const changedPaths = ['src/one.ts', 'src/two.ts'];
    const one = candidate('src/one.ts', 1, 'one contract');
    const two = candidate('src/two.ts', 1, 'two contract');
    const oneChunk = { ...CHUNK, chunkId: 31, path: 'src/shared-callee.ts', startLine: 3, endLine: 3, content: 'one guard' };
    const twoChunk = { ...CHUNK, chunkId: 32, path: 'src/shared-callee.ts', startLine: 45, endLine: 45, content: 'two guard' };
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete() {
      return JSON.stringify({ reviewedPaths: changedPaths, summary: 'Initial.', verdict: 'request_changes', findings: [one, two] });
    } };
    const verifierLlm: LLMProvider = { ...initial, async complete(req) {
      const payload = JSON.parse(req.messages[0]!.content) as { files: Array<{ path: string; headEvidence?: Array<{ path: string; lines: Array<{ line: number }> }> }> };
      const oneFile = payload.files.find((file) => file.path === 'src/one.ts')!;
      const twoFile = payload.files.find((file) => file.path === 'src/two.ts')!;
      const oneLines = oneFile.headEvidence?.find((snippet) => snippet.path === 'src/shared-callee.ts')!.lines ?? [];
      const twoLines = twoFile.headEvidence?.find((snippet) => snippet.path === 'src/shared-callee.ts')!.lines ?? [];
      expect(oneLines.some(({ line }) => line === 3)).toBe(true);
      expect(oneLines.some(({ line }) => line === 45)).toBe(false);
      expect(twoLines.some(({ line }) => line === 45)).toBe(true);
      expect(twoLines.some(({ line }) => line === 3)).toBe(false);
      return JSON.stringify({ decisions: [
        { id: 0, decision: 'supported', explanation: 'One is supported.', evidence: { path: 'src/shared-callee.ts', line: 3 } },
        { id: 1, decision: 'supported', explanation: 'Two is supported.', evidence: { path: 'src/shared-callee.ts', line: 45 } },
      ] });
    } };
    const sharedHead = Array.from({ length: 80 }, (_, index) => index === 2 ? 'one head guard' : index === 44 ? 'two head guard' : `line ${index + 1}`).join('\n');
    try {
      const result = await reviewPullRequest({
        db: testDb, llm: initial, verifierLlm,
        retrieve: async (request) => /\bone\b/.test(request.query) ? [oneChunk] : /\btwo\b/.test(request.query) ? [twoChunk] : [],
        github: fakeGithub(candidateDiff(changedPaths), PR, { headFiles: {
          'src/one.ts': 'one();', 'src/two.ts': 'two();', 'src/shared-callee.ts': sharedHead,
        } }).github,
      }, { repoId: REPO_ID, prNumber: 42, post: false, force: true });
      expect(result.findings).toHaveLength(2);
    } finally { testDb.close(); }
  });

  it('scopes unchanged head evidence to the verifier file that retrieved it once', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    testDb.setRepoStatus(REPO_ID, 'ready', { last_commit: PR.baseSha });
    const changedPaths = ['src/one.ts', 'src/two.ts'];
    const one = candidate('src/one.ts', 1, 'one contract');
    const two = candidate('src/two.ts', 1, 'two contract');
    const oneChunk = { ...CHUNK, chunkId: 11, path: 'src/callee-one.ts', startLine: 3, endLine: 3, content: 'if (one) return;' };
    const twoChunk = { ...CHUNK, chunkId: 12, path: 'src/callee-two.ts', startLine: 3, endLine: 3, content: 'if (two) return;' };
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete() {
      return JSON.stringify({ reviewedPaths: changedPaths, summary: 'Initial.', verdict: 'request_changes', findings: [one, two] });
    } };
    const verifierLlm: LLMProvider = { ...initial, async complete(req) {
      const payload = JSON.parse(req.messages[0]!.content) as { files: Array<{ path: string; headContext?: string; headEvidence?: Array<{ path: string }> }> };
      const oneFile = payload.files.find((file) => file.path === 'src/one.ts')!;
      const twoFile = payload.files.find((file) => file.path === 'src/two.ts')!;
      expect(oneFile.headContext).toBeUndefined();
      expect(twoFile.headContext).toBeUndefined();
      expect(oneFile.headEvidence?.map((snippet) => snippet.path)).toEqual(['src/one.ts', 'src/callee-one.ts']);
      expect(twoFile.headEvidence?.map((snippet) => snippet.path)).toEqual(['src/two.ts', 'src/callee-two.ts']);
      return JSON.stringify({ decisions: [
        { id: 0, decision: 'supported', explanation: 'One is supported.', evidence: { path: 'src/one.ts', line: 1 } },
        { id: 1, decision: 'supported', explanation: 'Two is supported.', evidence: { path: 'src/two.ts', line: 1 } },
      ] });
    } };
    try {
      const result = await reviewPullRequest({
        db: testDb, llm: initial, verifierLlm,
        retrieve: async (request) => request.query.includes('one') ? [oneChunk] : request.query.includes('two') ? [twoChunk] : [],
        identifiers: () => [],
        github: fakeGithub(candidateDiff(changedPaths), PR, { headFiles: {
          'src/one.ts': 'one();', 'src/two.ts': 'two();',
          'src/callee-one.ts': 'const before = true;\nconst middle = true;\nif (!one) return;\n',
          'src/callee-two.ts': 'const before = true;\nconst middle = true;\nif (!two) return;\n',
        } }).github,
      }, { repoId: REPO_ID, prNumber: 42, post: false, force: true });
      expect(result.findings).toHaveLength(2);
    } finally { testDb.close(); }
  });

  it('includes unchanged head citation lines in a verifier corrective retry allowlist', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    testDb.setRepoStatus(REPO_ID, 'ready', { last_commit: PR.baseSha });
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete() {
      return JSON.stringify({ reviewedPaths: paths, summary: 'Initial.', verdict: 'request_changes', findings: [finding(1, 'Callee guard')] });
    } };
    const requests: CompleteRequest[] = [];
    const verifierLlm: LLMProvider = { ...initial, async complete(req) {
      requests.push(req);
      if (requests.length === 1) return JSON.stringify({ decisions: [{ id: 0, decision: 'supported', explanation: 'Bad line.', evidence: { path: 'src/callee.ts', line: 999 } }] });
      return JSON.stringify({ decisions: [{ id: 0, decision: 'supported', explanation: 'Head guard supports it.', evidence: { path: 'src/callee.ts', line: 3 } }] });
    } };
    try {
      const result = await reviewPullRequest({
        db: testDb, llm: initial, verifierLlm,
        retrieve: async () => [{ ...CHUNK, chunkId: 13, path: 'src/callee.ts', startLine: 3, endLine: 3, content: 'if (request) return;' }],
        github: fakeGithub(diff, PR, { headFiles: {
          'src/mixed.ts': 'const token = request.token;\nnewCall();',
          'src/callee.ts': 'const before = true;\nconst middle = true;\nif (!request) return;\n',
        } }).github,
      }, { repoId: REPO_ID, prNumber: 42, post: false, force: true });
      const correction = JSON.parse(requests[1]!.messages[0]!.content) as { allowedPathsAndLines?: Array<{ path: string; lines: number[] }> };
      expect(correction.allowedPathsAndLines).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'src/callee.ts', lines: expect.arrayContaining([3]) }),
      ]));
      expect(result.findings).toHaveLength(1);
    } finally { testDb.close(); }
  });

  it('does not accept a base-only retrieved line as verifier evidence', () => {
    expect(hasValidVerifierCitation(
      { evidence: { path: 'src/callee.ts', line: 3 } },
      [{ path: 'src/mixed.ts', currentEvidence: [{ line: 1 }], headContext: '### src/callee.ts (base base-sha-1)\n```\n3 | if (request) return;\n```' }],
    )).toBe(false);
  });

  it('rejects a supported verifier decision without structured evidence', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete() {
      return JSON.stringify({ reviewedPaths: paths, summary: 'Initial.', verdict: 'request_changes', findings: [finding(1, 'Finding')] });
    } };
    const verifierLlm: LLMProvider = { ...initial, async complete() {
      return JSON.stringify({ decisions: [{ id: 0, decision: 'supported', explanation: 'Evidence at src/mixed.ts:999 proves it.' }], summary: 'Supported.', verdict: 'request_changes' });
    } };
    try {
      await expect(reviewPullRequest({ db: testDb, llm: initial, verifierLlm, retrieve: retrieveOne, github: fakeGithub(diff, PR, { headFiles: { 'src/mixed.ts': 'const token = request.token;\nnewCall();' } }).github }, { repoId: REPO_ID, prNumber: 42, post: false, force: true })).rejects.toThrow('verification');
    } finally { testDb.close(); }
  });

  it('rejects a contradicted verifier decision without structured evidence', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete() {
      return JSON.stringify({ reviewedPaths: paths, summary: 'Initial.', verdict: 'request_changes', findings: [finding(1, 'Finding')] });
    } };
    const verifierLlm: LLMProvider = { ...initial, async complete() {
      return JSON.stringify({ decisions: [{ id: 0, decision: 'contradicted', explanation: 'The guard prevents the alleged behavior.' }], summary: 'Contradicted.', verdict: 'approve' });
    } };
    try {
      await expect(reviewPullRequest({ db: testDb, llm: initial, verifierLlm, retrieve: retrieveOne, github: fakeGithub(diff, PR, { headFiles: { 'src/mixed.ts': 'const token = request.token;\nnewCall();' } }).github }, { repoId: REPO_ID, prNumber: 42, post: false, force: true })).rejects.toThrow('verification');
    } finally { testDb.close(); }
  });

  it('rechecks only uncertain findings once and keeps supported while dropping contradicted findings', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    testDb.setRepoStatus(REPO_ID, 'ready', { last_commit: PR.baseSha });
    const findings = [finding(1, 'Supported'), finding(1, 'Contradicted'), finding(20, 'Uncertain')];
    const calls: CompleteRequest[] = [];
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete(req) {
      calls.push(req);
      return JSON.stringify({ reviewedPaths: paths, summary: 'Initial.', verdict: 'request_changes', findings });
    } };
    const verifierLlm: LLMProvider = { ...initial, async complete(req) {
      calls.push(req);
      const payload = JSON.parse(req.messages[0]!.content) as { findings: Array<{ id: number; finding: Finding }> };
      if (calls.filter((call) => call.reviewStage === 'verification').length === 1) {
        expect(payload.findings.map(({ finding: item }) => item.title)).toEqual(['Supported', 'Contradicted', 'Uncertain']);
        return JSON.stringify({ decisions: [
          { id: 0, decision: 'supported', explanation: 'The supplied code demonstrates it.', evidence: { path: 'src/mixed.ts', line: 1 } },
          { id: 1, decision: 'contradicted', explanation: 'The guard prevents it.', evidence: { path: 'src/mixed.ts', line: 1 } },
          { id: 2, decision: 'uncertain', explanation: 'The supplied evidence is inconclusive.' },
        ] });
      }
      expect(payload.findings.map(({ finding: item }) => item.title)).toEqual(['Uncertain']);
      expect(req.system).toMatch(/supported\|contradicted/);
      expect(req.system).not.toMatch(/supported\|contradicted\|uncertain/);
      expect(req.system).not.toContain('uncertain');
      expect(req.jsonSchema).toBeUndefined();
      return JSON.stringify({ decisions: [{ id: 2, decision: 'supported', explanation: 'The focused evidence demonstrates it.', evidence: { path: 'src/mixed.ts', line: 20 } }] });
    } };
    try {
      const result = await reviewPullRequest({ db: testDb, llm: initial, verifierLlm, focusedVerification: true, retrieve: retrieveOne, github: fakeGithub(diff, PR, { headFiles: { 'src/mixed.ts': 'const token = request.token;\nnewCall();' } }).github }, { repoId: REPO_ID, prNumber: 42, post: false, force: true });
      expect(calls.filter((call) => call.reviewStage === 'verification')).toHaveLength(2);
      expect(result.findings.map((item) => item.title)).toEqual(['Supported', 'Uncertain']);
      const stage = result.trace!.stages.find((item) => item.stage === 'verification')!;
      expect(stage.calls).toHaveLength(2);
      expect(stage.calls.map((call) => call.pass)).toEqual(['normal', 'focused']);
      expect(stage.focusedDecisions).toEqual([{ id: 2, decision: 'supported' }]);
    } finally { testDb.close(); }
  });

  it('stops before a focused verifier call when the PR head moves', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    testDb.setRepoStatus(REPO_ID, 'ready', { last_commit: PR.baseSha });
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete() {
      return JSON.stringify({ reviewedPaths: paths, summary: 'Initial.', verdict: 'request_changes', findings: [finding(20, 'Uncertain')] });
    } };
    let verifierCalls = 0;
    let headSha = PR.headSha;
    const verifierLlm: LLMProvider = { ...initial, async complete() {
      verifierCalls++;
      headSha = 'moved';
      return verifierCalls === 1
        ? JSON.stringify({ decisions: [{ id: 0, decision: 'uncertain', explanation: 'Still uncertain.' }] })
        : JSON.stringify({ decisions: [{ id: 0, decision: 'supported', explanation: 'Focused evidence supports it.', evidence: { path: 'src/mixed.ts', line: 20 } }] });
    } };
    const gh = fakeGithub(diff, PR, { headFiles: { 'src/mixed.ts': 'const token = request.token;\nnewCall();' } });
    gh.github.getPull = async () => ({ ...PR, headSha });
    try {
      await expect(reviewPullRequest({ db: testDb, llm: initial, verifierLlm, focusedVerification: true, retrieve: retrieveOne, github: gh.github }, {
        repoId: REPO_ID, prNumber: 42, post: false, force: true,
      })).rejects.toBeInstanceOf(ReviewSupersededError);
      expect(verifierCalls).toBe(1);
    } finally { testDb.close(); }
  });

  it('preserves original uncertain IDs through a shuffled focused recheck', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    testDb.setRepoStatus(REPO_ID, 'ready', { last_commit: PR.baseSha });
    const candidates = [finding(1, 'Uncertain zero'), finding(20, 'Contradicted'), finding(1, 'Supported'), finding(20, 'Uncertain three')];
    const calls: CompleteRequest[] = [];
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete(req) {
      calls.push(req);
      return JSON.stringify({ reviewedPaths: paths, summary: 'Initial.', verdict: 'request_changes', findings: candidates });
    } };
    const verifierLlm: LLMProvider = { ...initial, async complete(req) {
      calls.push(req);
      const payload = JSON.parse(req.messages[0]!.content) as { findings: Array<{ id: number; finding: Finding }> };
      if (calls.filter((call) => call.reviewStage === 'verification').length === 1) {
        return JSON.stringify({ decisions: [
          { id: 3, decision: 'uncertain', explanation: 'Needs focus.' },
          { id: 2, decision: 'contradicted', explanation: 'Guard prevents it.', evidence: { path: 'src/mixed.ts', line: 20 } },
          { id: 0, decision: 'uncertain', explanation: 'Needs focus.' },
          { id: 1, decision: 'supported', explanation: 'The code demonstrates it.', evidence: { path: 'src/mixed.ts', line: 1 } },
        ] });
      }
      expect(payload.findings.map(({ id, finding: item }) => [id, item.title])).toEqual([[3, 'Uncertain three'], [0, 'Uncertain zero']]);
      return JSON.stringify({ decisions: [
        { id: 0, decision: 'supported', explanation: 'Focused evidence supports it.', evidence: { path: 'src/mixed.ts', line: 1 } },
        { id: 3, decision: 'contradicted', explanation: 'Focused evidence disproves it.', evidence: { path: 'src/mixed.ts', line: 20 } },
      ] });
    } };
    try {
      const result = await reviewPullRequest({ db: testDb, llm: initial, verifierLlm, focusedVerification: true, retrieve: retrieveOne, github: fakeGithub(diff, PR, { headFiles: { 'src/mixed.ts': 'const token = request.token;\nnewCall();' } }).github }, { repoId: REPO_ID, prNumber: 42, post: false, force: true, fresh: true, experimentTrace: true });
      expect(result.findings.map((item) => item.title)).toEqual(['Supported', 'Uncertain zero']);
      expect(result.trace?.experiment).toMatchObject({
        verificationCandidates: [
          { id: 0, finding: { title: 'Uncertain zero' } },
          { id: 1, finding: { title: 'Supported' } },
          { id: 2, finding: { title: 'Contradicted' } },
          { id: 3, finding: { title: 'Uncertain three' } },
        ],
        verificationDecisions: expect.arrayContaining([
          expect.objectContaining({ id: 0, decision: 'uncertain', explanation: 'Needs focus.' }),
          expect.objectContaining({ id: 1, decision: 'supported', evidence: { path: 'src/mixed.ts', line: 1 } }),
        ]),
        focusedDecisions: expect.arrayContaining([
          expect.objectContaining({ id: 0, decision: 'supported', explanation: 'Focused evidence supports it.' }),
          expect.objectContaining({ id: 3, decision: 'contradicted', evidence: { path: 'src/mixed.ts', line: 20 } }),
        ]),
      });
      expect(result.trace?.experiment?.publishedFindings.map((item) => item.id)).toEqual([1, 0]);
      expect(result.trace?.stages.flatMap((stage) => stage.calls).every((call) => (call.elapsedMs ?? -1) >= 0)).toBe(true);
      expect(result.trace!.stages.find((item) => item.stage === 'verification')!.focusedDecisions).toEqual([
        { id: 0, decision: 'supported' }, { id: 3, decision: 'contradicted' },
      ]);
    } finally { testDb.close(); }
  });

  it('fails closed when focused support is malformed or lacks a valid citation', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    testDb.setRepoStatus(REPO_ID, 'ready', { last_commit: PR.baseSha });
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete() {
      return JSON.stringify({ reviewedPaths: paths, summary: 'Initial.', verdict: 'request_changes', findings: [finding(20, 'Uncertain')] });
    } };
    let verifierCalls = 0;
    const verifierLlm: LLMProvider = { ...initial, async complete(req) {
      verifierCalls++;
      const payload = JSON.parse(req.messages[0]!.content) as { findings: Array<{ id: number }> };
      return verifierCalls === 1
        ? JSON.stringify({ decisions: [{ id: 0, decision: 'uncertain', explanation: 'Still uncertain.' }] })
        : JSON.stringify({ decisions: [{ id: 0, decision: 'supported', explanation: 'No citation.' }] });
    } };
    try {
      await expect(reviewPullRequest({ db: testDb, llm: initial, verifierLlm, focusedVerification: true, maxRetries: 0, retrieve: retrieveOne, github: fakeGithub(diff, PR, { headFiles: { 'src/mixed.ts': 'const token = request.token;\nnewCall();' } }).github }, { repoId: REPO_ID, prNumber: 42, post: false, force: true })).rejects.toThrow('verification');
    } finally { testDb.close(); }
  });

  it('suppresses uncertain findings when the focused recheck cannot fit the review budget', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    testDb.setRepoStatus(REPO_ID, 'ready', { last_commit: PR.baseSha });
    const tracker = new UsageTracker({ db: testDb, pricing: null });
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete() {
      tracker.sinkFor('review')({ provider: 'openrouter', model: 'cheap', inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1, costUsd: 0.005 });
      return JSON.stringify({ reviewedPaths: paths, summary: 'Initial.', verdict: 'comment', findings: [finding(20, 'Uncertain')] });
    } };
    let verifierCalls = 0;
    const verifierLlm: LLMProvider = { ...initial, async complete(req) {
      verifierCalls++;
      tracker.sinkFor('review')({ provider: 'openrouter', model: 'cheap', inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1, costUsd: 0.485 });
      return JSON.stringify({ decisions: [{ id: 0, decision: 'uncertain', explanation: 'Still uncertain.' }] });
    } };
    try {
      const result = await reviewPullRequest({ db: testDb, llm: initial, verifierLlm, focusedVerification: true, retrieve: retrieveOne, github: fakeGithub(diff, PR, { headFiles: { 'src/mixed.ts': 'const token = request.token;\nnewCall();' } }).github }, { repoId: REPO_ID, prNumber: 42, post: false, force: true });
      expect(verifierCalls).toBe(1);
      expect(result.findings).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect((result.trace!.stages.find((item) => item.stage === 'verification')! as { focusedSkipped?: string }).focusedSkipped).toBe('budget');
    } finally { testDb.close(); }
  });

  it('suppresses uncertain findings without a focused call when disabled', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    testDb.setRepoStatus(REPO_ID, 'ready', { last_commit: PR.baseSha });
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete() {
      return JSON.stringify({ reviewedPaths: paths, summary: 'Initial.', verdict: 'comment', findings: [finding(20, 'Uncertain')] });
    } };
    let verifierCalls = 0;
    const verifierLlm: LLMProvider = { ...initial, async complete(req) {
      verifierCalls++;
      expect(req.reviewStage).toBe('verification');
      return JSON.stringify({ decisions: [{ id: 0, decision: 'uncertain', explanation: 'Still uncertain.' }] });
    } };
    try {
      const result = await reviewPullRequest({ db: testDb, llm: initial, verifierLlm, focusedVerification: false, retrieve: retrieveOne, github: fakeGithub(diff, PR, { headFiles: { 'src/mixed.ts': 'const token = request.token;\nnewCall();' } }).github }, { repoId: REPO_ID, prNumber: 42, post: false, force: true });
      expect(verifierCalls).toBe(1);
      expect(result.findings).toEqual([]);
      expect(result.trace?.experiment).toBeUndefined();
      const stage = result.trace!.stages.find((item) => item.stage === 'verification')!;
      expect(stage.focusedSkipped).toBe('disabled');
      expect(stage.calls).toHaveLength(1);
      expect(stage.calls.every((call) => (call.elapsedMs ?? -1) >= 0)).toBe(true);
    } finally { testDb.close(); }
  });

  it('keeps experiment provenance private when fresh mode is not enabled', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    testDb.setRepoStatus(REPO_ID, 'ready', { last_commit: PR.baseSha });
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete() {
      return JSON.stringify({ reviewedPaths: paths, summary: 'Initial.', verdict: 'comment', findings: [finding(20, 'Uncertain')] });
    } };
    const verifierLlm: LLMProvider = { ...initial, async complete() {
      return JSON.stringify({ decisions: [{ id: 0, decision: 'uncertain', explanation: 'Still uncertain.' }] });
    } };
    try {
      const result = await reviewPullRequest({ db: testDb, llm: initial, verifierLlm, retrieve: retrieveOne, github: fakeGithub(diff, PR, { headFiles: { 'src/mixed.ts': 'const token = request.token;\nnewCall();' } }).github }, { repoId: REPO_ID, prNumber: 42, post: false, force: true, experimentTrace: true });
      expect(result.trace?.experiment).toBeUndefined();
    } finally { testDb.close(); }
  });

  it('gives verification bounded current and removed evidence when the head file is oversized', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    testDb.setRepoStatus(REPO_ID, 'ready', { last_commit: PR.baseSha });
    const largeDiff = `diff --git a/src/large.ts b/src/large.ts\n--- a/src/large.ts\n+++ b/src/large.ts\n@@ -50 +50 @@\n-const value = oldValue();\n+const value = newValue();\n`;
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete() {
      return JSON.stringify({ reviewedPaths: ['src/large.ts'], summary: 'Stale allegation.', verdict: 'request_changes', findings: [{ ...finding(50, 'Stale finding'), path: 'src/large.ts', evidence: { ...finding(50, 'Stale finding').evidence, path: 'src/large.ts' } }] });
    } };
    let verifierPayload: Record<string, unknown> | undefined;
    const verifierLlm: LLMProvider = { ...initial, async complete(req) {
      verifierPayload = JSON.parse(req.messages[0]!.content) as Record<string, unknown>;
      return JSON.stringify({ decisions: [{ id: 0, decision: 'contradicted', explanation: 'The guard prevents the alleged behavior.', evidence: { path: 'src/large.ts', line: 35 } }], summary: 'No current issue.', verdict: 'approve' });
    } };
    try {
      const result = await reviewPullRequest({
        db: testDb, llm: initial, verifierLlm, retrieve: retrieveOne,
        github: fakeGithub(largeDiff, PR, { headFiles: { 'src/large.ts': Array.from({ length: 120 }, (_, index) => index === 34 ? 'if (!request) return;' : index === 49 ? 'const value = newValue();' : `${'x'.repeat(120)}-${index + 1}`).join('\n') } }).github,
      }, { repoId: REPO_ID, prNumber: 42, post: false });
      expect(verifierPayload?.prBody).toBeUndefined();
      const verifierFile = (verifierPayload?.files as Array<Record<string, any>>)[0]!;
      expect(verifierFile.currentEvidence).toEqual([{ line: 50, kind: 'added', content: 'const value = newValue();' }]);
      expect(verifierFile.removedEvidence).toEqual([{ line: 50, kind: 'removed', content: 'const value = oldValue();' }]);
      expect(verifierFile.headContext).toBeUndefined();
      expect(verifierFile.headEvidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'src/large.ts', revision: 'head', lines: expect.arrayContaining([{ line: 35, text: 'if (!request) return;' }]) }),
      ]));
      expect(result.findings).toEqual([]);
    } finally { testDb.close(); }
  });

  it('trims optional verifier context before reserving while keeping diff evidence', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    let verifierRequest: CompleteRequest | undefined;
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete() {
      return JSON.stringify({ reviewedPaths: paths, summary: 'Initial.', verdict: 'request_changes', findings: [finding(1, 'Finding')] });
    } };
    const verifierLlm: LLMProvider = { ...initial, async complete(req) {
      verifierRequest = req;
      return JSON.stringify({ decisions: [{ id: 0, decision: 'contradicted', explanation: 'The current code disproves it.', evidence: { path: 'src/mixed.ts', line: 1 } }], summary: 'No issue.', verdict: 'approve' });
    } };
    try {
      await reviewPullRequest({
        db: testDb, llm: initial, verifierLlm,
        retrieve: async () => [{ ...CHUNK, content: 'context ' + 'x'.repeat(500_000) }],
        github: fakeGithub(diff, PR, { headFiles: { 'src/mixed.ts': 'const token = request.token;\nnewCall();' } }).github,
      }, { repoId: REPO_ID, prNumber: 42, post: false, force: true });
      const payload = JSON.parse(verifierRequest!.messages[0]!.content) as { files: Array<Record<string, unknown>> };
      expect(payload.files[0]!.relevantContext).toBeUndefined();
      expect(payload.files[0]!.currentEvidence).toEqual(expect.arrayContaining([{ line: 1, kind: 'added', content: 'const token = request.token;' }]));
      expect(reviewCostUpperBound(verifierRequest!)).toBeLessThanOrEqual(REVIEW_MAX_USD);
    } finally { testDb.close(); }
  });

  it('chooses trimmed verifier context before reserving escalation output allowance', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    const tracker = new UsageTracker({ db: testDb, pricing: null });
    let escalationCalls = 0;
    let verifierRequest: CompleteRequest | undefined;
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete() {
      tracker.sinkFor('review')({ provider: 'openrouter', model: 'cheap', inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1, costUsd: 0.37 });
      return JSON.stringify({ reviewedPaths: paths, summary: 'Initial.', verdict: 'request_changes', findings: [finding(1, 'Finding')] });
    } };
    const escalationLlm: LLMProvider = { ...initial, model: 'strong', async complete(req) {
      escalationCalls++;
      tracker.sinkFor('review')({ provider: 'openrouter', model: 'strong', inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1, costUsd: 0.01 });
      const payload = JSON.parse(req.messages[0]!.content) as { provisionalFindings: Array<{ id: string }> };
      return JSON.stringify({ reviewedPaths: paths, decisions: payload.provisionalFindings.map(({ id }) => ({ id, decision: 'retain' })), findings: [] });
    } };
    const verifierLlm: LLMProvider = { ...initial, async complete(req) {
      verifierRequest = req;
      return JSON.stringify({ decisions: [{ id: 0, decision: 'contradicted', explanation: 'The current code disproves it.', evidence: { path: 'src/mixed.ts', line: 1 } }], summary: 'No issue.', verdict: 'approve' });
    } };
    try {
      await reviewPullRequest({
        db: testDb, llm: initial, escalationLlm, verifierLlm,
        retrieve: async () => [{ ...CHUNK, content: 'request token context ' + 'x'.repeat(290_000) }],
        github: fakeGithub(diff, PR, { headFiles: { 'src/mixed.ts': 'const token = request.token;\nnewCall();' } }).github,
      }, { repoId: REPO_ID, prNumber: 42, post: false, force: true });
      const payload = JSON.parse(verifierRequest!.messages[0]!.content) as { files: Array<Record<string, unknown>> };
      expect(escalationCalls).toBe(1);
      expect(payload.files[0]!.relevantContext).toBeUndefined();
    } finally { testDb.close(); }
  });

  it('anchors deletion-only hunks to post-change lines for head context', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    const deletionDiff = `diff --git a/src/large.ts b/src/large.ts\n--- a/src/large.ts\n+++ b/src/large.ts\n@@ -50 +49,0 @@\n-deletedGuard();\n`;
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete() {
      return JSON.stringify({ reviewedPaths: ['src/large.ts'], summary: 'Initial.', verdict: 'request_changes', findings: [{ ...finding(50, 'Removed guard'), path: 'src/large.ts', evidence: { ...finding(50, 'Removed guard').evidence, path: 'src/large.ts' } }] });
    } };
    let verifierPayload: Record<string, unknown> | undefined;
    const verifierLlm: LLMProvider = { ...initial, async complete(req) {
      verifierPayload = JSON.parse(req.messages[0]!.content) as Record<string, unknown>;
      return JSON.stringify({ decisions: [{ id: 0, decision: 'contradicted', explanation: 'The deleted guard is no longer alleged.', evidence: { path: 'src/large.ts', line: 49 } }], summary: 'No issue.', verdict: 'approve' });
    } };
    const head = Array.from({ length: 120 }, (_, index) => index === 48 ? 'afterGuard();' : `${'x'.repeat(120)}-${index + 1}`).join('\n');
    try {
      await reviewPullRequest({ db: testDb, llm: initial, verifierLlm, retrieve: retrieveOne, github: fakeGithub(deletionDiff, PR, { headFiles: { 'src/large.ts': head } }).github }, { repoId: REPO_ID, prNumber: 42, post: false, force: true });
      const verifierFile = (verifierPayload?.files as Array<Record<string, any>>)[0]!;
      expect(verifierFile.headContext).toBeUndefined();
      expect(verifierFile.headEvidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'src/large.ts', revision: 'head', lines: expect.arrayContaining([{ line: 49, text: 'afterGuard();' }]) }),
      ]));
    } finally { testDb.close(); }
  });

  it('does not call staged models for low-risk changes with no findings', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    const lowDiff = diff.replace('const token = request.token;', 'newValue();').replace('const token = oldToken;', 'oldValue();').split('@@ -20')[0]!;
    let staged = 0;
    const llm: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete() {
      return JSON.stringify({ reviewedPaths: paths, summary: 'No issues.', verdict: 'approve', findings: [] });
    } };
    const unused: LLMProvider = { ...llm, async complete() { staged++; return '{}'; } };
    try {
      const result = await reviewPullRequest({ db: testDb, llm, escalationLlm: unused, verifierLlm: unused, retrieve: retrieveOne, github: fakeGithub(lowDiff).github }, { repoId: REPO_ID, prNumber: 42, post: false });
      expect(staged).toBe(0);
      expect(result.findings).toEqual([]);
    } finally { testDb.close(); }
  });

  it('fails closed when verification omits a finding decision', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    const llm: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete(req) {
      if (req.system === VERIFIER_SYSTEM_PROMPT) return JSON.stringify({ decisions: [], summary: 'Missing.', verdict: 'approve' });
      return JSON.stringify({ reviewedPaths: paths, summary: 'Initial.', verdict: 'comment', findings: [finding(20, 'Finding')] });
    } };
    try {
      await expect(reviewPullRequest({ db: testDb, llm, verifierLlm: llm, retrieve: retrieveOne, github: fakeGithub(diff).github }, { repoId: REPO_ID, prNumber: 42, post: false })).rejects.toThrow('verification');
      expect(testDb.findReview(REPO_ID, 42, PR.headSha)).toBeUndefined();
    } finally { testDb.close(); }
  });

  it('suppresses contradicted and marginal findings and uses the verifier summary', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete() {
      return JSON.stringify({ reviewedPaths: paths, summary: 'Stale allegations.', verdict: 'request_changes', findings: [
        finding(1, 'Contradicted'), finding(20, 'Marginal', 'medium'),
      ] });
    } };
    const escalationLlm: LLMProvider = { ...initial, model: 'strong', async complete(req) {
      const payload = JSON.parse(req.messages[0]!.content) as { provisionalFindings: Array<{ id: string }> };
      return JSON.stringify({ reviewedPaths: paths, decisions: payload.provisionalFindings.map(({ id }) => ({ id, decision: 'retain' })), findings: [] });
    } };
    const verifierLlm: LLMProvider = { ...initial, async complete() {
      return JSON.stringify({
        decisions: [
          { id: 0, decision: 'contradicted', explanation: 'The supplied branch prevents the alleged behavior.', evidence: { path: 'src/mixed.ts', line: 1 } },
          { id: 1, decision: 'supported', explanation: 'The code supports it, but confidence remains marginal.', evidence: { path: 'src/mixed.ts', line: 20 } },
        ],
        summary: 'Two issues remain.', verdict: 'approve',
      });
    } };
    try {
      const result = await reviewPullRequest({ db: testDb, llm: initial, escalationLlm, verifierLlm, retrieve: retrieveOne, github: fakeGithub(diff).github }, { repoId: REPO_ID, prNumber: 42, post: false });
      expect(result.findings).toEqual([]);
      expect(result.summary).toBe('The review found no actionable issues in the supplied changes.');
      expect(result.verdict).toBe('approve');
    } finally { testDb.close(); }
  });

  it('does not publish a verifier-rejected finding in the summary or review body', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete() {
      return JSON.stringify({ reviewedPaths: paths, summary: 'Initial stale summary mentions REJECTED finding.', verdict: 'request_changes', findings: [
        finding(1, 'Rejected finding'), finding(20, 'Accepted finding'),
      ] });
    } };
    const verifierLlm: LLMProvider = { ...initial, async complete(req) {
      const payload = JSON.parse(req.messages[0]!.content) as { findings: Array<{ id: number; finding: Finding }> };
      return JSON.stringify({
        decisions: payload.findings.map(({ id, finding: item }) => ({ id, decision: item.title === 'Rejected finding' ? 'contradicted' : 'supported', explanation: 'Checked current evidence.', evidence: { path: item.path, line: item.line } })),
        summary: 'MODEL SUMMARY LEAK REJECTED finding and accepted finding.', verdict: 'request_changes',
      });
    } };
    const gh = fakeGithub(diff);
    try {
      const result = await reviewPullRequest({ db: testDb, llm: initial, verifierLlm, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42 });
      expect(result.findings.map((item) => item.title)).toEqual(['Accepted finding']);
      expect(result.summary).not.toContain('Rejected finding');
      expect(result.summary).not.toContain('MODEL SUMMARY LEAK');
      expect(gh.reviews[0]!.input.body).not.toContain('Rejected finding');
      expect(gh.reviews[0]!.input.body).toContain('Accepted finding');
    } finally { testDb.close(); }
  });

  it('shares the total budget with escalation and fails before an over-budget strong call', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    const tracker = new UsageTracker({ db: testDb, pricing: null });
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete() {
      tracker.sinkFor('review')({ provider: 'openrouter', model: 'cheap', inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1, costUsd: 0.44 });
      return JSON.stringify({ reviewedPaths: paths, summary: 'Initial.', verdict: 'approve', findings: [] });
    } };
    let strongCalls = 0;
    const escalationLlm: LLMProvider = { ...initial, model: 'strong', async complete() { strongCalls++; return '{}'; } };
    try {
      await expect(reviewPullRequest({ db: testDb, llm: initial, escalationLlm, retrieve: retrieveOne, github: fakeGithub(diff).github }, { repoId: REPO_ID, prNumber: 42, post: false })).rejects.toThrow('budget');
      expect(strongCalls).toBe(0);
      expect(testDb.findReview(REPO_ID, 42, PR.headSha)).toBeUndefined();
    } finally { testDb.close(); }
  });

  it('uses one corrective retry for malformed initial output with exact line guidance', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    const requests: CompleteRequest[] = [];
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete(req) {
      requests.push(req);
      return requests.length === 1 ? 'not JSON' : JSON.stringify({ reviewedPaths: paths, summary: 'Initial.', verdict: 'approve', findings: [] });
    } };
    try {
      const result = await reviewPullRequest({ db: testDb, llm: initial, retrieve: retrieveOne, github: fakeGithub(diff).github }, { repoId: REPO_ID, prNumber: 42, post: false, force: true });
      expect(requests).toHaveLength(2);
      const correction = JSON.parse(requests[1]!.messages[0]!.content) as { validationError?: string; allowedPathsAndLines?: unknown };
      expect(correction.validationError).toContain('JSON');
      expect(correction.allowedPathsAndLines).toEqual([{ path: 'src/mixed.ts', lines: [1, 20] }]);
      const initialStage = result.trace!.stages.find((stage) => stage.stage === 'initial')!;
      expect(initialStage.calls.map((call) => call.outcome)).toEqual(['validation_error', 'success']);
      expect(initialStage.calls[0]!.failure).toContain('JSON');
      expect(result.trace!.identity).toMatchObject({ repoId: REPO_ID, prNumber: 42, headSha: PR.headSha, model: 'cheap' });
      expect(result.trace!.finalFindings).toEqual([]);
    } finally { testDb.close(); }
  });

  it('keeps transient provider failures as provider errors in the trace', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    let calls = 0;
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete() {
      calls++;
      if (calls === 1) throw new ProviderError('openrouter', 'HTTP 503', 503);
      return JSON.stringify({ reviewedPaths: paths, summary: 'Initial.', verdict: 'approve', findings: [] });
    } };
    try {
      const result = await reviewPullRequest({ db: testDb, llm: initial, maxRetries: 1, retrieve: retrieveOne, github: fakeGithub(diff).github }, { repoId: REPO_ID, prNumber: 42, post: false, force: true });
      const initialStage = result.trace!.stages.find((stage) => stage.stage === 'initial')!;
      expect(initialStage.calls.map((call) => call.outcome)).toEqual(['error', 'success']);
      expect(initialStage.calls[0]!.failure).toBeUndefined();
    } finally { testDb.close(); }
  });

  it('uses one corrective retry for malformed escalation output with exact path lines', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete() {
      return JSON.stringify({ reviewedPaths: paths, summary: 'Initial.', verdict: 'request_changes', findings: [finding(1, 'Primary')] });
    } };
    const requests: CompleteRequest[] = [];
    const escalation: LLMProvider = { ...initial, model: 'strong', async complete(req) {
      requests.push(req);
      const payload = JSON.parse(req.messages[0]!.content) as { provisionalFindings: Array<{ id: string }> };
      return requests.length === 1 ? JSON.stringify({ reviewedPaths: [] }) : JSON.stringify({ reviewedPaths: paths, decisions: payload.provisionalFindings.map(({ id }) => ({ id, decision: 'reject' })), findings: [] });
    } };
    try {
      const result = await reviewPullRequest({ db: testDb, llm: initial, escalationLlm: escalation, retrieve: retrieveOne, github: fakeGithub(diff).github }, { repoId: REPO_ID, prNumber: 42, post: false, force: true });
      expect(requests).toHaveLength(2);
      const correction = JSON.parse(requests[1]!.messages[0]!.content) as { validationError?: string; allowedPathsAndLines?: unknown };
      expect(correction.validationError).toContain('reviewedPaths');
      expect(correction.allowedPathsAndLines).toEqual([{ path: 'src/mixed.ts', lines: [1] }]);
      const escalationStage = result.trace!.stages.find((stage) => stage.stage === 'escalation')!;
      expect(escalationStage.calls.map((call) => call.outcome)).toEqual(['validation_error', 'success']);
      expect(escalationStage.decisions).toEqual([{ id: expect.any(String), decision: 'reject' }]);
      expect(result.trace!.stages.find((stage) => stage.stage === 'verification')).toBeUndefined();
      expect(result.trace!.finalFindings).toEqual([]);
    } finally { testDb.close(); }
  });

  it('does not correct malformed escalation output when retries are disabled', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    let escalationCalls = 0;
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete() {
      return JSON.stringify({ reviewedPaths: paths, summary: 'Initial.', verdict: 'request_changes', findings: [finding(1, 'Primary')] });
    } };
    const escalation: LLMProvider = { ...initial, model: 'strong', async complete() {
      escalationCalls++;
      return JSON.stringify({ reviewedPaths: [] });
    } };
    try {
      await expect(reviewPullRequest({ db: testDb, llm: initial, escalationLlm: escalation, maxRetries: 0, retrieve: retrieveOne, github: fakeGithub(diff).github }, { repoId: REPO_ID, prNumber: 42, post: false, force: true })).rejects.toThrow('Invalid escalation response');
      expect(escalationCalls).toBe(1);
    } finally { testDb.close(); }
  });

  it('shares one corrective retry across escalation and verification', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete() {
      return JSON.stringify({ reviewedPaths: paths, summary: 'Initial.', verdict: 'request_changes', findings: [finding(1, 'Primary')] });
    } };
    let escalationCalls = 0;
    const escalation: LLMProvider = { ...initial, model: 'strong', async complete(req) {
      escalationCalls++;
      const payload = JSON.parse(req.messages[0]!.content) as { provisionalFindings: Array<{ id: string }> };
      return escalationCalls === 1
        ? JSON.stringify({ reviewedPaths: [] })
        : JSON.stringify({ reviewedPaths: paths, decisions: payload.provisionalFindings.map(({ id }) => ({ id, decision: 'retain' })), findings: [] });
    } };
    let verifierCalls = 0;
    const verifier: LLMProvider = { ...initial, async complete() {
      verifierCalls++;
      return JSON.stringify({ decisions: [] });
    } };
    try {
      await expect(reviewPullRequest({ db: testDb, llm: initial, escalationLlm: escalation, verifierLlm: verifier, maxRetries: 1, retrieve: retrieveOne, github: fakeGithub(diff).github }, { repoId: REPO_ID, prNumber: 42, post: false, force: true })).rejects.toThrow('Invalid verification response');
      expect(escalationCalls).toBe(2);
      expect(verifierCalls).toBe(1);
    } finally { testDb.close(); }
  });

  it.each([
    { failure: 'malformed verifier citations', decisions: [{ id: 0, decision: 'supported', explanation: 'bad citation', evidence: { path: 'src/mixed.ts', line: 999 } }] },
    { failure: 'null verifier decisions', decisions: [null] },
  ])('uses one corrective retry for $failure with exact evidence lines', async ({ decisions }) => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete() {
      return JSON.stringify({ reviewedPaths: paths, summary: 'Initial.', verdict: 'request_changes', findings: [finding(1, 'Primary')] });
    } };
    const requests: CompleteRequest[] = [];
    const verifier: LLMProvider = { ...initial, async complete(req) {
      requests.push(req);
      const payload = JSON.parse(req.messages[0]!.content) as { findings: Array<{ id: number; finding: Finding }> };
      return requests.length === 1
        ? JSON.stringify({ decisions })
        : JSON.stringify({ decisions: payload.findings.map(({ id, finding: item }) => ({ id, decision: 'supported', explanation: 'Current evidence supports it.', evidence: { path: item.path, line: item.line } })) });
    } };
    try {
      const result = await reviewPullRequest({ db: testDb, llm: initial, verifierLlm: verifier, retrieve: retrieveOne, github: fakeGithub(diff, PR, { headFiles: { 'src/mixed.ts': 'const token = request.token;\nnewCall();' } }).github }, { repoId: REPO_ID, prNumber: 42, post: false, force: true });
      expect(requests).toHaveLength(2);
      const correction = JSON.parse(requests[1]!.messages[0]!.content) as { validationError?: string; allowedPathsAndLines?: unknown };
      expect(correction.validationError).toContain('verification');
      expect(correction.allowedPathsAndLines).toEqual([{ path: 'src/mixed.ts', lines: [1, 2] }]);
      expect(result.findings).toHaveLength(1);
      expect(result.trace!.stages.find((stage) => stage.stage === 'verification')!.calls.map((call) => call.outcome)).toEqual(['validation_error', 'success']);
      expect(result.trace!.stages.find((stage) => stage.stage === 'verification')!.decisions).toEqual([{ id: 0, decision: 'supported' }]);
    } finally { testDb.close(); }
  });

  it('traces verifier execution when escalation adds the only finding', async () => {
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    const added = finding(1, 'Escalated finding');
    const initial: LLMProvider = { name: 'openrouter', model: 'cheap', concurrency: 1, supportsBatchReview: true, async complete() {
      return JSON.stringify({ reviewedPaths: paths, summary: 'Initial.', verdict: 'approve', findings: [] });
    } };
    const escalation: LLMProvider = { ...initial, model: 'strong', async complete(req) {
      const payload = JSON.parse(req.messages[0]!.content) as { provisionalFindings: Array<{ id: string }> };
      return JSON.stringify({ reviewedPaths: paths, decisions: payload.provisionalFindings.map(({ id }) => ({ id, decision: 'uncertain' })), findings: [added] });
    } };
    const verifier: LLMProvider = { ...initial, async complete(req) {
      const payload = JSON.parse(req.messages[0]!.content) as { findings: Array<{ id: number; finding: Finding }> };
      return JSON.stringify({ decisions: payload.findings.map(({ id, finding: item }) => ({ id, decision: 'supported', explanation: 'Current evidence supports it.', evidence: { path: item.path, line: item.line } })) });
    } };
    try {
      const result = await reviewPullRequest({ db: testDb, llm: initial, escalationLlm: escalation, verifierLlm: verifier, retrieve: retrieveOne, github: fakeGithub(diff, PR, { headFiles: { 'src/mixed.ts': 'const token = request.token;\nnewCall();' } }).github }, { repoId: REPO_ID, prNumber: 42, post: false, force: true });
      const stages = result.trace!.stages;
      expect(stages.map((stage) => stage.stage)).toEqual(['initial', 'escalation', 'verification', 'final']);
      expect(stages.find((stage) => stage.stage === 'verification')!.findings).toEqual([{ path: added.path, line: added.line, rootCauseMarker: expect.any(String) }]);
      expect(stages.find((stage) => stage.stage === 'verification')!.decisions).toEqual([{ id: 0, decision: 'supported' }]);
      expect(stages.find((stage) => stage.stage === 'verification')!.findingCount).toBe(1);
      const serialized = JSON.stringify(result.trace);
      expect(serialized).toContain('rootCauseMarker');
      expect(serialized).not.toContain(added.title);
      expect(serialized).not.toContain(added.body);
      expect(serialized).not.toContain(added.evidence!.trigger);
      expect(serialized).not.toContain(added.evidence!.consequence);
    } finally { testDb.close(); }
  });
});

describe('isReviewablePath', () => {
  it('accepts source files', () => {
    for (const p of ['src/app.ts', 'lib/main.py', 'README.md', 'Dockerfile', 'scripts/build.ts', 'src/distance.ts']) {
      expect(isReviewablePath(p), p).toBe(true);
    }
  });

  it('rejects lockfiles, vendored trees, build output and binaries', () => {
    for (const p of [
      'package-lock.json',
      'a/b/yarn.lock',
      'pnpm-lock.yaml',
      'Cargo.lock',
      'go.sum',
      'node_modules/x/index.js',
      'web/node_modules/x/index.js',
      'vendor/lib.go',
      'dist/bundle.js',
      'build/out.js',
      'packages/web/dist/index.js',
      'static/app.min.js',
      'assets/logo.png',
      'fonts/a.woff2',
      'tests/__snapshots__/a.test.ts.snap',
      'dist/app.js.map',
      'src/generated/client.ts',
      'src/schema.generated.ts',
      'src/events.pb.go',
      '',
    ]) {
      expect(isReviewablePath(p), p).toBe(false);
    }
    expect(isReviewablePath('src/generated/client.ts', ['docs/**'])).toBe(false);
    expect(isReviewablePath('src/docs.ts', ['docs/**'])).toBe(true);
    expect(isReviewablePath('docs/api.ts', ['docs/**'])).toBe(false);
  });
});

describe('generated file detection', () => {
  it('requires a standard generated marker and ignores generated imports', () => {
    expect(hasGeneratedHeader(parseUnifiedDiff(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1,2 @@
 import { generated } from './types.generated.js';
+export const value = generated;
`)[0]!)).toBe(false);
    expect(hasGeneratedHeader(parseUnifiedDiff(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1,2 @@
 // Code generated by tool. DO NOT EDIT.
+export const value = 1;
    `)[0]!)).toBe(true);
    expect(hasGeneratedHeader(parseUnifiedDiff(`diff --git a/src/a.ts b/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +0,0 @@
-// Code generated by tool. DO NOT EDIT.
`)[0]!)).toBe(false);
  });

  it('recognizes an unchanged generated marker in the changed context', async () => {
    const diff = `diff --git a/src/client.ts b/src/client.ts
--- a/src/client.ts
+++ b/src/client.ts
@@ -1,2 +1,3 @@
 // Code generated by tool. DO NOT EDIT.
 const existing = true;
+export const changed = true;
`;
    const gh = fakeGithub(diff, PR, { headFiles: { 'src/client.ts': 'const existing = true;\nexport const changed = true;\n' } });
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    try {
      const result = await reviewPullRequest({ db: testDb, llm: fakeLlm().provider, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42, post: false });
      expect(result.skippedFiles).toContain('src/client.ts');
    } finally {
      testDb.close();
    }
  });

  it('uses head content to detect a generated header outside the changed hunk', async () => {
    const diff = `diff --git a/src/client.ts b/src/client.ts
--- a/src/client.ts
+++ b/src/client.ts
@@ -99,1 +99,2 @@
 const existing = true;
+export const changed = true;
`;
    const gh = fakeGithub(diff, PR, { headFiles: { 'src/client.ts': '// Code generated by tool. DO NOT EDIT.\nconst existing = true;\nexport const changed = true;\n' } });
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    try {
      const result = await reviewPullRequest({ db: testDb, llm: fakeLlm().provider, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42, post: false });
      expect(result.skippedFiles).toContain('src/client.ts');
      expect(result.findings).toEqual([]);
    } finally {
      testDb.close();
    }
  });

  it('reviews execution when the generated marker was removed', async () => {
    const diff = `diff --git a/src/client.ts b/src/client.ts
--- a/src/client.ts
+++ b/src/client.ts
@@ -1,3 +1,3 @@
-// Code generated by tool. DO NOT EDIT.
 const existing = true;
+export const changed = true;
`;
    const gh = fakeGithub(diff, PR, { headFiles: { 'src/client.ts': 'const existing = true;\nexport const changed = true;\n' } });
    const testDb = openDb(':memory:');
    testDb.upsertRepo({ id: REPO_ID, remote: 'https://github.com/o/r.git', owner: 'o', name: 'r', branch: 'main' });
    try {
      const result = await reviewPullRequest({ db: testDb, llm: fakeLlm().provider, retrieve: retrieveOne, github: gh.github }, { repoId: REPO_ID, prNumber: 42, post: false });
      expect(result.skippedFiles).not.toContain('src/client.ts');
    } finally {
      testDb.close();
    }
  });
});

describe('buildReviewBody', () => {
  const findings: Finding[] = [
    { path: 'src/a.ts', line: 4, severity: 'critical', title: 'Bad | thing', body: 'x' },
    { path: 'src/b.ts', line: 9, severity: 'nit', title: 'Tiny', body: 'y' },
  ];

  it('renders the header, counts, table and footer', () => {
    const body = buildReviewBody({ summary: 'It changes things.', verdict: 'request_changes', findings, providerName: 'fake', model: 'm1' });
    expect(body.startsWith('## RepoLens review')).toBe(true);
    expect(body).toContain('It changes things.');
    expect(body).toContain('**Verdict:** request_changes · **Findings:** 2 (1 critical, 0 warnings, 1 nits)');
    expect(body).toContain('| Severity | File | Title |');
    expect(body).toContain('| critical | src/a.ts:4 | Bad \\| thing |');
    expect(body).toContain('| nit | src/b.ts:9 | Tiny |');
    expect(body.trimEnd().endsWith('<sub>Generated by RepoLens (fake/m1)</sub>')).toBe(true);
  });

  it('omits the table when there are no findings', () => {
    const body = buildReviewBody({ summary: 'Nothing to flag.', verdict: 'approve', findings: [], providerName: 'p', model: 'm' });
    expect(body).not.toContain('| Severity |');
    expect(body).toContain('**Findings:** 0 (0 critical, 0 warnings, 0 nits)');
  });
});

describe('default injectable helpers', () => {
  it('extracts deduped identifiers capped at 40', () => {
    expect(defaultIdentifiers('const foo = foo + bar; a1 x')).toEqual(['const', 'foo', 'bar']);
    const many = Array.from({ length: 100 }, (_, i) => `name${i}`).join(' ');
    expect(defaultIdentifiers(many)).toHaveLength(40);
  });

  it('formats chunks as fenced sections', () => {
    expect(defaultFormatContext([CHUNK])).toBe('### src/x.ts:1-3\n```\nexport function x() { return 1; }\n```');
    expect(defaultFormatContext([])).toBe('');
  });
});
