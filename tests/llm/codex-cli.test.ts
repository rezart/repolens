import { describe, expect, it, vi } from 'vitest';
import { CodexCliProvider } from '../../src/llm/codex-cli.js';

describe('CodexCliProvider', () => {
  it('fails closed before invoking the CLI', () => {
    const run = vi.fn();
    expect(() => new CodexCliProvider({ run })).toThrow(/codex-cli is temporarily disabled/);
    expect(run).not.toHaveBeenCalled();
  });
});
