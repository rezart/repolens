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

  it('derives a repo id', () => {
    expect(repoIdFor('git@github.com:acme/widgets.git')).toBe('github:acme/widgets');
  });

  it('throws on unsupported remotes', () => {
    expect(() => parseRemote('https://gitlab.com/o/n')).toThrow(/Unsupported remote/);
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

  it('clones with an authenticated url but redacts the token from errors', async () => {
    const dest = join(root, 'bad-clone');
    const seen: string[] = [];
    const c = new RepoCheckout({
      dir: dest,
      url: 'https://github.com/o/n.git',
      token: 'ghp_SECRETVALUE',
      git: async (args) => {
        seen.push(args.join(' '));
        throw new Error(`fatal: could not read from ${args[2]}`);
      },
    });
    await expect(c.ensureClone()).rejects.toThrow(/could not read/);
    expect(seen[0]).toContain('https://x-access-token:ghp_SECRETVALUE@github.com/o/n.git');
    await c.ensureClone().catch((e: Error) => {
      expect(e.message).not.toContain('ghp_SECRETVALUE');
      expect(e.message).toContain('***');
    });
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
