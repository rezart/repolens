import { describe, it, expect } from 'vitest';
import { tokenizeQuery, buildFtsQuery, identifiersFromCode } from '../../src/search/tokenize.js';

describe('tokenizeQuery', () => {
  it('splits camelCase identifiers keeping the original first', () => {
    expect(tokenizeQuery('getUserById')).toEqual(['getuserbyid', 'get', 'user', 'by', 'id']);
  });

  it('splits snake_case identifiers keeping the original first', () => {
    expect(tokenizeQuery('parse_remote')).toEqual(['parse_remote', 'parse', 'remote']);
  });

  it('handles SCREAMING_SNAKE and acronym boundaries', () => {
    expect(tokenizeQuery('HTTPServerConfig')).toEqual(['httpserverconfig', 'http', 'server', 'config']);
    expect(tokenizeQuery('MAX_RETRY_COUNT')).toEqual(['max_retry_count', 'max', 'retry', 'count']);
  });

  it('drops stopwords and very short tokens', () => {
    expect(tokenizeQuery('how does the token verification work?')).toEqual(['token', 'verification']);
    expect(tokenizeQuery('what is a b c')).toEqual([]);
  });

  it('dedupes preserving first-seen order', () => {
    expect(tokenizeQuery('token token_store store')).toEqual(['token', 'token_store', 'store']);
  });

  it('keeps a compound identifier even when its parts are stopwords', () => {
    const tokens = tokenizeQuery('where does this_file live');
    expect(tokens[0]).toBe('this_file');
    expect(tokens).toContain('live');
  });

  it('returns nothing for an empty or punctuation-only query', () => {
    expect(tokenizeQuery('')).toEqual([]);
    expect(tokenizeQuery('??? !!!')).toEqual([]);
  });
});

describe('buildFtsQuery', () => {
  it('quotes each token and escapes embedded quotes', () => {
    expect(buildFtsQuery(['a', 'b"c'])).toBe('"a" OR "b""c"');
  });

  it('returns an empty string for no tokens', () => {
    expect(buildFtsQuery([])).toBe('');
  });

  it('produces a query sqlite accepts for a tokenized question', () => {
    expect(buildFtsQuery(tokenizeQuery('how does verifyToken work'))).toBe('"verifytoken" OR "verify" OR "token"');
  });
});

describe('identifiersFromCode', () => {
  it('drops language keywords and orders by frequency', () => {
    const code = [
      'export const parseRemote = (url) => {',
      '  return parseRemote(url);',
      '};',
      'function helper() { return parseRemote(1); }',
    ].join('\n');
    const ids = identifiersFromCode(code);
    expect(ids.slice(0, 3)).toEqual(['parseRemote', 'url', 'helper']);
    for (const kw of ['export', 'const', 'return', 'function']) expect(ids).not.toContain(kw);
  });

  it('skips identifiers shorter than 3 characters and dedupes', () => {
    const ids = identifiersFromCode('let ab = cde + cde + fg;');
    expect(ids).toEqual(['cde']);
  });

  it('caps the result at 40 identifiers', () => {
    const code = Array.from({ length: 100 }, (_, i) => `ident${i}`).join(' ');
    expect(identifiersFromCode(code)).toHaveLength(40);
  });
});
