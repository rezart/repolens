import { spawn } from 'node:child_process';

export interface RunOptions {
  stdin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /**
   * Called with each stdout chunk as it arrives, for streaming callers.
   * stdout is still buffered into the result either way.
   */
  onStdout?: (chunk: string) => void;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

export type RunProcess = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

export const runProcess: RunProcess = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : undefined;
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      stdout += d;
      // A throwing consumer must not take down the whole run.
      if (opts.onStdout) {
        try {
          opts.onStdout(d);
        } catch {
          // ignore
        }
      }
    });
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
    // A child that exits (or is SIGKILLed by the timeout) before draining a large
    // prompt makes the write fail with EPIPE. Swallow it: the close handler below
    // reports the real failure.
    child.stdin.on('error', () => {});
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });

/**
 * Reassemble a chunked byte stream into whole lines. A chunk boundary can fall
 * anywhere, so the trailing partial line is held back until it is completed.
 * `flush()` releases whatever is left when the stream ends.
 */
export function lineSplitter(onLine: (line: string) => void): { push: (chunk: string) => void; flush: () => void } {
  let buffer = '';
  return {
    push(chunk: string) {
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) onLine(line);
        nl = buffer.indexOf('\n');
      }
    },
    flush() {
      const rest = buffer;
      buffer = '';
      if (rest.trim()) onLine(rest);
    },
  };
}

/** Simple counting semaphore used to cap concurrent CLI processes. */
export class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
      return () => this.release();
    }
    // A waiter is woken by release() handing over its slot, so `active` is
    // already accounted for and must not be incremented here.
    await new Promise<void>((res) => this.queue.push(res));
    return () => this.release();
  }

  private release() {
    const next = this.queue.shift();
    if (next) {
      // Transfer the slot directly to the waiter; anything acquiring in between
      // still sees the semaphore as full.
      next();
      return;
    }
    this.active--;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/**
 * Environment for child CLI processes. Strips variables that mark a nested
 * Claude Code / Codex session so the CLI behaves like a fresh top-level run.
 */
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT') continue;
    env[k] = v;
  }
  return env;
}
