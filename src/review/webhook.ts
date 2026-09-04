import type { AppDeps } from '../app.js';
import { enqueueReview } from '../app.js';
import { answerQuestion } from '../query/answer.js';
import { parseUnifiedDiff, hunkText } from './diff.js';

export interface WebhookOutcome {
  action: 'review' | 'chat' | 'ignored';
  reason?: string;
  jobId?: number;
  repository?: string;
}

interface PullRequestEvent {
  action?: string;
  number?: number;
  pull_request?: { number: number; draft?: boolean; head?: { sha: string } };
  repository?: { full_name?: string; clone_url?: string; default_branch?: string };
}

interface IssueCommentEvent {
  action?: string;
  issue?: { number: number; pull_request?: unknown };
  comment?: { body?: string; user?: { login?: string; type?: string } };
  repository?: { full_name?: string };
}

const REVIEW_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review']);

/**
 * Dispatch a GitHub webhook. Work is queued; the caller responds immediately.
 * Only repositories that have been added to RepoLens are handled.
 */
export function handleGitHubWebhook(deps: AppDeps, event: string, payload: unknown): WebhookOutcome {
  if (event === 'pull_request') return handlePullRequest(deps, payload as PullRequestEvent);
  if (event === 'issue_comment') return handleIssueComment(deps, payload as IssueCommentEvent);
  return { action: 'ignored', reason: `event ${event || '(none)'} not handled` };
}

function repoIdFromPayload(fullName: string | undefined): string | null {
  return fullName ? `github:${fullName}` : null;
}

function handlePullRequest(deps: AppDeps, p: PullRequestEvent): WebhookOutcome {
  const repoId = repoIdFromPayload(p.repository?.full_name);
  const number = p.pull_request?.number ?? p.number;
  if (!repoId || !number) return { action: 'ignored', reason: 'missing repository or PR number' };
  if (!p.action || !REVIEW_ACTIONS.has(p.action)) return { action: 'ignored', reason: `action ${p.action}` };
  if (p.pull_request?.draft) return { action: 'ignored', reason: 'draft PR' };
  if (!deps.db.getRepo(repoId)) return { action: 'ignored', reason: `${repoId} is not indexed by RepoLens` };
  const job = enqueueReview(deps, repoId, number, { post: true });
  return { action: 'review', jobId: job.id, repository: repoId };
}

function handleIssueComment(deps: AppDeps, p: IssueCommentEvent): WebhookOutcome {
  const repoId = repoIdFromPayload(p.repository?.full_name);
  const number = p.issue?.number;
  const body = p.comment?.body ?? '';
  const handle = deps.config.github.botHandle.toLowerCase();
  if (!repoId || !number) return { action: 'ignored', reason: 'missing repository or issue number' };
  if (p.action !== 'created') return { action: 'ignored', reason: `action ${p.action}` };
  if (!p.issue?.pull_request) return { action: 'ignored', reason: 'not a pull request comment' };
  if (p.comment?.user?.type === 'Bot') return { action: 'ignored', reason: 'bot comment' };
  if (!body.toLowerCase().includes(handle)) return { action: 'ignored', reason: 'bot not mentioned' };
  const repo = deps.db.getRepo(repoId);
  if (!repo) return { action: 'ignored', reason: `${repoId} is not indexed by RepoLens` };

  const question = body.replace(new RegExp(deps.config.github.botHandle, 'ig'), '').trim() || 'Explain this pull request.';
  const job = deps.jobs.enqueue('review', repoId, async (ctx) => {
    ctx.progress(`answering comment on PR #${number}`);
    const pr = await deps.github.getPull(repo.owner, repo.name, number);
    const diff = parseUnifiedDiff(await deps.github.getPullDiff(repo.owner, repo.name, number));
    const diffSummary = diff
      .filter((f) => !f.binary && f.newPath)
      .slice(0, 20)
      .map((f) => `#### ${f.newPath} (${f.status})\n${hunkText(f, 4000)}`)
      .join('\n\n');
    const extraContext = `Pull request #${pr.number}: ${pr.title}\n\n${pr.body}\n\n### Diff\n${diffSummary}`.slice(0, 30000);
    const answer = await answerQuestion({
      llm: deps.llm,
      retrieve: deps.retrieve,
      repoIds: [repoId],
      messages: [{ role: 'user', content: question }],
      extraContext,
    });
    const sources = answer.sources.map((s) => `- \`${s.filepath}:${s.linestart}-${s.lineend}\``).join('\n');
    const text = `${answer.message}\n\n${sources ? `<details><summary>Sources</summary>\n\n${sources}\n\n</details>\n\n` : ''}<sub>RepoLens (${deps.llm.name}/${deps.llm.model})</sub>`;
    const posted = await deps.github.createIssueComment(repo.owner, repo.name, number, text);
    return { commentUrl: posted.htmlUrl };
  });
  return { action: 'chat', jobId: job.id, repository: repoId };
}
