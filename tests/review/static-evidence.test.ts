import { describe, it, expect } from 'vitest';
import { collectStaticEvidence } from '../../src/review/static-evidence.js';

describe('collectStaticEvidence', () => {
  it('reports declared parameters, response properties, unawaited calls, and local arity', () => {
    const facts = collectStaticEvidence('src/api.ts', [
      'function load(userId: string, limit: number) { return fetchUser(userId); }',
      'const value = response.data;',
      'save(value);',
      'function fetchUser(id: string, mode: string) { return id; }',
      'fetchUser(userId);',
    ].join('\n'));

    expect(facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'declared-parameters', line: 1, detail: expect.stringContaining('2 parameters') }),
      expect.objectContaining({ kind: 'response-property', line: 2, detail: 'response.data' }),
      expect.objectContaining({ kind: 'unawaited-call', line: 3, detail: 'save(value)' }),
      expect.objectContaining({ kind: 'local-api-arity', line: 5, detail: expect.stringContaining('fetchUser expects 2 arguments') }),
    ]));
  });

  it('does not label awaited calls, matching local arity, comments, or string literals', () => {
    const facts = collectStaticEvidence('src/api.ts', [
      'async function run() {',
      '  await save(value);',
      '  // response.data; save(value);',
      '  /* response.data; save(value); */',
      '  const text = "response.data";',
      '  await fetchUser(userId, mode);',
      '}',
      'function fetchUser(id: string, mode: string) { return id; }',
    ].join('\n'));

    expect(facts.some((fact) => fact.kind === 'unawaited-call')).toBe(false);
    expect(facts.some((fact) => fact.kind === 'response-property')).toBe(false);
    expect(facts.some((fact) => fact.kind === 'local-api-arity')).toBe(false);
  });

  it('reports configured runtime and version facts only from recognized files', () => {
    const packageFacts = collectStaticEvidence('package.json', '{"engines":{"node":">=20.11"},"volta":{"node":"20.11.1"}}');
    const nodeFacts = collectStaticEvidence('.nvmrc', '20.11.1\n');
    const pythonFacts = collectStaticEvidence('pyproject.toml', '[project]\nrequires-python = ">=3.10"\n');
    const arbitraryFacts = collectStaticEvidence('src/runtime.ts', 'const nodeVersion = userInput;');

    expect(packageFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'runtime-version', detail: expect.stringContaining('node >=20.11') }),
    ]));
    expect(nodeFacts).toEqual([expect.objectContaining({ kind: 'runtime-version', line: 1, detail: 'node 20.11.1' })]);
    expect(pythonFacts).toEqual([expect.objectContaining({ kind: 'runtime-version', line: 2, detail: 'python >=3.10' })]);
    expect(arbitraryFacts.some((fact) => fact.kind === 'runtime-version')).toBe(false);
  });

  it('bounds advisory output', () => {
    const content = Array.from({ length: 100 }, (_, index) => `response.value${index};`).join('\n');
    expect(collectStaticEvidence('src/api.ts', content).length).toBeLessThanOrEqual(40);
  });

  it('does not fabricate facts from Python comments, multiline templates, or regex literals', () => {
    expect(collectStaticEvidence('src/api.py', '# response.data; save(value);')).toEqual([]);
    expect(collectStaticEvidence('src/api.ts', 'const text = `response.data;\nsave(value);`;')).toEqual([]);
    expect(collectStaticEvidence('src/api.ts', 'const pattern = /response.data/;')).toEqual([]);
  });

  it('does not fabricate facts from Ruby block comments or regex literals', () => {
    expect(collectStaticEvidence('lib/api.rb', [
      '=begin',
      'response.data; save(value);',
      '=end',
    ].join('\n'))).toEqual([]);
    expect(collectStaticEvidence('lib/api.rb', 'pattern = /response.data/')).toEqual([]);
  });

  it('does not fabricate facts from regex literals after JavaScript arrows', () => {
    const facts = collectStaticEvidence('src/api.ts', 'const matcher = () => /response.data/;');
    expect(facts.some((fact) => fact.kind === 'response-property' || fact.kind === 'unawaited-call')).toBe(false);
  });

  it('does not report arity mismatches for destructured parameters or object arguments', () => {
    const facts = collectStaticEvidence('src/api.ts', [
      'function load({ id, mode }: Input) { return id; }',
      'load({ id, mode });',
      'function typed(value: Map<string, number>) { return value; }',
      'typed(value);',
    ].join('\n'));
    expect(facts.some((fact) => fact.kind === 'local-api-arity')).toBe(false);
  });

  it('does not report arity mismatches for qualified receiver calls', () => {
    const facts = collectStaticEvidence('src/api.ts', [
      'function fetchUser(id: string, mode: string) { return id; }',
      'client.fetchUser(userId);',
      'client?.fetchUser(userId);',
    ].join('\n'));
    expect(facts.some((fact) => fact.kind === 'local-api-arity')).toBe(false);
  });

  it('does not report arity mismatches for optional, default, rest, or trailing parameters', () => {
    const facts = collectStaticEvidence('src/api.ts', [
      'function optional(required: string, maybe?: string) { return required; }',
      'optional("value");',
      'function defaults(required: string, fallback = 1) { return required; }',
      'defaults("value");',
      'function rest(required: string, ...extras: string[]) { return required; }',
      'rest("value",);',
    ].join('\n'));
    expect(facts.some((fact) => fact.kind === 'local-api-arity')).toBe(false);
  });

  it('does not treat comparison expressions as arity mismatches', () => {
    const facts = collectStaticEvidence('src/api.ts', [
      'function compare(left: boolean, right: string) { return right; }',
      'compare(a < b, value);',
    ].join('\n'));
    expect(facts.some((fact) => fact.kind === 'local-api-arity')).toBe(false);
  });

  it('skips arity heuristics for nested function-type parameters', () => {
    const facts = collectStaticEvidence('src/api.ts', [
      'function invoke(callback: (value: string) => number, count: number) { return count; }',
      'invoke(callback, count);',
    ].join('\n'));
    expect(facts.some((fact) => fact.kind === 'local-api-arity')).toBe(false);
  });

  it('suppresses facts on ambiguous division and regex-literal lines', () => {
    const facts = collectStaticEvidence('src/api.ts', 'const matcher = input / /response.data/.test(input);');
    expect(facts).toEqual([]);
  });

  it('suppresses Ruby facts on ambiguous division and regex-literal lines', () => {
    const facts = collectStaticEvidence('lib/api.rb', 'matcher = input / /response.data/.match(input)');
    expect(facts).toEqual([]);
  });

  it('suppresses JS facts for slash literals after ambiguous operators', () => {
    for (const operator of ['+', '-', '*', '>']) {
      expect(collectStaticEvidence('src/api.ts', `const matcher = value ${operator} /response.data/.test(value);`)).toEqual([]);
    }
  });

  it('suppresses Ruby facts for slash literals after ambiguous operators', () => {
    for (const operator of ['+', '-', '*', '>']) {
      expect(collectStaticEvidence('lib/api.rb', `matcher = value ${operator} /response.data/.match(value)`)).toEqual([]);
    }
  });

  it('suppresses all JS heuristic facts on slash-containing lines', () => {
    for (const line of [
      'const ratio = value / other; response.data; save(value);',
      'const matcher = value % /response.data/.test(value);',
      'const matcher = value ^ /response.data/.test(value);',
    ]) {
      expect(collectStaticEvidence('src/api.ts', line)).toEqual([]);
    }
  });

  it('suppresses all Ruby heuristic facts on slash-containing lines', () => {
    expect(collectStaticEvidence('lib/api.rb', 'ratio = value / other; response.data; save(value)')).toEqual([]);
    expect(collectStaticEvidence('lib/api.rb', 'matcher = value % /response.data/.match(value)')).toEqual([]);
  });

  it('keeps ordinary slash-free response and call facts', () => {
    const facts = collectStaticEvidence('src/api.ts', 'const value = response.data;\nsave(value);');
    expect(facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'response-property', detail: 'response.data' }),
      expect.objectContaining({ kind: 'unawaited-call', detail: 'save(value)' }),
    ]));
  });
});
