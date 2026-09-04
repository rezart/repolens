import type { ReviewRow } from '../db.js';
import type { Finding } from './reviewer.js';
import type { PullCommit } from './github.js';
import { parseUnifiedDiff, hunkText, type DiffFile } from './diff.js';

/** Overview docs read from the base sha, first match wins, in this order. */
export const OVERVIEW_PATHS = ['CLAUDE.md', 'ARCHITECTURE.md', 'docs/ARCHITECTURE.md', 'README.md'];
export const OVERVIEW_CHARS_MAX = 12_000;

export interface PreviousReview {
  headSha: string;
  verdict: string;
  summary: string;
  findings: Finding[];
  /** Commits in the PR after the previously reviewed head (0 when the head is not in the list). */
  commitsSince: number;
  /** Parsed diff from the previous head to the current one; null when GitHub could not compare them. */
  delta: DiffFile[] | null;
}

export interface Lineage {
  /** 1 for the first review of this PR. */
  reviewNumber: number;
  commits: PullCommit[];
  previous?: PreviousReview;
  /** Concatenated overview docs, '' when none exist. */
  overview: string;
  warnings: string[];
}

/** Everything buildLineage needs, injected so tests use fakes. */
export interface LineageSources {
  previousReview: () => ReviewRow | undefined;
  reviewCount: () => number;
  compareDiff: (base: string, head: string) => Promise<string | null>;
  listCommits: () => Promise<PullCommit[]>;
  readFile: (path: string, ref: string) => Promise<string | null>;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function buildLineage(src: LineageSources, refs: { baseSha: string; headSha: string }): Promise<Lineage> {
  const warnings: string[] = [];

  let commits: PullCommit[] = [];
  try {
    commits = await src.listCommits();
  } catch (err) {
    warnings.push(`lineage: listing PR commits failed: ${errMessage(err)}`);
  }

  const parts: string[] = [];
  let used = 0;
  for (const path of OVERVIEW_PATHS) {
    if (used >= OVERVIEW_CHARS_MAX) break;
    try {
      const text = await src.readFile(path, refs.baseSha);
      if (text === null || !text.trim()) continue;
      const room = OVERVIEW_CHARS_MAX - used;
      const body = text.length > room ? `${text.slice(0, room)}\n... (truncated)` : text;
      parts.push(`### ${path}\n${body}`);
      used += text.length;
    } catch (err) {
      warnings.push(`lineage: reading ${path} at base failed: ${errMessage(err)}`);
    }
  }
  const overview = parts.join('\n\n');

  const row = src.previousReview();
  let previous: PreviousReview | undefined;
  if (row) {
    let findings: Finding[] = [];
    try {
      const parsed = JSON.parse(row.comments_json) as unknown;
      if (Array.isArray(parsed)) findings = parsed as Finding[];
    } catch {
      findings = [];
    }
    let delta: DiffFile[] | null = null;
    try {
      const text = await src.compareDiff(row.head_sha, refs.headSha);
      if (text !== null) delta = parseUnifiedDiff(text);
    } catch (err) {
      warnings.push(
        `lineage: comparing ${row.head_sha.slice(0, 7)}...${refs.headSha.slice(0, 7)} failed: ${errMessage(err)}`,
      );
    }
    const at = commits.findIndex((c) => c.sha === row.head_sha);
    previous = {
      headSha: row.head_sha,
      verdict: row.verdict ?? 'comment',
      summary: row.summary ?? '',
      findings,
      commitsSince: at >= 0 ? commits.length - at - 1 : 0,
      delta,
    };
  }

  return { reviewNumber: src.reviewCount() + 1, commits, previous, overview, warnings };
}

/** Text for the "changes since the previous review" prompt section of one file. */
export function deltaForFile(previous: PreviousReview, path: string): string {
  if (previous.delta === null) {
    return `Delta unavailable: GitHub could not compare ${previous.headSha.slice(0, 7)} with the current head (the previous head was probably force-pushed away). Treat the previous findings as possibly stale.`;
  }
  const file = previous.delta.find((f) => f.newPath === path);
  if (!file) return `This file is unchanged since the previous review at ${previous.headSha.slice(0, 7)}.`;
  return `Diff of this file from ${previous.headSha.slice(0, 7)} to the current head, with new-file line numbers:\n\n${hunkText(file)}`;
}
