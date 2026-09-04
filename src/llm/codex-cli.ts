import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProcess, sharedSemaphore, childEnv } from './spawn.js';
import type { RunProcess, Semaphore } from './spawn.js';
import { flattenMessages, withJsonInstruction } from './claude-cli.js';
import type { CliProviderOptions, ReasoningEffort } from './claude-cli.js';
import { ProviderError } from './types.js';
import type { CompleteRequest, LLMProvider, OnDelta } from './types.js';

/** Runs completions through the local `codex` CLI (uses the user's ChatGPT subscription). */
export class CodexCliProvider implements LLMProvider {
  readonly name = 'codex-cli';
  readonly model: string;
  readonly concurrency = 1;

  private readonly rawModel: string | undefined;
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly run: RunProcess;
  private readonly cwdOption: string | undefined;
  private readonly effort: ReasoningEffort | undefined;
  private tempDir: string | undefined;
  /** Shared per binary: two providers on the same CLI still run one process at a time. */
  private readonly gate: Semaphore;

  constructor(opts: CliProviderOptions = {}) {
    this.rawModel = opts.model || undefined;
    this.model = this.rawModel ?? 'default';
    this.bin = opts.bin || 'codex';
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.run = opts.run ?? runProcess;
    this.cwdOption = opts.cwd;
    this.effort = opts.reasoningEffort || undefined;
    this.gate = sharedSemaphore(`${this.name}:${this.bin}`);
  }

  /** Scratch directory used both as cwd and to hold the output file. */
  private scratchDir(): string {
    if (!this.tempDir) this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repolens-codex-'));
    return this.tempDir;
  }

  private workDir(): string {
    return this.cwdOption ?? this.scratchDir();
  }

  complete(req: CompleteRequest): Promise<string> {
    return this.gate.run(() => this.runOnce(req));
  }

  /** Codex has no token-level output, so the whole answer arrives as one delta. */
  stream(req: CompleteRequest, onDelta: OnDelta): Promise<string> {
    return this.gate.run(() => this.runOnce(req, onDelta));
  }

  private async runOnce(req: CompleteRequest, onDelta?: OnDelta): Promise<string> {
    const system = withJsonInstruction(req.system, req.json);
    const outFile = path.join(this.scratchDir(), `out-${Math.random().toString(36).slice(2, 10)}.md`);
    const cwd = this.workDir();

    const args = [
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '-s',
      'read-only',
      '--color',
      'never',
      '-C',
      cwd,
      '-o',
      outFile,
    ];
    if (this.rawModel) args.push('-m', this.rawModel);
    // `-c` values are TOML, so the effort level has to be a quoted string.
    if (this.effort) args.push('-c', `model_reasoning_effort="${this.effort}"`);
    args.push('-');

    const task = flattenMessages(req.messages);
    const stdin = system ? `# System instructions\n${system}\n\n# Task\n${task}` : task;

    try {
      const res = await this.run(this.bin, args, {
        stdin,
        cwd,
        env: childEnv(),
        timeoutMs: this.timeoutMs,
      });
      const detail = tail(`${res.stderr}\n${res.stdout}`.trim());

      if (res.timedOut) {
        throw new ProviderError('codex-cli', `timed out after ${this.timeoutMs}ms`, undefined, detail);
      }
      if (res.code !== 0) {
        throw new ProviderError('codex-cli', `exited with code ${res.code}`, undefined, detail);
      }

      let output: string;
      try {
        output = fs.readFileSync(outFile, 'utf8');
      } catch {
        throw new ProviderError('codex-cli', 'CLI wrote no output file', undefined, detail);
      }
      const trimmed = output.trim();
      if (!trimmed) throw new ProviderError('codex-cli', 'CLI output was empty', undefined, detail);
      // The output file is authoritative and Codex emits no token deltas, only whole
      // (sometimes intermediate) assistant messages. Forwarding those would show text
      // that is absent from the final answer, so streaming is a single delta at the end.
      if (onDelta) onDelta(trimmed);
      return trimmed;
    } finally {
      try {
        fs.rmSync(outFile, { force: true });
      } catch {
        // best effort cleanup
      }
    }
  }
}

function tail(text: string, max = 2000): string {
  return text.length > max ? text.slice(-max) : text;
}
