import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProcess, sharedSemaphore, childEnv, lineSplitter } from './spawn.js';
import type { RunProcess, Semaphore } from './spawn.js';
import { ProviderError } from './types.js';
import type { ChatMessage, CompleteRequest, LLMProvider, OnDelta } from './types.js';
import type { UsageRecord, UsageSink } from '../usage/types.js';

export const JSON_INSTRUCTION = 'Respond with a single JSON object and nothing else.';

export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface CliProviderOptions {
  model?: string;
  bin?: string;
  timeoutMs?: number;
  run?: RunProcess;
  cwd?: string;
  /** Thinking budget. Blank/undefined leaves the CLI default alone. */
  reasoningEffort?: ReasoningEffort | '';
  /** Called once per successful call with the tokens and cost the CLI reported. */
  onUsage?: UsageSink;
}

/**
 * Render chat messages as a single prompt string.
 * A lone user turn is passed through verbatim; anything else becomes a
 * labelled transcript ending with an empty `### Assistant:` cue.
 */
export function flattenMessages(messages: ChatMessage[]): string {
  const users = messages.filter((m) => m.role === 'user');
  const hasAssistant = messages.some((m) => m.role === 'assistant');
  if (users.length === 1 && !hasAssistant) return users[0]!.content;

  const parts = messages.map((m) => {
    const label = m.role === 'assistant' ? 'Assistant' : m.role === 'system' ? 'System' : 'User';
    return `### ${label}:\n${m.content}`;
  });
  parts.push('### Assistant:');
  return parts.join('\n\n');
}

/** Adds the JSON instruction to an existing system prompt, or creates one. */
export function withJsonInstruction(system: string | undefined, json: boolean | undefined): string | undefined {
  if (!json) return system;
  return system ? `${system}\n\n${JSON_INSTRUCTION}` : JSON_INSTRUCTION;
}

/**
 * The token counts a `result` object carries. `input_tokens` is already the
 * fresh (uncached) input; cache reads and writes are counted separately.
 */
interface ClaudeCliUsage {
  input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  output_tokens?: unknown;
}

/**
 * One model's share of a call. The CLI can switch models mid-call (a fallback
 * on overload, a subagent), and only these entries say which tokens went where.
 */
interface ClaudeCliModelUsage {
  canonicalModel?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheReadInputTokens?: unknown;
  cacheCreationInputTokens?: unknown;
  costUSD?: unknown;
}

interface ClaudeCliResult {
  result?: unknown;
  is_error?: boolean;
  subtype?: string;
  total_cost_usd?: unknown;
  usage?: ClaudeCliUsage;
  /** Keyed by the dated model id; the entry names the canonical model. */
  modelUsage?: Record<string, ClaudeCliModelUsage | undefined>;
}

/**
 * One line of `--output-format stream-json`. The shapes used here were taken
 * from a live run: partial text arrives as
 * `{type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text}}}`
 * and the run ends with `{type:'result',result,is_error,subtype}`.
 * `thinking_delta` blocks are interleaved and deliberately ignored.
 */
interface ClaudeStreamLine {
  type?: string;
  event?: { type?: string; delta?: { type?: string; text?: unknown } };
  result?: unknown;
  is_error?: boolean;
  subtype?: string;
}

