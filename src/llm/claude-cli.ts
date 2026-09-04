import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProcess, Semaphore } from './spawn.js';
import type { RunProcess } from './spawn.js';
import { ProviderError } from './types.js';
import type { ChatMessage, CompleteRequest, LLMProvider } from './types.js';

export const JSON_INSTRUCTION = 'Respond with a single JSON object and nothing else.';

export interface CliProviderOptions {
  model?: string;
  bin?: string;
  timeoutMs?: number;
  run?: RunProcess;
  cwd?: string;
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

interface ClaudeCliResult {
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
  private tempDir: string | undefined;
  private readonly gate = new Semaphore(1);

  constructor(opts: CliProviderOptions = {}) {
    this.rawModel = opts.model || undefined;
    this.model = this.rawModel ?? 'default';
    this.bin = opts.bin || 'claude';
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.run = opts.run ?? runProcess;
    this.cwdOption = opts.cwd;
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

  private async runOnce(req: CompleteRequest): Promise<string> {
    const system = withJsonInstruction(req.system, req.json);
    const args = [
      '-p',
      '--output-format',
      'json',
      '--tools',
      '',
      '--bare',
      '--no-session-persistence',
      '--permission-mode',
      'dontAsk',
    ];
    if (this.rawModel) args.push('--model', this.rawModel);
    if (system) args.push('--system-prompt', system);

    const prompt = flattenMessages(req.messages);
    const res = await this.run(this.bin, args, {
      stdin: prompt,
      cwd: this.workDir(),
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
    return parsed.result;
  }
}
