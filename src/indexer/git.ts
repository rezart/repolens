import { execFile } from 'node:child_process';
import { readFile as fsReadFile } from 'node:fs/promises';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface ParsedRemote {
  host: 'github';
  owner: string;
  name: string;
  /** Normalised clone url. */
  url: string;
}

const GITHUB_RE = /^(?:(?:https?|ssh|git):\/\/)?(?:[^@/\s]+@)?github\.com[/:]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/;
const SHORTHAND_RE = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/;

/**
 * Parse the remote spellings we accept into `{owner, name}` plus a normalised https url.
 * GitHub owner/repo names are case-insensitive, so everything is lowercased to keep
 * repo ids stable (GitHub redirects a lowercased clone url to the canonical one).
 */
export function parseRemote(remote: string): ParsedRemote {
  const s = (remote ?? '').trim().replace(/\/+$/, '');
  const m = GITHUB_RE.exec(s) ?? SHORTHAND_RE.exec(s);
  if (!m || !m[1] || !m[2] || m[1] === '.' || m[2] === '.') {
    throw new Error(`Unsupported remote: ${remote}`);
  }
  const owner = m[1].toLowerCase();
  const name = m[2].toLowerCase();
  return { host: 'github', owner, name, url: `https://github.com/${owner}/${name}.git` };
}

/** Stable repo id used as the primary key in the database. */
export function repoIdFor(remote: string): string {
  const { owner, name } = parseRemote(remote);
  return `github:${owner}/${name}`;
}

export interface GitRunOptions {
  cwd?: string;
}

export type GitRunner = (args: string[], opts?: GitRunOptions) => Promise<string>;

export interface RepoCheckoutOptions {
  /** Working-tree directory for the checkout. */
  dir: string;
  /** Clone url (may be a local path in tests). */
  url: string;
  /** GitHub token; passed per invocation as an http header, never echoed in errors. */
  token?: string;
  /** Override for tests. */
  git?: GitRunner;
}

export interface TreeEntry {
  path: string;
  blobHash: string;
  size: number;
}

const MAX_GIT_BUFFER = 256 * 1024 * 1024;

/** The subcommand in an argv that may start with global options such as `-c k=v` or `-C dir`. */
function subcommandOf(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const prev = args[i - 1];
    if (prev === '-c' || prev === '-C') continue;
    if (!args[i].startsWith('-')) return args[i];
  }
  return 'command';
}

function defaultRunner(defaultCwd: string): GitRunner {
  return (args, opts) =>
    new Promise<string>((resolvePromise, reject) => {
      execFile(
        'git',
        args,
        { cwd: opts?.cwd ?? defaultCwd, maxBuffer: MAX_GIT_BUFFER, encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (err) {
            const detail = (stderr || err.message || '').trim();
            reject(new Error(`git ${subcommandOf(args)} failed: ${detail}`));
            return;
          }
          resolvePromise(stdout);
        },
      );
    });
}

/** A local clone of a repository, driven through the `git` CLI. */
export class RepoCheckout {
  readonly dir: string;
  readonly url: string;
  private readonly token?: string;
  /** base64 of `x-access-token:<token>`, used in the per-invocation auth header. */
  private readonly basic?: string;
  private readonly run: GitRunner;

  constructor(opts: RepoCheckoutOptions) {
    this.dir = resolve(opts.dir);
    this.url = opts.url;
    this.token = opts.token;
    this.basic = opts.token ? Buffer.from(`x-access-token:${opts.token}`).toString('base64') : undefined;
    this.run = opts.git ?? defaultRunner(this.dir);
  }

  /** Strip credentials from anything we surface to callers or logs. */
  private redact(text: string): string {
    let out = text.replace(/(https?:\/\/)[^@\s/]+:[^@\s/]+@/g, '$1***:***@');
    if (this.token) out = out.split(this.token).join('***');
    if (this.basic) out = out.split(this.basic).join('***');
    return out;
  }

