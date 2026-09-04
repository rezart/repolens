import { createHmac, timingSafeEqual } from 'node:crypto';

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  headSha: string;
  baseSha: string;
  headRef: string;
  baseRef: string;
  author: string;
  htmlUrl: string;
  draft: boolean;
  updatedAt: string | null;
}

export interface ReviewComment {
  path: string;
  line: number;
  body: string;
}

export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

export interface CreateReviewInput {
  commitId: string;
  body: string;
  event: ReviewEvent;
  comments: ReviewComment[];
}

export interface CreatedComment {
  id: number;
  htmlUrl: string;
}

export interface ExistingReviewComment {
  path: string;
  line: number | null;
  body: string;
  user: string;
}

export interface PullCommit {
  sha: string;
  /** First line of the commit message. */
  message: string;
}

export type CommitStatusState = 'pending' | 'success' | 'failure' | 'error';

export interface CommitStatusInput {
  state: CommitStatusState;
  /** Status check name, e.g. `repolens/review`. Branch protection matches on this. */
  context: string;
  description: string;
  targetUrl?: string;
}

/** GitHub rejects commit status descriptions longer than 140 characters. */
export const STATUS_DESCRIPTION_MAX = 140;

export function truncateDescription(text: string, max = STATUS_DESCRIPTION_MAX): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export interface GitHubClientOptions {
  token: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

const API_VERSION = '2022-11-28';
const USER_AGENT = 'RepoLens';

interface RequestOptions {
  method?: string;
  body?: unknown;
  accept?: string;
  /** Status codes that should be returned instead of thrown. */
  allow?: number[];
}

interface RawResponse {
  status: number;
  text: string;
}

export class GitHubClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GitHubClientOptions) {
    this.token = opts.token;
    this.baseUrl = (opts.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async request(path: string, opts: RequestOptions = {}): Promise<RawResponse> {
    const method = opts.method ?? 'GET';
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: opts.accept ?? 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': USER_AGENT,
    };
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    const text = await res.text();
    if (!res.ok && !(opts.allow ?? []).includes(res.status)) {
      throw new Error(`GitHub ${res.status} ${method} ${path}: ${text.slice(0, 300)}`);
    }
    return { status: res.status, text };
  }

