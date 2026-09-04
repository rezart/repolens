import { describe, it, expect } from 'vitest';
import { extractJson, JsonExtractError } from '../../src/llm/json.js';

describe('extractJson', () => {
  it('parses fenced json', () => {
    expect(extractJson('Here:\n```json\n{"a":1}\n```\nthanks')).toEqual({ a: 1 });
  });
  it('parses json wrapped in prose', () => {
    expect(extractJson('Sure! {"a":[1,2]} done')).toEqual({ a: [1, 2] });
  });
  it('handles braces inside strings', () => {
    expect(extractJson('{"s":"a } b { c", "n": {"x": "]"}}')).toEqual({ s: 'a } b { c', n: { x: ']' } });
  });
  it('skips a false opener and finds the real object', () => {
    expect(extractJson('notes { unbalanced\n{"ok":true}')).toEqual({ ok: true });
  });
  it('throws when no json is present', () => {
    expect(() => extractJson('nothing here')).toThrow(JsonExtractError);
  });
});