  /**
   * Run git, injecting the token as a per-invocation http header. Keeping it out of
   * the remote url means it is never written to `.git/config` and a rotated token is
   * picked up on the next call.
   */
  private async git(args: string[], opts?: GitRunOptions): Promise<string> {
    const full = this.basic ? ['-c', `http.extraheader=Authorization: Basic ${this.basic}`, ...args] : args;
    try {
      return await this.run(full, opts);
    } catch (err) {
      const message = this.redact(err instanceof Error ? err.message : String(err));
      throw new Error(message);
    }
  }

  /** Clone the repository if it is missing, otherwise refresh remote refs. */
  async ensureClone(): Promise<void> {
    if (!existsSync(join(this.dir, '.git'))) {
      // A directory without `.git` is a partial or abandoned clone; git refuses to
      // clone into it, so start over.
      if (existsSync(this.dir)) rmSync(this.dir, { recursive: true, force: true });
      mkdirSync(dirname(this.dir), { recursive: true });
      await this.git(['clone', '--no-checkout', this.url, this.dir], { cwd: dirname(this.dir) });
      await this.git(['-C', this.dir, 'checkout'], { cwd: dirname(this.dir) });
      return;
    }
    // Clones made by older versions embedded the token in the remote url; drop it so
    // the header is the only credential and a rotated token takes effect.
    if (this.basic) await this.git(['remote', 'set-url', 'origin', this.url]);
    await this.git(['fetch', '--all', '--prune']);
  }

  /** The remote's default branch, falling back to whatever the clone has checked out. */
  async defaultBranch(): Promise<string> {
    try {
      const ref = (await this.git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])).trim();
      if (ref) return ref.replace(/^refs\/remotes\/origin\//, '');
    } catch {
      // origin/HEAD is not always set (e.g. a clone of a bare repo without it)
    }
    return (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  }

  /** Fetch a ref (branch, tag or sha) from origin into FETCH_HEAD. */
  async fetchRef(ref: string): Promise<void> {
    await this.git(['fetch', 'origin', ref]);
  }

  /** Detach the working tree at `ref`, fetching it from origin when possible. */
  async checkout(ref: string): Promise<void> {
    try {
      await this.fetchRef(ref);
      await this.git(['checkout', '-q', '--detach', 'FETCH_HEAD']);
      return;
    } catch {
      // ref may be a local sha or already-fetched object
    }
    await this.git(['checkout', '-q', '--detach', ref]);
  }

  async headSha(): Promise<string> {
    return (await this.git(['rev-parse', 'HEAD'])).trim();
  }

  /** Every regular blob reachable from HEAD (symlinks and submodules excluded). */
  async listFiles(): Promise<TreeEntry[]> {
    const out = await this.git(['ls-tree', '-r', '-l', '-z', 'HEAD']);
    const entries: TreeEntry[] = [];
    for (const record of out.split('\0')) {
      if (!record) continue;
      const tab = record.indexOf('\t');
      if (tab === -1) continue;
      const meta = record.slice(0, tab);
      const path = record.slice(tab + 1);
      const m = /^(\d{6})\s+(\S+)\s+([0-9a-f]{40,64})\s+(\S+)$/.exec(meta);
      if (!m) continue;
      const [, mode, type, blobHash, sizeText] = m;
      if (type !== 'blob') continue;
      if (mode === '120000') continue; // symlink
      const size = Number(sizeText);
      entries.push({ path, blobHash, size: Number.isFinite(size) ? size : 0 });
    }
    return entries;
  }

  /** Read a file from the working tree. */
  async readFile(path: string): Promise<string> {
    return fsReadFile(join(this.dir, path), 'utf8');
  }

  /** Read a blob straight out of the object database (independent of the working tree). */
  async readBlob(hash: string): Promise<string> {
    return this.git(['cat-file', '-p', hash]);
  }

  /** Fetch a pull request head into `refs/remotes/pr/<n>` and return its sha. */
  async fetchPullRequest(number: number): Promise<string> {
    await this.git(['fetch', 'origin', `+refs/pull/${number}/head:refs/remotes/pr/${number}`]);
    return (await this.git(['rev-parse', `refs/remotes/pr/${number}`])).trim();
  }

  /** Unified diff of `base...head` with three lines of context. */
  async diff(base: string, head: string): Promise<string> {
    return this.git(['diff', '-U3', '--no-color', `${base}...${head}`]);
  }
}
