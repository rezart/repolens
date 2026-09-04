import type { AppDeps } from '../app.js';
import { enqueueReview } from '../app.js';
import type { JobRow } from '../db.js';

export interface PullStatus {
  number: number;
  title: string;
  author: string;
  htmlUrl: string;
  headSha: string;
  baseRef: string;
  draft: boolean;
  updatedAt: string | null;
  review: {
    status: 'none' | 'pending' | 'reviewed' | 'error';
    reviewId?: number;
    posted?: boolean;
    verdict?: string | null;
    findings?: number;
    jobId?: number;
    error?: string;
  };
}

export interface ReviewPullsOptions {
  /** Review exactly these pull requests. Omitted means "every unreviewed open PR". */
  prNumbers?: number[];
  /** Post the reviews to GitHub (default true). */
  post?: boolean;
  /** Review again even when a review for the head commit already exists. */
  force?: boolean;
  /** Statuses from `listPullStatuses`; the caller fetches them so the API can reuse the list. */
  pulls?: PullStatus[];
}

export interface ReviewPullsResult {
  jobs: Array<{ prNumber: number; jobId: number }>;
  skipped: Array<{ prNumber: number; reason: string }>;
}

function findingCount(commentsJson: string): number {
  try {
    const parsed = JSON.parse(commentsJson) as unknown;
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function isPending(job: JobRow): boolean {
  return job.status === 'queued' || job.status === 'running';
}

/**
 * Open pull requests of a GitHub repository, each tagged with what RepoLens knows about
 * its review: one in flight, one already stored for the head commit, or the error of the
 * last attempt.
 */
export async function listPullStatuses(deps: AppDeps, repoId: string): Promise<PullStatus[]> {
  const repo = deps.db.getRepo(repoId);
  if (!repo) throw new Error(`Unknown repository ${repoId}`);
  if (!repoId.startsWith('github:')) throw new Error(`pull requests need a GitHub repository; ${repoId} is local`);

  const pulls = await deps.github.listOpenPulls(repo.owner, repo.name);
  const jobs = deps.db.listReviewJobsForRepo(repoId);

  return pulls.map((pr) => {
    const base = {
      number: pr.number,
      title: pr.title,
      author: pr.author,
      htmlUrl: pr.htmlUrl,
      headSha: pr.headSha,
      baseRef: pr.baseRef,
      draft: pr.draft,
      updatedAt: pr.updatedAt,
    };
    // Latest first, so the first match is the most recent job for this PR.
    const prJobs = jobs.filter((j) => j.pr_number === pr.number);
    const pending = prJobs.find(isPending);
    if (pending) return { ...base, review: { status: 'pending' as const, jobId: pending.id } };

    const review = pr.headSha ? deps.db.findReview(repoId, pr.number, pr.headSha) : undefined;
    if (review) {
      return {
        ...base,
        review: {
          status: 'reviewed' as const,
          reviewId: review.id,
          posted: review.posted === 1,
          verdict: review.verdict,
          findings: findingCount(review.comments_json),
        },
      };
    }

    const last = prJobs[0];
    if (last?.status === 'error') {
      return { ...base, review: { status: 'error' as const, jobId: last.id, error: last.error ?? 'review failed' } };
    }
    return { ...base, review: { status: 'none' as const } };
  });
}

/**
 * Queue reviews for a repository's pull requests. Without `prNumbers` this targets every
 * open, non-draft PR that has no review for its head commit; explicit numbers are reviewed
 * even when the PR is a draft. A review already queued or running is never duplicated.
 */
export function reviewPulls(deps: AppDeps, repoId: string, opts: ReviewPullsOptions = {}): ReviewPullsResult {
  const pulls = opts.pulls ?? [];
  const out: ReviewPullsResult = { jobs: [], skipped: [] };
  const enqueue = (prNumber: number) => {
    const job = enqueueReview(deps, repoId, prNumber, { post: opts.post ?? true, force: opts.force });
    out.jobs.push({ prNumber, jobId: job.id });
  };

  if (opts.prNumbers) {
    const byNumber = new Map(pulls.map((p) => [p.number, p]));
    for (const prNumber of opts.prNumbers) {
      const status = byNumber.get(prNumber)?.review.status;
      // A queued review picks up the current head commit, so a second one adds nothing.
      if (status === 'pending' && !opts.force) {
        out.skipped.push({ prNumber, reason: 'already queued' });
        continue;
      }
      if (status === 'reviewed' && !opts.force) {
        out.skipped.push({ prNumber, reason: 'already reviewed' });
        continue;
      }
      enqueue(prNumber);
    }
    return out;
  }

  for (const pull of pulls) {
    const status = pull.review.status;
    if (status === 'pending') {
      out.skipped.push({ prNumber: pull.number, reason: 'already queued' });
      continue;
    }
    if (pull.draft) {
      out.skipped.push({ prNumber: pull.number, reason: 'draft' });
      continue;
    }
    if (status === 'reviewed' && !opts.force) {
      out.skipped.push({ prNumber: pull.number, reason: 'already reviewed' });
      continue;
    }
    enqueue(pull.number);
  }
  return out;
}
