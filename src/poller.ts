import type { AppDeps } from './app.js';
import { enqueueIndex, reviewKey, scheduleReview } from './app.js';

export interface PollOutcome {
  indexed: string[];
  reviewed: Array<{ repository: string; prNumber: number }>;
  errors: string[];
}

/**
 * Pull-based alternative to webhooks: look at every GitHub repository RepoLens knows
 * about, reindex when the tracked branch has moved, and review every open pull
 * request whose head commit has not been reviewed yet. Needs no inbound network
 * access, which suits a machine behind NAT running the CLI providers.
 */
export async function pollOnce(deps: AppDeps): Promise<PollOutcome> {
  const out: PollOutcome = { indexed: [], reviewed: [], errors: [] };
  const busyReviews = pendingReviews(deps);
  for (const repo of deps.db.listRepos()) {
    if (!repo.id.startsWith('github:')) continue;
    try {
      const inProgress = repo.status === 'queued' || repo.status === 'indexing';
      if (!inProgress && repo.branch) {
        const head = await deps.github.getBranchHead(repo.owner, repo.name, repo.branch);
        if (head && head !== repo.last_commit) {
          enqueueIndex(deps, repo.id);
          out.indexed.push(repo.id);
        }
      }
      const pulls = await deps.github.listOpenPulls(repo.owner, repo.name);
      for (const pr of pulls) {
        if (pr.draft || !pr.headSha) continue;
        const key = reviewKey(repo.id, pr.number);
        // A scheduled review is left alone: re-scheduling would restart its settle window.
        if (busyReviews.has(key) || deps.jobs.scheduled(key)) continue;
        if (deps.db.findReview(repo.id, pr.number, pr.headSha)?.posted) continue;
        scheduleReview(deps, repo.id, pr.number);
        busyReviews.add(key);
        out.reviewed.push({ repository: repo.id, prNumber: pr.number });
      }
    } catch (err) {
      out.errors.push(`${repo.id}: ${(err as Error).message}`);
    }
  }
  return out;
}

/** Reviews already queued or running, so a poll does not enqueue the same PR twice. */
function pendingReviews(deps: AppDeps): Set<string> {
  const keys = new Set<string>();
  for (const job of deps.db.listJobs(200)) {
    if (job.kind !== 'review' || (job.status !== 'queued' && job.status !== 'running')) continue;
    // A queued review always fetches the current head, so one per PR is enough.
    if (job.repo_id && job.pr_number !== null) keys.add(`${job.repo_id}#${job.pr_number}`);
  }
  return keys;
}

export function startPoller(deps: AppDeps, intervalMs: number, log: (msg: string) => void = () => {}): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (stopped) return;
    try {
      const r = await pollOnce(deps);
      const repos = deps.db.listRepos().filter((x) => x.id.startsWith('github:')).length;
      log(
        `poll: ${repos} GitHub repo(s) checked; reindex ${r.indexed.length}, review ${r.reviewed.length}` +
          (r.errors.length ? `; errors: ${r.errors.join('; ')}` : ''),
      );
    } catch (err) {
      log(`poll failed: ${(err as Error).message}`);
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  };
  timer = setTimeout(tick, 2000);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
