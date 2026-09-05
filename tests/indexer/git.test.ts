import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRemote, repoIdFor, RepoCheckout } from '../../src/indexer/git.js';

const exec = promisify(execFile);

async function git(args: string[], cwd: string) {
  const { stdout } = await exec('git', args, { cwd });
  return stdout;
}

async function commitAll(cwd: string, message: string) {
  await git(['add', '-A'], cwd);
  await git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message], cwd);
}

describe('parseRemote (local paths)', () => {
  it('accepts a path to a git working tree and derives a local id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repolens-Local-'));
    mkdirSync(join(dir, '.git'));
    const p = parseRemote(dir);
    expect(p.host).toBe('local');
    expect(p.url).toBe(dir);
    expect(p.name).toBe(dir.split('/').pop()!.toLowerCase());
    expect(repoIdFor(dir)).toBe(`local:${p.name}`);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('parseRemote', () => {
  it('accepts the common github remote spellings', () => {
    for (const remote of [
      'https://github.com/o/n',
      'https://github.com/o/n.git',
      'git@github.com:o/n.git',
      'github.com/o/n',
      'o/n',
      'https://github.com/o/n/',
    ]) {
      const p = parseRemote(remote);
      expect(p).toEqual({ host: 'github', owner: 'o', name: 'n', url: 'https://github.com/o/n.git' });
    }
  });

  it('lowercases owner and name (github is case-insensitive)', () => {
    expect(parseRemote('https://github.com/Acme/Widgets.git')).toEqual({
      host: 'github',
      owner: 'acme',
      name: 'widgets',
      url: 'https://github.com/acme/widgets.git',
    });
    expect(repoIdFor('Acme/Widgets')).toBe(repoIdFor('acme/widgets'));
  });

  it('derives a repo id', () => {
    expect(repoIdFor('git@github.com:acme/widgets.git')).toBe('github:acme/widgets');
  });

  it('throws on unsupported remotes', () => {
    expect(() => parseRemote('https://gitlab.com/o/n')).toThrow(/Unsupported remote/);
    expect(() => parseRemote('/definitely/not/a/repo')).toThrow(/Unsupported remote/);
    expect(() => parseRemote('')).toThrow(/Unsupported remote/);
    expect(() => parseRemote('not a remote at all')).toThrow(/Unsupported remote/);
  });
});

describe('RepoCheckout', () => {
  let root: string;
  let repoDir: string;
  let checkout: RepoCheckout;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'repolens-git-'));
    repoDir = join(root, 'src-repo');
    mkdirSync(repoDir, { recursive: true });
    await git(['init', '-q', '-b', 'main', '.'], repoDir);
    writeFileSync(join(repoDir, 'a.ts'), 'export const a = 1;\n');
    mkdirSync(join(repoDir, 'lib'), { recursive: true });
    writeFileSync(join(repoDir, 'lib', 'b.ts'), 'export const b = 2;\n');
    await commitAll(repoDir, 'one');
    checkout = new RepoCheckout({ dir: repoDir, url: 'https://github.com/o/n.git' });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('lists tracked blobs with hashes and sizes', async () => {
    const files = await checkout.listFiles();
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(['a.ts', 'lib/b.ts']);
    for (const f of files) expect(f.blobHash).toMatch(/^[0-9a-f]{40}$/);
    expect(files.find((f) => f.path === 'a.ts')!.size).toBe('export const a = 1;\n'.length);
  });

  it('reports a 40-hex head sha', async () => {
    expect(await checkout.headSha()).toMatch(/^[0-9a-f]{40}$/);
  });

  it('reads blob contents by hash', async () => {
    const files = await checkout.listFiles();
    const a = files.find((f) => f.path === 'a.ts')!;
    expect(await checkout.readBlob(a.blobHash)).toBe('export const a = 1;\n');
    expect(await checkout.readFile('lib/b.ts')).toBe('export const b = 2;\n');
  });

  it('changes only the modified file hash on a new commit', async () => {
    const before = await checkout.listFiles();
    writeFileSync(join(repoDir, 'a.ts'), 'export const a = 99;\n');
    await commitAll(repoDir, 'two');
    const after = await checkout.listFiles();
    const byPath = (list: typeof before) => Object.fromEntries(list.map((f) => [f.path, f.blobHash]));
    const b0 = byPath(before);
    const b1 = byPath(after);
    expect(b1['a.ts']).not.toBe(b0['a.ts']);
    expect(b1['lib/b.ts']).toBe(b0['lib/b.ts']);
  });

  it('diffs two revisions', async () => {
    const head = await checkout.headSha();
    const diff = await checkout.diff(`${head}~1`, head);
    expect(diff).toContain('a.ts');
    expect(diff).toContain('+export const a = 99;');
  });

  it('clones into a fresh directory and fetches on the second call', async () => {
    const bare = join(root, 'origin.git');
    await git(['clone', '-q', '--bare', repoDir, bare], root);
    const dest = join(root, 'clone');
    const c = new RepoCheckout({ dir: dest, url: bare });
    await c.ensureClone();
    expect(existsSync(join(dest, '.git'))).toBe(true);
    expect(existsSync(join(dest, 'a.ts'))).toBe(true);
    expect(await c.headSha()).toMatch(/^[0-9a-f]{40}$/);
    // second call must not fail (fetch path)
    await c.ensureClone();
    expect((await c.listFiles()).length).toBe(2);
  });

  it('cleans up a partial directory before cloning', async () => {
    const bare = join(root, 'origin-partial.git');
    await git(['clone', '-q', '--bare', repoDir, bare], root);
    const dest = join(root, 'partial-clone');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'leftover.txt'), 'junk\n');
    const c = new RepoCheckout({ dir: dest, url: bare });
    await c.ensureClone();
    expect(existsSync(join(dest, '.git'))).toBe(true);
    expect(existsSync(join(dest, 'a.ts'))).toBe(true);
    expect(existsSync(join(dest, 'leftover.txt'))).toBe(false);
  });

  it('reports the default branch of the remote', async () => {
    const bare = join(root, 'origin-master.git');
    await git(['clone', '-q', '--bare', repoDir, bare], root);
    await git(['symbolic-ref', 'HEAD', 'refs/heads/master'], bare);
    await git(['branch', '-m', 'main', 'master'], bare);
    const dest = join(root, 'master-clone');
    const c = new RepoCheckout({ dir: dest, url: bare });
    await c.ensureClone();
    expect(await c.defaultBranch()).toBe('master');
  });

  it('passes the token as an http header and never leaks it into errors', async () => {
    const dest = join(root, 'bad-clone');
    const seen: string[][] = [];
    const token = 'ghp_SECRETVALUE';
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    const c = new RepoCheckout({
      dir: dest,
      url: 'https://github.com/o/n.git',
      token,
      git: async (args) => {
        seen.push(args);
        throw new Error(`fatal: could not read from ${args.join(' ')}`);
      },
    });
    await expect(c.ensureClone()).rejects.toThrow(/could not read/);
    expect(seen[0]!.slice(0, 2)).toEqual(['-c', `http.extraheader=Authorization: Basic ${basic}`]);
    // the clone url stays clean, so no credential is written into .git/config
    expect(seen[0]).toContain('https://github.com/o/n.git');
    expect(seen[0]!.join(' ')).not.toContain(`${token}@`);
    await c.ensureClone().catch((e: Error) => {
      expect(e.message).not.toContain(token);
      expect(e.message).not.toContain(basic);
      expect(e.message).toContain('***');
    });
  });

  it('rewrites a legacy remote url that still embeds a token', async () => {
    const bare = join(root, 'origin-legacy.git');
    await git(['clone', '-q', '--bare', repoDir, bare], root);
    const dest = join(root, 'legacy-clone');
    const plain = new RepoCheckout({ dir: dest, url: bare });
    await plain.ensureClone();
    await git(['remote', 'set-url', 'origin', `https://x-access-token:ghp_OLD@example.invalid/o/n.git`], dest);
    const c = new RepoCheckout({ dir: dest, url: bare, token: 'ghp_NEW' });
    await c.ensureClone();
    const url = await exec('git', ['remote', 'get-url', 'origin'], { cwd: dest });
    expect(url.stdout.trim()).toBe(bare);
  });

  it('omits the auth header when no token is configured', async () => {
    const calls: string[][] = [];
    const c = new RepoCheckout({
      dir: '/nowhere',
      url: 'https://github.com/o/n.git',
      git: async (args) => {
        calls.push(args);
        return '';
      },
    });
    await c.fetchRef('main');
    expect(calls[0]).toEqual(['fetch', 'origin', 'main']);
  });

  it('uses an injected git runner', async () => {
    const calls: string[][] = [];
    const c = new RepoCheckout({
      dir: '/nowhere',
      url: 'https://github.com/o/n.git',
      git: async (args) => {
        calls.push(args);
        return args[0] === 'rev-parse' ? 'deadbeef\n' : '';
      },
    });
    expect(await c.fetchPullRequest(42)).toBe('deadbeef');
    expect(calls[0]).toEqual(['fetch', 'origin', '+refs/pull/42/head:refs/remotes/pr/42']);
    expect(calls[1]).toEqual(['rev-parse', 'refs/remotes/pr/42']);
  });
});

it('refreshes checkout credentials per invocation and redacts the refreshed token', async () => {
  let n = 0;
  const seen: string[][] = [];
  const checkout = new RepoCheckout({ dir: '/tmp/repolens-app-token-test', url: 'https://github.com/o/r.git', token: async () => `secret-${++n}`, git: async (args) => {
    seen.push(args);
    throw new Error(args.join(' ') + ` secret-${n}`);
  } });
  await expect(checkout.fetchRef('main')).rejects.not.toThrow('secret-1');
  await expect(checkout.fetchRef('main')).rejects.not.toThrow('secret-2');
  expect(seen.map((args) => args[1])).toEqual([
    'http.extraheader=Authorization: Basic ' + Buffer.from('x-access-token:secret-1').toString('base64'),
    'http.extraheader=Authorization: Basic ' + Buffer.from('x-access-token:secret-2').toString('base64'),
  ]);
});
