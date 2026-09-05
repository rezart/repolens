import type { CliProviderOptions } from './claude-cli.js';
import type { CompleteRequest, LLMProvider, OnDelta } from './types.js';

const disabled = () => new Error('codex-cli is temporarily disabled for security; use claude-cli or openrouter');

/** Codex is disabled until a dependable host-tool boundary is available. */
export class CodexCliProvider implements LLMProvider {
  readonly name = 'codex-cli';
  readonly model = 'disabled';
  readonly concurrency = 0;

  constructor(_opts: CliProviderOptions = {}) {
    throw disabled();
  }

  complete(_req: CompleteRequest): Promise<string> {
    return Promise.reject(disabled());
  }

  stream(_req: CompleteRequest, _onDelta: OnDelta): Promise<string> {
    return Promise.reject(disabled());
  }
}
