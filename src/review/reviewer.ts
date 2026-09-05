import type { Db, RepoRow } from '../db.js';
import type { CompleteRequest, LLMProvider } from '../llm/types.js';
import { reviewCostUpperBound, REVIEW_MAX_USD, REVIEW_MAX_OUTPUT } from './budget.js';
import { extractJson } from '../llm/json.js';
import type { RetrieveFn, RetrievedChunk } from '../search/types.js';
import { truncateDescription } from './github.js';
import type { CommitStatusState, GitHubClient, PullRequest } from './github.js';
import { parseUnifiedDiff, changedNewLines, hunkText, type DiffFile } from './diff.js';
import { buildLineage, deltaForFile, type Lineage } from './lineage.js';
import {
  FILE_REVIEW_SYSTEM_PROMPT,
  BATCH_REVIEW_SYSTEM_PROMPT,
  SUMMARY_SYSTEM_PROMPT,
  buildFileReviewMessage,
  buildSummaryMessage,
} from './prompts.js';

export type Severity = 'critical' | 'warning' | 'nit';
export type Verdict = 'approve' | 'comment' | 'request_changes';
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
  /** The commit status reported on the PR head, when statuses are enabled. */
  status?: ReviewStatus;
}

export interface ReviewDeps {
  db: Db;
  llm: LLMProvider;
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
  >;
  /** Injected from search/tokenize.ts in production. */
  identifiers?: (text: string) => string[];
  /** Injected from search/retrieve.ts in production. */
  formatContext?: (chunks: RetrievedChunk[]) => string;
  maxFiles?: number;
  /** Commit status context reported on the PR head; blank/undefined disables statuses. */
  statusContext?: string;
  /** Which findings turn the commit status red (default `critical`). */
  failOn?: FailOn;
  /** Base URL of this RepoLens install, used as a status target when the PR has no URL. */
  publicUrl?: string;
  log?: (msg: string) => void;
}

export interface ReviewOptions {
  repoId: string;
  prNumber: number;
  /** Post the review to GitHub (default true). */
  post?: boolean;
  /** Re-review even when a review for this head sha already exists. */
  force?: boolean;
}

const SEVERITIES: readonly Severity[] = ['critical', 'warning', 'nit'];

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
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

const SKIP_DIRS = ['node_modules/', 'vendor/', 'dist/', 'build/', '.next/', 'out/', 'target/', 'coverage/', '.venv/'];

const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'avif', 'tiff', 'svgz',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar', 'war',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'mp4', 'mov', 'avi', 'webm', 'wav', 'ogg', 'flac',
  'so', 'dylib', 'dll', 'exe', 'bin', 'wasm', 'class', 'o', 'a',
  'pyc', 'pyo', 'db', 'sqlite', 'sqlite3', 'parquet',
]);

/** Files RepoLens will not spend an LLM call on. */
export function isReviewablePath(path: string): boolean {
  if (!path) return false;
  const lower = path.toLowerCase();
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  if (LOCKFILES.has(base)) return false;
  if (SKIP_DIRS.some((d) => lower === d.slice(0, -1) || lower.startsWith(d) || lower.includes(`/${d}`))) return false;
  if (base.endsWith('.snap')) return false;
  if (/\.min\.(js|css|mjs|cjs)$/.test(base)) return false;
  if (/[.-]bundle\.js$/.test(base)) return false;
  if (base.endsWith('.map')) return false;
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

/* ------------------------------------------------------------------ PR head context */

/** How many changed files RepoLens fetches the post-change content of. */
const HEAD_FILES_MAX = 60;
/** Files larger than this are not worth a prompt slot. */
const HEAD_FILE_CHARS_MAX = 60_000;
/** Concurrent `contents` requests. */
const HEAD_FETCH_CONCURRENCY = 4;
/** Per referenced file, inside the head-context section. */
const HEAD_SNIPPET_CHARS_MAX = 8_000;
/** Total budget for referenced files (the reviewed file's own content is separate). */
const HEAD_CONTEXT_CHARS_MAX = 24_000;
/** The reviewed file's own content is included in full only up to this size. */
const OWN_HEAD_CHARS_MAX = 12_000;

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

function clipContent(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n... (truncated)` : text;
}

function headBlock(path: string, content: string, max: number): string {
  return `### ${path} (content after this pull request)\n\`\`\`\n${clipContent(content, max)}\n\`\`\``;
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
  /** Precomputed `exportedNames` per path; recomputed here when absent. */
  exportsByPath?: Map<string, Set<string>>;
}): string {
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

  const blocks: string[] = [];
  let used = 0;
  for (const referenced of [...imported, ...byExport]) {
    const content = headContents.get(referenced);
    if (content === undefined) continue;
    const block = headBlock(referenced, content, HEAD_SNIPPET_CHARS_MAX);
    if (used + block.length > HEAD_CONTEXT_CHARS_MAX) break;
    blocks.push(block);
    used += block.length + 2;
  }

  // The diff alone hides the code around the hunks, so lead with the whole file.
  if (own !== undefined && own.length <= OWN_HEAD_CHARS_MAX) {
    blocks.unshift(headBlock(path, own, OWN_HEAD_CHARS_MAX));
  }
  return blocks.join('\n\n');
}

