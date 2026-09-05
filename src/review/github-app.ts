import { createPrivateKey, sign } from 'node:crypto';
import { z } from 'zod';

const tokenResponse = z.object({ token: z.string().min(1), expires_at: z.string().datetime() });

/** One installation per self-hosted instance; API requests and git share this cache. */
export function createAppTokenProvider(
  credentials: { appId: string; installationId: string; privateKey: string },
  options: { baseUrl?: string; fetch?: typeof fetch } = {},
): () => Promise<string> {
  const key = createPrivateKey(credentials.privateKey);
  if (key.asymmetricKeyType !== 'rsa') throw new Error('GitHub App private key must be RSA');
  const baseUrl = (options.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? fetch;
  let cached: { token: string; expires: number } | undefined;
  let pending: Promise<string> | undefined;

  async function refresh(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: credentials.appId, iat: now - 60, exp: now + 540 })}`;
    const jwt = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url')}`;
    const response = await fetchImpl(`${baseUrl}/app/installations/${credentials.installationId}/access_tokens`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'RepoLens' },
      signal: AbortSignal.timeout(30_000),
    });
    // Never include a token endpoint response body in errors or logs.
    if (!response.ok) throw new Error(`GitHub App token request failed (${response.status})`);
    const parsed = tokenResponse.safeParse(await response.json().catch(() => null));
    if (!parsed.success || Date.parse(parsed.data.expires_at) <= Date.now() + 60_000) {
      throw new Error('Invalid GitHub App token response');
    }
    cached = { token: parsed.data.token, expires: Date.parse(parsed.data.expires_at) };
    return cached.token;
  }

  return async () => {
    if (cached && cached.expires > Date.now() + 60_000) return cached.token;
    pending ??= refresh().finally(() => { pending = undefined; });
    return pending;
  };
}
