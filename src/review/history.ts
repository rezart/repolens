import type { ReviewRow } from '../db.js';
import type { HistoricalPullRequest, PathCommit } from './github.js';

export interface HistoricalFinding {
  path: string;
  line: number;
  severity: string;
  title: string;
  body: string;
}

export interface HistoricalPr {
  number: number;
  title: string;
  body: string;
  htmlUrl: string;
  mergedAt: string;
  commitSha: string;
  commitUrl: string;
  findings: HistoricalFinding[];
}

export interface HistoricalSources {
  listPathCommits: (path: string, ref: string) => Promise<PathCommit[]>;
  listCommitPulls: (sha: string) => Promise<HistoricalPullRequest[]>;
  findLatestReview: (prNumber: number) => Pick<ReviewRow, 'comments_json'> | undefined;
}

export interface HistoricalContext {
  byPath: Map<string, HistoricalPr[]>;
  warnings: string[];
}

const MAX_PATHS = 8;
const MAX_COMMITS = 12;
const MAX_PRS = 3;
const MAX_FINDINGS = 8;

/**
 * Find a small amount of merged history for the files under review.
 * ponytail: eight paths, twelve commit lookups and three PRs cap GitHub calls;
 * add pagination or a richer history index only when this misses useful context.
 */
export async function buildHistoricalContext(
  src: HistoricalSources,
  input: { paths: string[]; baseSha: string; currentPrNumber: number; repository: string },
): Promise<HistoricalContext> {
  const byPath = new Map<string, HistoricalPr[]>();
  const warnings: string[] = [];
  const seenCommits = new Set<string>();
  const pullsByCommit = new Map<string, HistoricalPr[]>();
  const seenPulls = new Map<number, HistoricalPr>();
  let commitLookups = 0;

  for (const path of input.paths.slice(0, MAX_PATHS)) {
    let commits: PathCommit[];
    try {
      commits = await src.listPathCommits(path, input.baseSha);
    } catch (err) {
      warnings.push(`history: listing commits for ${path} failed: ${errMessage(err)}`);
      continue;
    }
    for (const commit of commits.slice(0, 3)) {
      if (!commit.sha) continue;
      const cachedPulls = pullsByCommit.get(commit.sha);
      if (cachedPulls) {
        addForPath(path, cachedPulls);
        continue;
      }
      if (commitLookups >= MAX_COMMITS) continue;
      if (seenCommits.has(commit.sha)) continue;
      seenCommits.add(commit.sha);
      commitLookups++;
      let pulls: HistoricalPullRequest[];
      try {
        pulls = await src.listCommitPulls(commit.sha);
      } catch (err) {
        warnings.push(`history: listing PRs for ${commit.sha.slice(0, 7)} failed: ${errMessage(err)}`);
        continue;
      }
      const historicalPulls: HistoricalPr[] = [];
      for (const pull of pulls) {
        if (!pull.number || !pull.mergedAt || pull.number === input.currentPrNumber ||
            pull.repository.toLowerCase() !== input.repository.toLowerCase()) continue;
        let historical = seenPulls.get(pull.number);
        if (!historical) {
          if (seenPulls.size >= MAX_PRS) continue;
          let findings: HistoricalFinding[] = [];
          try {
            findings = parseFindings(src.findLatestReview(pull.number));
          } catch (err) {
            warnings.push(`history: reading RepoLens review for PR #${pull.number} failed: ${errMessage(err)}`);
          }
          historical = { ...pull, mergedAt: pull.mergedAt, commitSha: commit.sha,
            commitUrl: commit.htmlUrl ?? `https://github.com/${input.repository}/commit/${commit.sha}`, findings };
          seenPulls.set(pull.number, historical);
        }
        historicalPulls.push(historical);
      }
      pullsByCommit.set(commit.sha, historicalPulls);
      addForPath(path, historicalPulls);
    }
  }
  return { byPath, warnings };

  function addForPath(path: string, pulls: HistoricalPr[]): void {
    const files = byPath.get(path) ?? [];
    for (const pull of pulls) {
      if (files.some((p) => p.number === pull.number)) continue;
      files.push({ ...pull, findings: pull.findings.filter((f) => f.path === path).slice(0, MAX_FINDINGS) });
    }
    if (files.length) byPath.set(path, files);
  }
}

function parseFindings(row: Pick<ReviewRow, 'comments_json'> | undefined): HistoricalFinding[] {
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.comments_json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((raw): HistoricalFinding[] => {
      if (!raw || typeof raw !== 'object') return [];
      const f = raw as Record<string, unknown>;
      if (typeof f.path !== 'string' || typeof f.title !== 'string') return [];
      return [{
        path: f.path,
        line: typeof f.line === 'number' ? f.line : 0,
        severity: typeof f.severity === 'string' ? f.severity : 'warning',
        title: f.title,
        body: typeof f.body === 'string' ? f.body.slice(0, 500) : '',
      }];
    });
  } catch {
    return [];
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