export function buildReviewBody(input: {
  summary: string;
  verdict: Verdict;
  findings: Finding[];
  providerName: string;
  model: string;
  lineage?: Pick<Lineage, 'reviewNumber' | 'previous'>;
}): string {
  const counts = { critical: 0, warning: 0, nit: 0 };
  for (const f of input.findings) counts[f.severity]++;
  const parts: string[] = ['## RepoLens review', '', input.summary.trim(), ''];
  parts.push(
    `**Verdict:** ${input.verdict} · **Findings:** ${input.findings.length} (${counts.critical} critical, ${counts.warning} warnings, ${counts.nit} nits)`,
  );
  if (input.findings.length) {
    parts.push('');
    parts.push('| Severity | File | Title |');
    parts.push('| --- | --- | --- |');
    for (const f of input.findings) {
      parts.push(`| ${f.severity} | ${f.path}:${f.line} | ${escapeCell(f.title)} |`);
    }
  }
  parts.push('');
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

function parseFindings(raw: string, file: DiffFile, allowed: Set<number>): Finding[] {
  const parsed = extractJson(raw) as { findings?: unknown } | unknown[];
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.findings) ? (parsed.findings as unknown[]) : null;
  if (!list) throw new Error('model output has no "findings" array');
  const path = file.newPath ?? file.oldPath ?? '';
  const out: Finding[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const line = typeof e.line === 'number' ? e.line : typeof e.line === 'string' ? Number(e.line) : NaN;
    if (!Number.isInteger(line) || !allowed.has(line)) continue;
    const title = typeof e.title === 'string' ? e.title.trim() : '';
    const body = typeof e.body === 'string' ? e.body.trim() : '';
    if (!title && !body) continue;
    const sevRaw = typeof e.severity === 'string' ? e.severity.toLowerCase().trim() : '';
    const severity = (SEVERITIES as readonly string[]).includes(sevRaw) ? (sevRaw as Severity) : 'warning';
    out.push({ path, line, severity, title: title || body.slice(0, 60), body: body || title });
  }
  return out;
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
  llm: LLMProvider;
  repo: RepoRow;
  pr: PullRequest;
  log: (msg: string) => void;
  /** Set by runReview; a cached review is re-posted with its original body. */
  lineage?: Pick<Lineage, 'reviewNumber' | 'previous'>;
}

/**
 * Post `result` to GitHub, mutating it in place. Never throws: a failed post leaves
 * `posted: false` and adds a warning so the stored review can be re-posted later.
 */
