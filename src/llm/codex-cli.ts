import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProcess, sharedSemaphore, childEnv } from './spawn.js';
import type { RunProcess, Semaphore } from './spawn.js';
import { flattenMessages, withJsonInstruction } from './claude-cli.js';
import type { CliProviderOptions, ReasoningEffort } from './claude-cli.js';
import { ProviderError } from './types.js';
import type { CompleteRequest, LLMProvider, OnDelta } from './types.js';
import type { UsageRecord, UsageSink } from '../usage/types.js';

/**
 * The `turn.completed` line of `codex exec --json`, taken from a live run:
 * `{"type":"turn.completed","usage":{"input_tokens":18114,"cached_input_tokens":15104,
 * "output_tokens":97,"reasoning_output_tokens":90}}`. `input_tokens` is the total
 * prompt size and already includes the cached tokens.
 */
interface CodexTurnCompleted {
  type?: string;
  usage?: {
    input_tokens?: unknown;
    cached_input_tokens?: unknown;
    output_tokens?: unknown;
  };
}

/**
 * Pull the token counts out of a `codex exec --json` stdout stream.
 * Non-JSON log lines and events of other types are ignored, and the last
 * `turn.completed` wins. Returns undefined when the run reported no usable counts.
 */
function usageFromStdout(stdout: string): Omit<UsageRecord, 'provider' | 'model'> | undefined {
  let found: Omit<UsageRecord, 'provider' | 'model'> | undefined;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: CodexTurnCompleted;
    try {
      event = JSON.parse(trimmed) as CodexTurnCompleted;
    } catch {
      continue; // plain log lines share stdout with the events
    }
    if (!event || typeof event !== 'object' || event.type !== 'turn.completed') continue;
    const usage = event.usage;
    if (!usage) continue;
    const total = usage.input_tokens;
    const outputTokens = usage.output_tokens;
    if (typeof total !== 'number' || typeof outputTokens !== 'number') continue;
    const cachedInputTokens = typeof usage.cached_input_tokens === 'number' ? usage.cached_input_tokens : 0;
    found = {
      inputTokens: total - cachedInputTokens,
      cachedInputTokens,
      cacheWriteTokens: 0,
      outputTokens,
      costUsd: null, // Codex reports tokens only, never a price
    };
  }
  return found;
}

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
  private readonly onUsage: UsageSink | undefined;
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
    this.onUsage = opts.onUsage;
    this.gate = sharedSemaphore(`${this.name}:${this.bin}`);
  }

  /**
   * Report the token counts of a successful run. Missing or oddly shaped counts
   * are skipped rather than guessed at, and a sink that throws must never turn a
   * good completion into a failure.
   */
  private emitUsage(stdout: string): void {
    if (!this.onUsage) return;
    const counts = usageFromStdout(stdout);
    if (!counts) return;
    try {
      this.onUsage({ provider: this.name, model: this.model, ...counts });
    } catch {
      // A broken usage sink is not a reason to fail the call.
    }
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
      // Line-delimited events on stdout; the only one read is `turn.completed`,
      // for its token counts. The answer still comes from the `-o` file.
      '--json',
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
      this.emitUsage(res.stdout);
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
