import type { AppDeps } from './app.js';
import { enqueueIndex, enqueueReview } from './app.js';

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
        const key = `${repo.id}#${pr.number}@${pr.headSha}`;
        if (busyReviews.has(key)) continue;
        if (deps.db.findReview(repo.id, pr.number, pr.headSha)?.posted) continue;
        const job = enqueueReview(deps, repo.id, pr.number, { post: true });
        deps.db.updateJob(job.id, { progress: `poll:${key}` });
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
    if (job.progress?.startsWith('poll:')) keys.add(job.progress.slice(5));
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
      if (r.indexed.length || r.reviewed.length || r.errors.length) {
        log(`poll: reindex ${r.indexed.length}, review ${r.reviewed.length}${r.errors.length ? `, errors: ${r.errors.join('; ')}` : ''}`);
      }
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
