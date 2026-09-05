import { generateKeyPairSync, verify } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppTokenProvider } from '../../src/review/github-app.js';
import { GitHubClient } from '../../src/review/github.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const credentials = { appId: '123', installationId: '456', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
afterEach(() => vi.restoreAllMocks());

describe('GitHub App authentication', () => {
  it('signs a valid JWT and shares a cached token until refresh is due', async () => {
    let now = Date.parse('2026-09-04T12:00:00Z');
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let exchanges = 0;
    const getToken = createAppTokenProvider(credentials, {
      baseUrl: 'https://github.example/api/v3/',
      fetch: async (url, init) => {
        expect(url).toBe('https://github.example/api/v3/app/installations/456/access_tokens');
        expect(init?.method).toBe('POST');
        const jwt = new Headers(init?.headers).get('Authorization')!.slice(7);
        const [header, payload, signature] = jwt.split('.');
        expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
        expect(claims).toEqual({ iss: '123', iat: Math.floor(now / 1000) - 60, exp: Math.floor(now / 1000) + 540 });
        expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
        exchanges++;
        return Response.json({ token: `token-${exchanges}`, expires_at: new Date(now + 3_600_000).toISOString() });
      },
    });
    expect(await Promise.all([getToken(), getToken()])).toEqual(['token-1', 'token-1']);
    expect(exchanges).toBe(1);
    now += 3_539_000;
    expect(await getToken()).toBe('token-1');
    now += 2_000;
    expect(await getToken()).toBe('token-2');
    expect(exchanges).toBe(2);
  });

  it('does not cache failures or expose credential responses', async () => {
    let calls = 0;
    const getToken = createAppTokenProvider(credentials, { fetch: async () => {
      calls++;
      if (calls === 1) return new Response('sensitive response', { status: 401 });
      if (calls === 2) return Response.json({ token: 'secret', expires_at: 'invalid' });
      return Response.json({ token: 'working', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    } });
    await expect(getToken()).rejects.toThrow('401');
    await expect(getToken()).rejects.toThrow('Invalid GitHub App token response');
    expect(await getToken()).toBe('working');
  });

  it('resolves the token on each API request', async () => {
    let n = 0;
    const headers: string[] = [];
    const gh = new GitHubClient({ token: async () => `rotated-${++n}`, fetch: async (_url, init) => {
      headers.push(new Headers(init?.headers).get('Authorization')!);
      return Response.json({ number: 1 });
    } });
    await gh.getPull('o', 'r', 1);
    await gh.getPull('o', 'r', 1);
    expect(headers).toEqual(['Bearer rotated-1', 'Bearer rotated-2']);
  });

  it('omits authorization when the token provider returns whitespace', async () => {
    let authorization: string | null = 'unset';
    const gh = new GitHubClient({ token: async () => '   ', fetch: async (_url, init) => {
      authorization = new Headers(init?.headers).get('Authorization');
      return Response.json({ number: 1 });
    } });
    await gh.getPull('o', 'r', 1);
    expect(authorization).toBeNull();
  });
});

it('rejects an expired installation token', async () => {
  const getToken = createAppTokenProvider(credentials, { fetch: async () => Response.json({ token: 'expired', expires_at: '2020-01-01T00:00:00Z' }) });
  await expect(getToken()).rejects.toThrow('Invalid GitHub App token response');
});

it('does not expose a malformed token response in JSON parsing errors', async () => {
  const getToken = createAppTokenProvider(credentials, { fetch: async () => new Response('secret-token-is-not-json') });
  await expect(getToken()).rejects.toThrow('Invalid GitHub App token response');
});

it('wires App credentials ahead of a configured PAT and reads the PEM from disk', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { loadConfig } = await import('../../src/config.js');
  const { buildDeps } = await import('../../src/server.js');
  const dir = mkdtempSync(join(tmpdir(), 'repolens-app-'));
  const keyPath = join(dir, 'app.pem');
  writeFileSync(keyPath, credentials.privateKey, { mode: 0o600 });
  const config = loadConfig({ LLM_PROVIDER: 'claude-cli', REPOLENS_DATA_DIR: dir, GITHUB_TOKEN: 'personal-token', GITHUB_APP_ID: '123', GITHUB_APP_INSTALLATION_ID: '456', GITHUB_APP_PRIVATE_KEY_PATH: keyPath });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const auth = new Headers(init?.headers).get('Authorization');
    expect(auth).not.toContain('personal-token');
    if (String(url).endsWith('/access_tokens')) return Response.json({ token: 'app-token', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    expect(auth).toBe('Bearer app-token');
    return Response.json({ number: 21 });
  });
  const deps = buildDeps(config);
  try {
    expect((await deps.github.getPull('o', 'r', 21)).number).toBe(21);
    expect(await deps.github.getToken()).toBe('app-token');
  } finally {
    deps.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
