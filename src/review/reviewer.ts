import type { Db, RepoRow } from '../db.js';
import type { LLMProvider } from '../llm/types.js';
import { extractJson } from '../llm/json.js';
import type { RetrieveFn, RetrievedChunk } from '../search/types.js';
import { truncateDescription } from './github.js';
import type { CommitStatusState, GitHubClient, PullRequest } from './github.js';
import { parseUnifiedDiff, changedNewLines, hunkText, type DiffFile } from './diff.js';
import {
  FILE_REVIEW_SYSTEM_PROMPT,
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
  github: Pick<GitHubClient, 'getPull' | 'getPullDiff' | 'createReview' | 'listReviewComments' | 'createCommitStatus'>;
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

export function buildReviewBody(input: {
  summary: string;
  verdict: Verdict;
  findings: Finding[];
  providerName: string;
  model: string;
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

    const files = reviewable.slice(0, maxFiles);
    for (const extra of reviewable.slice(maxFiles)) skippedFiles.push(extra.newPath!);

    const warnings: string[] = [...statusWarnings];

    const perFile = await mapPool(files, llm.concurrency, async (file) => {
      const path = file.newPath!;
      const allowed = changedNewLines(file);
      const addedText = file.hunks
        .flatMap((h) => h.lines.filter((l) => l.type === 'add').map((l) => l.content))
        .join('\n');
      const query = [path, ...identifiers(addedText)].join(' ');
      let context = '';
      try {
        const chunks = await retrieve({ repoIds: [opts.repoId], query, limit: 8, excludePath: path });
        context = formatContext(chunks);
      } catch (err) {
        warnings.push(`${path}: retrieval failed: ${errMessage(err)}`);
      }
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
                context,
                instructions: repo.instructions,
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

    let summary = '';
    let verdict: Verdict = 'comment';
    try {
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