/** Runs completions through the local `claude` CLI (uses the user's subscription). */
export class ClaudeCliProvider implements LLMProvider {
  readonly name = 'claude-cli';
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
    this.bin = opts.bin || 'claude';
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.run = opts.run ?? runProcess;
    this.cwdOption = opts.cwd;
    this.effort = opts.reasoningEffort || undefined;
    this.onUsage = opts.onUsage;
    this.gate = sharedSemaphore(`${this.name}:${this.bin}`);
  }

  /**
   * Report the token counts of a successful run. Anything missing or
   * unexpectedly shaped is skipped rather than guessed at, and a sink that
   * throws must never turn a good completion into a failure.
   */
  private emitUsage(final: ClaudeCliResult | undefined): void {
    if (!this.onUsage || !final) return;
    for (const record of this.usageRecords(final)) {
      try {
        this.onUsage(record);
      } catch {
        // A broken usage sink is not a reason to fail the call.
      }
    }
  }

  /**
   * One record per model the call used. `usage` and `total_cost_usd` are the
   * aggregate over all of them, so per-model entries are preferred: billing a
   * two-model call entirely to the first one misprices both.
   */
  private usageRecords(final: ClaudeCliResult): UsageRecord[] {
    const perModel: UsageRecord[] = [];
    for (const [key, entry] of Object.entries(final.modelUsage ?? {})) {
      if (!entry) continue;
      const inputTokens = entry.inputTokens;
      const outputTokens = entry.outputTokens;
      if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') continue;
      perModel.push({
        provider: this.name,
        model: typeof entry.canonicalModel === 'string' ? entry.canonicalModel : key,
        inputTokens,
        cachedInputTokens: typeof entry.cacheReadInputTokens === 'number' ? entry.cacheReadInputTokens : 0,
        cacheWriteTokens: typeof entry.cacheCreationInputTokens === 'number' ? entry.cacheCreationInputTokens : 0,
        outputTokens,
        costUsd: typeof entry.costUSD === 'number' ? entry.costUSD : null,
      });
    }
    if (perModel.length) return perModel;

    const usage = final.usage;
    if (!usage) return [];
    const inputTokens = usage.input_tokens;
    const outputTokens = usage.output_tokens;
    if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return [];
    return [
      {
        provider: this.name,
        model: this.model,
        inputTokens,
        cachedInputTokens: typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0,
        cacheWriteTokens: typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0,
        outputTokens,
        costUsd: typeof final.total_cost_usd === 'number' ? final.total_cost_usd : null,
      },
    ];
  }

  /** An empty scratch directory so the CLI has no project context to read. */
  private workDir(): string {
    if (this.cwdOption) return this.cwdOption;
    if (!this.tempDir) this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repolens-claude-'));
    return this.tempDir;
  }

  complete(req: CompleteRequest): Promise<string> {
    return this.gate.run(() => this.runOnce(req));
  }

  stream(req: CompleteRequest, onDelta: OnDelta): Promise<string> {
    return this.gate.run(() => this.runStreaming(req, onDelta));
  }

  /**
   * Argv shared by both output modes.
   * Deliberately no `--bare`: it skips keychain reads, so the CLI cannot see the
   * user's subscription login and answers "Not logged in". Isolation comes from
   * `--tools ''`, no session persistence, and an empty scratch cwd instead.
   */
  private buildArgs(system: string | undefined, streaming: boolean): string[] {
    const args = ['-p', '--output-format'];
    // stream-json is only accepted together with --verbose in print mode.
    if (streaming) args.push('stream-json', '--verbose', '--include-partial-messages');
    else args.push('json');
    args.push('--tools', '', '--no-session-persistence', '--permission-mode', 'dontAsk');
    if (this.rawModel) args.push('--model', this.rawModel);
    if (this.effort) args.push('--effort', this.effort);
    if (system) args.push('--system-prompt', system);
    return args;
  }

  private async runStreaming(req: CompleteRequest, onDelta: OnDelta): Promise<string> {
    const system = withJsonInstruction(req.system, req.json);
    const args = this.buildArgs(system, true);

    let streamed = '';
    let final: ClaudeCliResult | undefined;
    const splitter = lineSplitter((line) => {
      let event: ClaudeStreamLine;
      try {
        event = JSON.parse(line) as ClaudeStreamLine;
      } catch {
        return; // non-JSON noise on stdout is not fatal
      }
      if (event.type === 'result') {
        final = event as ClaudeCliResult;
        return;
      }
      if (event.type !== 'stream_event') return;
      const inner = event.event;
      if (inner?.type !== 'content_block_delta') return;
      // thinking_delta / signature_delta blocks are interleaved; only text counts.
      if (inner.delta?.type !== 'text_delta') return;
      const text = inner.delta.text;
      if (typeof text !== 'string' || !text) return;
      streamed += text;
      onDelta(text);
    });

    const res = await this.run(this.bin, args, {
      stdin: flattenMessages(req.messages),
      cwd: this.workDir(),
      env: childEnv(),
      timeoutMs: this.timeoutMs,
      onStdout: (chunk) => splitter.push(chunk),
    });
    splitter.flush();

    const detail = `${res.stderr}\n${res.stdout}`.trim();
    if (res.timedOut) throw new ProviderError('claude-cli', `timed out after ${this.timeoutMs}ms`, undefined, detail);
    if (res.code !== 0) throw new ProviderError('claude-cli', `exited with code ${res.code}`, undefined, detail);
    if (final?.is_error) {
      throw new ProviderError('claude-cli', `CLI reported an error (${final.subtype ?? 'unknown'})`, undefined, detail);
    }
    this.emitUsage(final);
    // The `result` event carries the authoritative text; the deltas are a
    // best-effort preview and are used only if the CLI never emitted one.
    if (typeof final?.result === 'string') return final.result;
    if (streamed) return streamed;
    throw new ProviderError('claude-cli', 'stream ended without a result', undefined, detail);
  }

  private async runOnce(req: CompleteRequest): Promise<string> {
    const system = withJsonInstruction(req.system, req.json);
    const args = this.buildArgs(system, false);

    const prompt = flattenMessages(req.messages);
    const res = await this.run(this.bin, args, {
      stdin: prompt,
      cwd: this.workDir(),
      env: childEnv(),
      timeoutMs: this.timeoutMs,
    });

    const detail = `${res.stderr}\n${res.stdout}`.trim();
    if (res.timedOut) {
      throw new ProviderError('claude-cli', `timed out after ${this.timeoutMs}ms`, undefined, detail);
    }
    if (res.code !== 0) {
      throw new ProviderError('claude-cli', `exited with code ${res.code}`, undefined, detail);
    }

    let parsed: ClaudeCliResult;
    try {
      parsed = JSON.parse(res.stdout) as ClaudeCliResult;
    } catch {
      throw new ProviderError(
        'claude-cli',
        `output was not JSON: ${res.stdout.slice(0, 500)}`,
        undefined,
        detail,
      );
    }
    if (parsed.is_error) {
      throw new ProviderError('claude-cli', `CLI reported an error (${parsed.subtype ?? 'unknown'})`, undefined, detail);
    }
    if (typeof parsed.result !== 'string') {
      throw new ProviderError('claude-cli', 'output JSON had no string result', undefined, detail);
    }
    this.emitUsage(parsed);
    return parsed.result;
  }
}
