import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { JobQueue } from '../src/jobs.js';
import { createApp, type AppDeps } from '../src/app.js';
import type { LLMProvider, CompleteRequest } from '../src/llm/types.js';
import type { GitHubClient } from '../src/review/github.js';

function fakeLlm(): LLMProvider & { calls: CompleteRequest[] } {
  const calls: CompleteRequest[] = [];
  return {
    name: 'fake',
    model: 'fake-1',
    concurrency: 2,
    calls,
    async complete(req) {
      calls.push(req);
      return 'The answer cites src/auth.ts:1-5.';
    },
  };
}

function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps & { db: Db } {
  const config = loadConfig({ LLM_PROVIDER: 'claude-cli', REPOLENS_API_TOKEN: 'secret', GITHUB_WEBHOOK_SECRET: 'whsec', REPOLENS_DATA_DIR: mkdtempSync(join(tmpdir(), 'repolens-test-')) });
  const db = openDb(':memory:');
  const jobs = new JobQueue(db);
  const github = {} as GitHubClient;
  return {
    config,
    db,
    llm: fakeLlm(),
    embeddings: null,
    retrieve: async () => [{ chunkId: 1, repoId: 'github:o/n', path: 'src/auth.ts', startLine: 1, endLine: 5, content: 'export function verifyToken() {}', score: 1 }],
    github,
    jobs,
    ...overrides,
  };
}

const auth = { authorization: 'Bearer secret', 'content-type': 'application/json' };

describe('API', () => {
  let deps: ReturnType<typeof makeDeps>;
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    deps = makeDeps();
    app = createApp(deps);
  });

  it('serves health without auth', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.llm.provider).toBe('fake');
    expect(body.embeddings).toBeNull();
  });

  it('rejects unauthenticated api calls', async () => {
    const res = await app.request('/api/repositories');
    expect(res.status).toBe(401);
  });

  it('adds a repository and queues an index job', async () => {
    const res = await app.request('/api/repositories', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ remote: 'github', repository: 'octo/cat', branch: 'main' }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.repository.id).toBe('github:octo/cat');
    expect(typeof body.jobId).toBe('number');
    await deps.jobs.idle();
    // Clone of a nonexistent repo fails; the job and repo must record the error rather than crash.
    const job = await (await app.request(`/api/jobs/${body.jobId}`, { headers: auth })).json();
    expect(['error', 'done']).toContain(job.status);
    const repo = await (await app.request('/api/repositories/github%3Aocto%2Fcat', { headers: auth })).json();
    expect(repo.id).toBe('github:octo/cat');
  });

  it('answers queries with sources', async () => {
    deps.db.upsertRepo({ id: 'github:o/n', remote: 'https://github.com/o/n.git', owner: 'o', name: 'n', branch: 'main' });
    const res = await app.request('/api/query', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ messages: [{ role: 'user', content: 'how does auth work?' }], repositories: ['github:o/n'] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toContain('src/auth.ts');
    expect(body.sources[0].filepath).toBe('src/auth.ts');
  });

  it('rejects queries for unknown repositories', async () => {
    const res = await app.request('/api/query', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], repositories: ['github:no/pe'] }),
    });
    expect(res.status).toBe(404);
  });

  it('searches chunks', async () => {
    deps.db.upsertRepo({ id: 'github:o/n', remote: 'u', owner: 'o', name: 'n', branch: 'main' });
    const res = await app.request('/api/search', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ query: 'verifyToken', repositories: ['o/n'] }),
    });
    const body = await res.json();
    expect(body.results[0].path).toBe('src/auth.ts');
  });

  it('updates instructions', async () => {
    deps.db.upsertRepo({ id: 'github:o/n', remote: 'u', owner: 'o', name: 'n', branch: 'main' });
    const res = await app.request('/api/repositories/github%3Ao%2Fn/instructions', {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ instructions: 'Be strict about error handling.' }),
    });
    expect((await res.json()).instructions).toBe('Be strict about error handling.');
  });

  describe('webhook', () => {
    const sign = (body: string) => 'sha256=' + createHmac('sha256', 'whsec').update(body).digest('hex');

    it('rejects bad signatures', async () => {
      const body = JSON.stringify({ action: 'opened' });
      const res = await app.request('/webhooks/github', {
        method: 'POST',
        headers: { 'x-github-event': 'pull_request', 'x-hub-signature-256': 'sha256=bad', 'content-type': 'application/json' },
        body,
      });
      expect(res.status).toBe(401);
    });

    it('ignores pull requests for repos that are not indexed', async () => {
      const body = JSON.stringify({ action: 'opened', number: 3, pull_request: { number: 3 }, repository: { full_name: 'o/n' } });
      const res = await app.request('/webhooks/github', {
        method: 'POST',
        headers: { 'x-github-event': 'pull_request', 'x-hub-signature-256': sign(body), 'content-type': 'application/json' },
        body,
      });
      expect(res.status).toBe(202);
      expect((await res.json()).action).toBe('ignored');
    });

    it('queues a review for an opened pull request on an indexed repo', async () => {
      deps.db.upsertRepo({ id: 'github:o/n', remote: 'u', owner: 'o', name: 'n', branch: 'main' });
      const body = JSON.stringify({ action: 'synchronize', number: 3, pull_request: { number: 3, draft: false }, repository: { full_name: 'o/n' } });
      const res = await app.request('/webhooks/github', {
        method: 'POST',
        headers: { 'x-github-event': 'pull_request', 'x-hub-signature-256': sign(body), 'content-type': 'application/json' },
        body,
      });
      const out = await res.json();
      expect(out.action).toBe('review');
      expect(deps.db.getJob(out.jobId)?.kind).toBe('review');
      await deps.jobs.idle();
    });

    it('answers a PR comment that mentions the bot', async () => {
      deps.db.upsertRepo({ id: 'github:o/n', remote: 'u', owner: 'o', name: 'n', branch: 'main' });
      const posted: string[] = [];
      deps.github = {
        getPull: async () => ({ number: 3, title: 'T', body: 'B', headSha: 'h', baseSha: 'b', headRef: 'f', baseRef: 'main', author: 'a', htmlUrl: '', draft: false }),
        getPullDiff: async () => 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,2 @@\n line\n+added\n',
        createIssueComment: async (_o: string, _r: string, _n: number, text: string) => {
          posted.push(text);
          return { id: 1, htmlUrl: 'https://github.com/o/n/pull/3#issuecomment-1' };
        },
      } as unknown as GitHubClient;
      const body = JSON.stringify({
        action: 'created',
        issue: { number: 3, pull_request: {} },
        comment: { body: '@repolens why was this added?', user: { login: 'dev', type: 'User' } },
        repository: { full_name: 'o/n' },
      });
      const res = await app.request('/webhooks/github', {
        method: 'POST',
        headers: { 'x-github-event': 'issue_comment', 'x-hub-signature-256': sign(body), 'content-type': 'application/json' },
        body,
      });
      expect((await res.json()).action).toBe('chat');
      await deps.jobs.idle();
      expect(posted).toHaveLength(1);
      expect(posted[0]).toContain('src/auth.ts');
      const prompt = (deps.llm as ReturnType<typeof fakeLlm>).calls[0];
      expect(prompt.messages.at(-1)?.content).toContain('+ added');
    });
  });
});
