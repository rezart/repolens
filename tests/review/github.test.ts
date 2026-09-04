import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { GitHubClient, verifyWebhookSignature } from '../../src/review/github.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}

function fakeFetch(responses: Response[]) {
  const calls: Call[] = [];
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k] = v;
    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url: String(url), method: init?.method ?? 'GET', headers, body });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected extra fetch call to ${String(url)}`);
    return next;
  };
  return { calls, fetch: fn as unknown as typeof fetch };
}

const PULL_PAYLOAD = {
  number: 42,
  title: 'Add auth',
  body: null,
  draft: false,
  html_url: 'https://github.com/o/r/pull/42',
  user: { login: 'octocat' },
  head: { sha: 'headsha', ref: 'feature' },
  base: { sha: 'basesha', ref: 'main' },
};

function client(responses: Response[], opts: { baseUrl?: string } = {}) {
  const f = fakeFetch(responses);
  return { f, gh: new GitHubClient({ token: 'tok', fetch: f.fetch, ...opts }) };
}

describe('GitHubClient.getPull', () => {
  it('maps the API payload onto a PullRequest', async () => {
    const { f, gh } = client([jsonResponse(PULL_PAYLOAD)]);
    const pr = await gh.getPull('o', 'r', 42);
    expect(pr).toEqual({
      number: 42,
      title: 'Add auth',
      body: '',
      headSha: 'headsha',
      baseSha: 'basesha',
      headRef: 'feature',
      baseRef: 'main',
      author: 'octocat',
      htmlUrl: 'https://github.com/o/r/pull/42',
      draft: false,
    });
    const call = f.calls[0]!;
    expect(call.url).toBe('https://api.github.com/repos/o/r/pulls/42');
    expect(call.method).toBe('GET');
    expect(call.headers['Authorization']).toBe('Bearer tok');
    expect(call.headers['Accept']).toBe('application/vnd.github+json');
    expect(call.headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    expect(call.headers['User-Agent']).toBe('RepoLens');
  });

  it('honours a custom baseUrl (GitHub Enterprise)', async () => {
    const { f, gh } = client([jsonResponse(PULL_PAYLOAD)], { baseUrl: 'https://ghe.corp/api/v3/' });
    await gh.getPull('o', 'r', 42);
    expect(f.calls[0]!.url).toBe('https://ghe.corp/api/v3/repos/o/r/pulls/42');
  });
});

describe('GitHubClient.getPullDiff', () => {
  it('requests the diff media type and returns raw text', async () => {
    const { f, gh } = client([textResponse('diff --git a/a b/a\n')]);
    const diff = await gh.getPullDiff('o', 'r', 7);
    expect(diff).toBe('diff --git a/a b/a\n');
    expect(f.calls[0]!.url).toBe('https://api.github.com/repos/o/r/pulls/7');
    expect(f.calls[0]!.headers['Accept']).toBe('application/vnd.github.v3.diff');
  });
});

describe('GitHubClient.createReview', () => {
  it('posts commit_id, event and RIGHT-side comments', async () => {
    const { f, gh } = client([jsonResponse({ id: 99, html_url: 'https://github.com/o/r/pull/1#r99' })]);
    const res = await gh.createReview('o', 'r', 1, {
      commitId: 'abc123',
      body: '## RepoLens review',
      event: 'COMMENT',
      comments: [{ path: 'src/a.ts', line: 12, body: 'boom' }],
    });
    expect(res).toEqual({ id: 99, htmlUrl: 'https://github.com/o/r/pull/1#r99' });
    const call = f.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://api.github.com/repos/o/r/pulls/1/reviews');
    expect(call.body).toEqual({
      commit_id: 'abc123',
      body: '## RepoLens review',
      event: 'COMMENT',
      comments: [{ path: 'src/a.ts', line: 12, side: 'RIGHT', body: 'boom' }],
    });
  });

  it('retries without inline comments when GitHub answers 422', async () => {
    const { f, gh } = client([
      jsonResponse({ message: 'line must be part of the diff' }, 422),
      jsonResponse({ id: 100, html_url: 'https://x/100' }),
    ]);
    const res = await gh.createReview('o', 'r', 1, {
      commitId: 'abc123',
      body: 'summary here',
      event: 'COMMENT',
      comments: [
        { path: 'src/a.ts', line: 12, body: 'boom' },
        { path: 'src/b.ts', line: 3, body: 'bang' },
      ],
    });
    expect(res.id).toBe(100);
    expect(f.calls).toHaveLength(2);
    const retry = f.calls[1]!.body as { comments: unknown[]; body: string };
    expect(retry.comments).toEqual([]);
    expect(retry.body).toContain('summary here');
    expect(retry.body).toContain('- **src/a.ts:12** — boom');
    expect(retry.body).toContain('- **src/b.ts:3** — bang');
  });

  it('does not retry a 422 when there were no comments to drop', async () => {
    const { f, gh } = client([jsonResponse({ message: 'nope' }, 422)]);
    await expect(gh.createReview('o', 'r', 1, { commitId: 'a', body: 'b', event: 'COMMENT', comments: [] })).rejects.toThrow(
      /GitHub 422/,
    );
    expect(f.calls).toHaveLength(1);
  });
});

describe('GitHubClient.createIssueComment / listReviewComments', () => {
  it('creates an issue comment', async () => {
    const { f, gh } = client([jsonResponse({ id: 5, html_url: 'https://x/5' })]);
    const res = await gh.createIssueComment('o', 'r', 3, 'hello');
    expect(res).toEqual({ id: 5, htmlUrl: 'https://x/5' });
    expect(f.calls[0]!.url).toBe('https://api.github.com/repos/o/r/issues/3/comments');
    expect(f.calls[0]!.body).toEqual({ body: 'hello' });
  });

  it('lists review comments', async () => {
    const { f, gh } = client([
      jsonResponse([
        { path: 'src/a.ts', line: 4, body: 'hi', user: { login: 'bot' } },
        { path: 'src/b.ts', line: null, body: 'outdated', user: null },
      ]),
    ]);
    const list = await gh.listReviewComments('o', 'r', 3);
    expect(list).toEqual([
      { path: 'src/a.ts', line: 4, body: 'hi', user: 'bot' },
      { path: 'src/b.ts', line: null, body: 'outdated', user: '' },
    ]);
    expect(f.calls[0]!.url).toBe('https://api.github.com/repos/o/r/pulls/3/comments?per_page=100');
  });
});

describe('GitHubClient errors', () => {
  it('throws with status, method, path and a body excerpt', async () => {
    const { gh } = client([textResponse('Not Found', 404)]);
    await expect(gh.getPull('o', 'r', 42)).rejects.toThrow('GitHub 404 GET /repos/o/r/pulls/42: Not Found');
  });

  it('truncates long error bodies to 300 characters', async () => {
    const { gh } = client([textResponse('x'.repeat(1000), 500)]);
    await expect(gh.getPull('o', 'r', 1)).rejects.toThrow(/GitHub 500 GET \/repos\/o\/r\/pulls\/1: x{300}$/);
  });
});

describe('verifyWebhookSignature', () => {
  const secret = 's3cret';
  const body = JSON.stringify({ action: 'opened' });
  const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

  it('accepts a valid signature', () => {
    expect(verifyWebhookSignature(secret, body, sig)).toBe(true);
  });

  it('accepts a Buffer body', () => {
    expect(verifyWebhookSignature(secret, Buffer.from(body, 'utf8'), sig)).toBe(true);
  });

  it('rejects a wrong signature of the right length', () => {
    const bad = 'sha256=' + createHmac('sha256', 'other').update(body).digest('hex');
    expect(verifyWebhookSignature(secret, body, bad)).toBe(false);
  });

  it('rejects a tampered body', () => {
    expect(verifyWebhookSignature(secret, body + ' ', sig)).toBe(false);
  });

  it('rejects a missing, empty or malformed header', () => {
    expect(verifyWebhookSignature(secret, body, null)).toBe(false);
    expect(verifyWebhookSignature(secret, body, undefined)).toBe(false);
    expect(verifyWebhookSignature(secret, body, '')).toBe(false);
    expect(verifyWebhookSignature(secret, body, 'sha256=deadbeef')).toBe(false);
    expect(verifyWebhookSignature(secret, body, sig.slice('sha256='.length))).toBe(false);
  });

  it('rejects when the secret is empty', () => {
    expect(verifyWebhookSignature('', body, sig)).toBe(false);
  });
});