async function postReview(ctx: PostContext, result: ReviewResult): Promise<void> {
  const { db, github, llm, repo, pr, log } = ctx;
  const warnings = result.warnings;

  let body = buildReviewBody({
    summary: result.summary,
    verdict: result.verdict,
    findings: result.findings,
    providerName: llm.name,
    model: llm.model,
    lineage: ctx.lineage,
  });
  // Retrieved context comes from the last indexed commit, not the PR head.
  if (repo.last_commit && pr.baseSha && repo.last_commit !== pr.baseSha) {
    body += `\n<sub>Context indexed at ${shortSha(repo.last_commit)}; PR base is ${shortSha(pr.baseSha)}.</sub>`;
  }

  // Drop findings that were already commented on an earlier run (e.g. a `synchronize` event).
  let comments = result.findings;
  try {
    const existing = await github.listReviewComments(repo.owner, repo.name, result.prNumber);
    const kept = comments.filter(
      (f) => !existing.some((c) => c.path === f.path && c.line === f.line && c.body.includes(f.title)),
    );
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

  try {
    // Never APPROVE automatically — an "approve" verdict still posts as a COMMENT review.
    const created = await github.createReview(repo.owner, repo.name, result.prNumber, {
      commitId: pr.headSha,
      body,
      event: result.verdict === 'request_changes' ? 'REQUEST_CHANGES' : 'COMMENT',
      comments: comments.map((f) => ({
        path: f.path,
        line: f.line,
        body: `**[${f.severity}] ${f.title}**\n\n${f.body}`,
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
  const postCtx: PostContext = { db, github, llm, repo, pr, log };

  // Commit statuses need a GitHub repository and a head commit to attach to.
  const statusEnabled = Boolean(statusContext) && opts.repoId.startsWith('github:') && Boolean(repo.owner && repo.name && pr.headSha);
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

  const cached = opts.force ? null : db.findReview(opts.repoId, opts.prNumber, pr.headSha);
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
      const cachedResult: ReviewResult = {
        reviewId: cached.id,
        prNumber: cached.pr_number,
        headSha: cached.head_sha,
        summary: cached.summary ?? '',
        verdict: toVerdict(cached.verdict) ?? 'comment',
        findings,
        posted: cached.posted === 1,
        skippedFiles: [],
        warnings: statusWarnings,
      };
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
    // The check must not stay pending forever when the review itself blows up.
    // Descriptions are capped at 140 characters, so a long message would make the
    // status call fail too and leave the check pending.
    await setStatus(
      { state: 'error', description: truncateDescription(`RepoLens review failed: ${errMessage(err)}`) },
      pr.htmlUrl,
      statusWarnings,
    );
    throw err;
  }

  async function runReview(): Promise<ReviewResult> {
    const diffText = await github.getPullDiff(repo.owner, repo.name, opts.prNumber);
    const parsed = parseUnifiedDiff(diffText);

    const warnings: string[] = [...statusWarnings];

    const lineage = await buildLineage(
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
      if (f.status !== 'deleted' && f.newPath) changedPaths.push(f.newPath);
    }

    const skippedFiles: string[] = [];
    const reviewable: DiffFile[] = [];
    for (const f of parsed) {
      const path = f.newPath;
      if (f.binary || f.status === 'deleted' || !path || !isReviewablePath(path)) {
        const label = path ?? f.oldPath ?? '(unknown)';
        skippedFiles.push(label);
        continue;
      }
      if (changedNewLines(f).size === 0) {
        skippedFiles.push(path);
        continue;
      }
      reviewable.push(f);
    }

    const budgeted = llm.name === 'openrouter' && llm.model === 'qwen/qwen3-coder';
    // Check the unsliced list: `files` below can never exceed maxFiles.
    if (budgeted && reviewable.length > maxFiles) {
      throw new Error('Review exceeds the file limit; split this pull request before reviewing.');
    }
    const files = reviewable.slice(0, maxFiles);
    for (const extra of reviewable.slice(maxFiles)) skippedFiles.push(extra.newPath!);

    // Fetch the PR head once for the whole review: the search index only knows the
    // base branch, so without this the model judges new code against old exports.
    const headContents = new Map<string, string>();
    const fetchable = parsed
      .filter((f) => f.status !== 'deleted' && !f.binary && f.newPath && isReviewablePath(f.newPath))
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
        if (content.length > HEAD_FILE_CHARS_MAX) {
          warnings.push(`${path}: post-change content skipped (${content.length} chars over the ${HEAD_FILE_CHARS_MAX} limit)`);
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

    let batch: { findings: Finding[]; summary: string; verdict: Verdict } | undefined;
    if (budgeted) {
      const req: CompleteRequest = {
        system: BATCH_REVIEW_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify({
          prTitle: pr.title, prBody: pr.body, instructions: repo.instructions,
          overview: lineage.overview, commits: lineage.commits,
          previous: lineage.previous ? { ...lineage.previous, delta: undefined } : undefined,
          files: files.map((f) => ({
            path: f.newPath!, status: f.status, diff: hunkText(f, Infinity),
            delta: lineage.previous ? deltaForFile(lineage.previous, f.newPath!) : undefined,
          })),
        }) }],
        json: true, maxTokens: REVIEW_MAX_OUTPUT, reviewBudget: true,
      };
      // Reject the core prompt before the retrieval loop or any inference call.
      if (reviewCostUpperBound(req) > REVIEW_MAX_USD) {
        throw new Error('Review exceeds the $0.05 budget; split this pull request into smaller reviews.');
      }
      // Share each context block once across all files; changed code always gets
      // its full diff before optional context consumes any of the budget.
      let omitted = 0;
      const addContext = (block: string) => {
        const previous = req.messages[0]!.content;
        req.messages[0]!.content += `\n\n${block}`;
        if (reviewCostUpperBound(req) > REVIEW_MAX_USD) {
          req.messages[0]!.content = previous;
          omitted++;
        }
      };
      for (const [path, content] of headContents) {
        addContext(`Files changed in this pull request (post-change content, authoritative):\n${JSON.stringify({ path, content })}`);
      }
      const seen = new Set<number>();
      for (const file of files) {
        const added = file.hunks.flatMap((h) => h.lines.filter((l) => l.type === 'add').map((l) => l.content)).join('\n');
        try {
          const chunks = await retrieve({ repoIds: [opts.repoId], query: [file.newPath!, ...identifiers(added)].join(' '), limit: 8, excludePaths: changedPaths, lexicalOnly: true });
          for (const chunk of chunks) {
            if (seen.has(chunk.chunkId)) continue;
            seen.add(chunk.chunkId);
            addContext(`Related code from the base-branch index:\n${formatContext([chunk])}`);
          }
        } catch (err) {
          warnings.push(`${file.newPath}: retrieval failed: ${errMessage(err)}`);
        }
      }
      if (omitted) warnings.push(`${omitted} optional context blocks omitted to keep the review within $0.05; all file diffs included.`);
      await assertHeadUnchanged();
      // Parsing failures reach reviewPullRequest's outer catch (error status),
      // then JobQueue records a failed job. Never turn invalid JSON into approval.
      const obj = extractJson(await llm.complete(req)) as Record<string, unknown>;
      if (!obj || !Array.isArray(obj.findings) || typeof obj.summary !== 'string' || !obj.summary.trim() ||
          !toVerdict(obj.verdict) || !Array.isArray(obj.reviewedPaths) ||
          files.some((f) => !(obj.reviewedPaths as unknown[]).includes(f.newPath)) ||
          obj.findings.some((f: unknown) => !f || typeof f !== 'object' || !files.some((file) => file.newPath === (f as { path?: unknown }).path))) {
        throw new Error('Incomplete review response; no review was published.');
      }
      batch = {
        findings: files.flatMap((file) => parseFindings(JSON.stringify({
          findings: (obj.findings as Array<{ path?: string } | null>).filter((f) => f?.path === file.newPath),
        }), file, changedNewLines(file))),
        summary: obj.summary.trim(), verdict: toVerdict(obj.verdict)!,
      };
    }

    const perFile = batch ? [batch.findings] : await mapPool(files, llm.concurrency, async (file) => {
      const path = file.newPath!;
      const allowed = changedNewLines(file);
      const addedText = file.hunks
        .flatMap((h) => h.lines.filter((l) => l.type === 'add').map((l) => l.content))
        .join('\n');
      const query = [path, ...identifiers(addedText)].join(' ');
      const headContext = buildHeadContext({ path, addedText, headContents, exportsByPath });
      let context = '';
      try {
        // Excluding every changed path keeps pre-change chunks of this PR's files
        // out of the prompt; their post-change content is in `headContext` instead.
        const chunks = await retrieve({ repoIds: [opts.repoId], query, limit: 8, excludePaths: changedPaths });
        context = formatContext(chunks);
      } catch (err) {
        warnings.push(`${path}: retrieval failed: ${errMessage(err)}`);
      }
      await assertHeadUnchanged();
      try {
        const raw = await llm.complete({
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
                lineage,
                delta: lineage.previous ? deltaForFile(lineage.previous, path) : undefined,
              }),
            },
          ],
          json: true,
          maxTokens: 2000,
        });
        return parseFindings(raw, file, allowed);
      } catch (err) {
        const msg = `${path}: ${errMessage(err)}`;
        warnings.push(msg);
        log(`review: ${msg}`);
        return [] as Finding[];
      }
    });

    const findings = perFile.flat().sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.path.localeCompare(b.path) || a.line - b.line);
    const hasCritical = findings.some((f) => f.severity === 'critical');

    await assertHeadUnchanged();
    let summary = '';
    let verdict: Verdict = 'comment';
    try {
      if (batch) {
        summary = batch.summary;
        verdict = batch.verdict;
      } else {
        const raw = await llm.complete({
          system: SUMMARY_SYSTEM_PROMPT,
          messages: [
            {
              role: 'user',
              content: buildSummaryMessage({
                prTitle: pr.title,
                prBody: pr.body,
                files: files.map((f) => ({ path: f.newPath!, status: f.status })),
                findings,
                lineage,
              }),
            },
          ],
          json: true,
          maxTokens: 800,
        });
        const obj = extractJson(raw) as Record<string, unknown>;
        summary = typeof obj?.summary === 'string' ? obj.summary.trim() : '';
        verdict = toVerdict(obj?.verdict) ?? 'comment';
        if (!summary) throw new Error('summary missing from model output');
      }
    } catch (err) {
      const msg = `summary: ${errMessage(err)}`;
      warnings.push(msg);
      log(`review: ${msg}`);
      summary = `Reviewed ${files.length} files, ${findings.length} findings.`;
      verdict = 'comment';
    }
    if (verdict === 'request_changes' && !hasCritical) verdict = 'comment';

    if (!repo.last_commit) {
      warnings.push('Repository has not been indexed; review ran without codebase context.');
    }

    const row = db.insertReview({
      repo_id: opts.repoId,
      pr_number: opts.prNumber,
      head_sha: pr.headSha,
      status: 'done',
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
    };

    if (post) await postReview(postCtx, result);

    return result;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