  private async json<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.request(path, opts);
    return JSON.parse(res.text || 'null') as T;
  }

  async getPull(owner: string, repo: string, number: number): Promise<PullRequest> {
    const raw = await this.json<PullApiPayload>(`/repos/${owner}/${repo}/pulls/${number}`);
    return this.mapPull(raw);
  }

  private mapPull(raw: PullApiPayload): PullRequest {
    return {
      number: raw.number,
      title: raw.title ?? '',
      body: raw.body ?? '',
      headSha: raw.head?.sha ?? '',
      baseSha: raw.base?.sha ?? '',
      headRef: raw.head?.ref ?? '',
      baseRef: raw.base?.ref ?? '',
      author: raw.user?.login ?? '',
      htmlUrl: raw.html_url ?? '',
      draft: Boolean(raw.draft),
      updatedAt: raw.updated_at ?? null,
    };
  }

  /** Head commit sha of a branch. */
  async getBranchHead(owner: string, repo: string, branch: string): Promise<string> {
    const raw = await this.json<{ commit?: { sha?: string } }>(`/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`);
    return raw?.commit?.sha ?? '';
  }

  /** Open pull requests, newest first (first page of 100). */
  async listOpenPulls(owner: string, repo: string): Promise<PullRequest[]> {
    const raw = await this.json<PullApiPayload[]>(`/repos/${owner}/${repo}/pulls?state=open&per_page=100&sort=updated&direction=desc`);
    return (raw ?? []).map((r) => this.mapPull(r));
  }

  async getPullDiff(owner: string, repo: string, number: number): Promise<string> {
    const res = await this.request(`/repos/${owner}/${repo}/pulls/${number}`, {
      accept: 'application/vnd.github.v3.diff',
    });
    return res.text;
  }

  /**
   * Raw text of a file at `ref` (a sha, branch or tag), or null when it does not
   * exist there. The reviewer uses this to read the PR head, which the search
   * index (built from the base branch) does not reflect.
   */
  async getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string | null> {
    // Keep the slashes: only the individual segments are escaped.
    const encodedPath = path.split('/').map((seg) => encodeURIComponent(seg)).join('/');
    const res = await this.request(`/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`, {
      accept: 'application/vnd.github.raw+json',
      allow: [404],
    });
    if (res.status === 404) return null;
    return res.text;
  }

  /** Commits on the pull request, oldest first (first page of 100). */
  async listPullCommits(owner: string, repo: string, number: number): Promise<PullCommit[]> {
    const raw = await this.json<Array<{ sha?: string; commit?: { message?: string } }>>(
      `/repos/${owner}/${repo}/pulls/${number}/commits?per_page=100`,
    );
    return (raw ?? []).map((c) => ({ sha: c.sha ?? '', message: (c.commit?.message ?? '').split('\n')[0] }));
  }

  /**
   * Unified diff from `base` to `head`, or null when GitHub cannot compare them
   * (a force push removed the old head, or the shas are unrelated).
   */
  async compareDiff(owner: string, repo: string, base: string, head: string): Promise<string | null> {
    const res = await this.request(
      `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
      { accept: 'application/vnd.github.v3.diff', allow: [404, 422] },
    );
    if (res.status === 404 || res.status === 422) return null;
    return res.text;
  }

  async createReview(owner: string, repo: string, number: number, input: CreateReviewInput): Promise<CreatedComment> {
    const path = `/repos/${owner}/${repo}/pulls/${number}/reviews`;
    const payload = {
      commit_id: input.commitId,
      body: input.body,
      event: input.event,
      comments: input.comments.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT' as const, body: c.body })),
    };
    const allow = input.comments.length > 0 ? [422] : [];
    const res = await this.request(path, { method: 'POST', body: payload, allow });
    if (res.status === 422) {
      // Two likely causes: REQUEST_CHANGES was rejected because the token owns the PR,
      // or a comment line was not part of the diff. Retry as a plain COMMENT with the
      // inline comments intact first; only if that fails too are they folded into the
      // body, because rendering them there loses their position in the diff.
      const note =
        input.event === 'REQUEST_CHANGES'
          ? '_Verdict was **request_changes**; posted as a comment because the review could not be submitted as REQUEST_CHANGES._'
          : null;
      const bodyWith = (extra: string | null): string =>
        [input.body, note, extra].filter((p): p is string => p !== null).join('\n\n');
      const failed = (reason: string): Error =>
        new Error(`GitHub 422 POST ${path}: ${res.text.slice(0, 300)} — retry as a plain comment failed: ${reason}`);

      let retry: RawResponse;
      try {
        retry = await this.request(path, {
          method: 'POST',
          body: { ...payload, event: 'COMMENT' as const, body: bodyWith(null) },
          allow: [422],
        });
      } catch (err) {
        throw failed(errText(err));
      }
      if (retry.status === 422) {
        // The inline comments themselves are the problem: drop them into the body.
        const second = retry.text;
        try {
          retry = await this.request(path, {
            method: 'POST',
            body: { ...payload, event: 'COMMENT' as const, comments: [], body: bodyWith(renderDroppedComments(input.comments)) },
          });
        } catch (err) {
          throw failed(`${second.slice(0, 300)} — retry without inline comments failed: ${errText(err)}`);
        }
      }
      const created = JSON.parse(retry.text || 'null') as { id: number; html_url: string };
      return { id: created.id, htmlUrl: created.html_url };
    }
    const created = JSON.parse(res.text || 'null') as { id: number; html_url: string };
    return { id: created.id, htmlUrl: created.html_url };
  }

  /** Report a commit status (a CI check) on `sha`. */
  async createCommitStatus(owner: string, repo: string, sha: string, input: CommitStatusInput): Promise<void> {
    await this.request(`/repos/${owner}/${repo}/statuses/${sha}`, {
      method: 'POST',
      body: {
        state: input.state,
        context: input.context,
        description: truncateDescription(input.description),
        target_url: input.targetUrl,
      },
    });
  }

  async createIssueComment(owner: string, repo: string, number: number, body: string): Promise<CreatedComment> {
    const created = await this.json<{ id: number; html_url: string }>(`/repos/${owner}/${repo}/issues/${number}/comments`, {
      method: 'POST',
      body: { body },
    });
    return { id: created.id, htmlUrl: created.html_url };
  }

  async listReviewComments(owner: string, repo: string, number: number): Promise<ExistingReviewComment[]> {
    const raw = await this.json<Array<{ path: string; line: number | null; body: string; user: { login: string } | null }>>(
      `/repos/${owner}/${repo}/pulls/${number}/comments?per_page=100`,
    );
    return (raw ?? []).map((c) => ({
      path: c.path,
      line: c.line ?? null,
      body: c.body ?? '',
      user: c.user?.login ?? '',
    }));
  }
}

interface PullApiPayload {
  number: number;
  title: string | null;
  body: string | null;
  draft?: boolean;
  html_url: string;
  updated_at?: string | null;
  user: { login: string } | null;
  head: { sha: string; ref: string } | null;
  base: { sha: string; ref: string } | null;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function renderDroppedComments(comments: ReviewComment[]): string {
  // Continuation lines are indented so multi-line Markdown (fenced snippets) stays inside the list item.
  const list = comments.map((c) => `- **${c.path}:${c.line}** — ${c.body.trim().replace(/\n/g, '\n  ')}`).join('\n');
  return `**Inline comments could not be attached to the diff:**\n\n${list}`;
}

/** Verify a GitHub `X-Hub-Signature-256` header (`sha256=<hex>`) in constant time. */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string | Buffer,
  signatureHeader: string | null | undefined,
): boolean {
  if (!secret || !signatureHeader) return false;
  const prefix = 'sha256=';
  if (!signatureHeader.startsWith(prefix)) return false;
  const provided = signatureHeader.slice(prefix.length);
  const expected = createHmac('sha256', secret)
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
    .digest('hex');
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'));
  } catch {
    return false;
  }
}
