import { describe, expect, it } from 'vitest';
import { freshReviewDeps, parseReviewArgs } from '../src/cli.js';

describe('review CLI options', () => {
  it('keeps fresh reviews dry-run unless --post is explicit', () => {
    expect(parseReviewArgs(['github:o/r', '42', '--fresh'])).toMatchObject({
      repoId: 'github:o/r', prNumber: 42, fresh: true, post: false, force: false,
    });
    expect(parseReviewArgs(['github:o/r', '42', '--fresh', '--post']).post).toBe(true);
  });

  it('passes the configured verifier backend through fresh review wiring', () => {
    const primary = { name: 'qwen' };
    const verifier = { name: 'gpt-5-mini' };
    const wired = freshReviewDeps({
      llm: primary, verifierLlm: verifier,
      config: { review: { statusContext: '', failOn: 'critical', maxRetries: 3, ignorePatterns: [] } },
    } as never);
    expect(wired.verifierLlm).toBe(verifier);
  });
});
