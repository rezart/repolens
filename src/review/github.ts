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
      // A comment line was probably not part of the diff, or REQUEST_CHANGES was rejected
      // because the token owns the PR. Post the body alone, as a plain COMMENT, with the
      // inline findings inlined so nothing is lost.
      const retryBody = [
        input.body,
        input.event === 'REQUEST_CHANGES'
          ? '_Verdict was **request_changes**; posted as a comment because the review could not be submitted as REQUEST_CHANGES._'
          : null,
        renderDroppedComments(input.comments),
      ]
        .filter((p): p is string => p !== null)
        .join('\n\n');
      let retry: RawResponse;
      try {
        retry = await this.request(path, {
          method: 'POST',
          body: { ...payload, event: 'COMMENT' as const, comments: [], body: retryBody },
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`GitHub 422 POST ${path}: ${res.text.slice(0, 300)} — retry as a plain comment failed: ${reason}`);
      }
      const created = JSON.parse(retry.text || 'null') as { id: number; html_url: string };
      return { id: created.id, htmlUrl: created.html_url };
    }
    const created = JSON.parse(res.text || 'null') as { id: number; html_url: string };
    return { id: created.id, htmlUrl: created.html_url };
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
  user: { login: string } | null;
  head: { sha: string; ref: string } | null;
  base: { sha: string; ref: string } | null;
}

export function renderDroppedComments(comments: ReviewComment[]): string {
  const list = comments.map((c) => `- **${c.path}:${c.line}** — ${c.body.replace(/\n+/g, ' ').trim()}`).join('\n');
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
