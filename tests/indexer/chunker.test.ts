import { describe, it, expect } from 'vitest';
import { chunkFile } from '../../src/indexer/chunker.js';
import { detectLanguage, shouldIndex } from '../../src/indexer/language.js';

const tsSource = [
  '// returns one',
  'function one() {',
  '  const a = 1;',
  '  return a;',
  '}',
  '',
  '// returns two',
  'function two() {',
  '  const b = 2;',
  '  return b;',
  '}',
  '',
  '// returns three',
  'function three() {',
  '  const c = 3;',
  '  return c;',
  '}',
].join('\n');

describe('detectLanguage', () => {
  it('maps extensions to languages', () => {
    expect(detectLanguage('src/a.ts')).toBe('typescript');
    expect(detectLanguage('src/a.tsx')).toBe('typescript');
    expect(detectLanguage('a.mjs')).toBe('javascript');
    expect(detectLanguage('a.py')).toBe('python');
    expect(detectLanguage('a.go')).toBe('go');
    expect(detectLanguage('a.rs')).toBe('rust');
    expect(detectLanguage('a.kt')).toBe('kotlin');
    expect(detectLanguage('a.cc')).toBe('cpp');
    expect(detectLanguage('a.yml')).toBe('yaml');
    expect(detectLanguage('README.md')).toBe('markdown');
    expect(detectLanguage('notes.txt')).toBe('text');
    expect(detectLanguage('infra/main.tf')).toBe('terraform');
  });

  it('recognises Dockerfile and Makefile by basename', () => {
    expect(detectLanguage('Dockerfile')).toBe('dockerfile');
    expect(detectLanguage('docker/Dockerfile')).toBe('dockerfile');
    expect(detectLanguage('Makefile')).toBe('makefile');
  });

  it('returns null for unknown files', () => {
    expect(detectLanguage('a.unknownext')).toBeNull();
    expect(detectLanguage('LICENSE')).toBeNull();
  });
});

describe('shouldIndex', () => {
  it('skips vendored directories, lockfiles, binaries and huge files', () => {
    expect(shouldIndex('node_modules/x/index.js', 10)).toBe(false);
    expect(shouldIndex('src/a.ts', 10)).toBe(true);
    expect(shouldIndex('a.png', 10)).toBe(false);
    expect(shouldIndex('big.ts', 600 * 1024)).toBe(false);
    expect(shouldIndex('package-lock.json', 10)).toBe(false);
    expect(shouldIndex('dist/bundle.js', 10)).toBe(false);
    expect(shouldIndex('src/app.min.js', 10)).toBe(false);
    expect(shouldIndex('src/app.js.map', 10)).toBe(false);
    expect(shouldIndex('LICENSE', 10)).toBe(false);
  });
});

describe('chunkFile', () => {
  it('returns [] for an empty or whitespace-only file', () => {
    expect(chunkFile('a.ts', '')).toEqual([]);
    expect(chunkFile('a.ts', '\n\n   \n')).toEqual([]);
  });

  it('splits a TS file at top-level functions, keeping the comment above each', () => {
    const chunks = chunkFile('src/a.ts', tsSource, { maxLines: 10, overlap: 2 });
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.startLine)).toEqual([1, 7, 13]);
    expect(chunks[0].content.startsWith('// returns one')).toBe(true);
    expect(chunks[1].content.startsWith('// returns two')).toBe(true);
    expect(chunks[2].content).toContain('function three');
    expect(chunks[0].path).toBe('src/a.ts');
    // lines are 1-based inclusive and cover the file
    expect(chunks[2].endLine).toBe(tsSource.split('\n').length);
  });

  it('windows a long boundary-less file with overlap', () => {
    const text = Array.from({ length: 300 }, (_, i) => `  value${i} = ${i};`).join('\n');
    const chunks = chunkFile('a.ts', text);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(80);
    expect(chunks[1].startLine).toBe(73);
    expect(chunks[1].endLine).toBe(152);
    expect(chunks[chunks.length - 1].endLine).toBe(300);
  });

  it('splits markdown at headings', () => {
    const md = [
      '# Title',
      '',
      'intro line',
      '',
      '## Install',
      '',
      'run npm install',
      'and then build',
      '',
      '## Usage',
      '',
      'call the thing',
      'twice a day',
    ].join('\n');
    const chunks = chunkFile('README.md', md, { maxLines: 4, overlap: 1 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.some((c) => c.content.startsWith('## Install'))).toBe(true);
    expect(chunks.some((c) => c.content.startsWith('## Usage'))).toBe(true);
  });

  it('splits python at defs and decorators', () => {
    const py = [
      'import os',
      '',
      '@cached',
      'def alpha():',
      '    return 1',
      '',
      'def beta():',
      '    return 2',
    ].join('\n');
    const chunks = chunkFile('a.py', py, { maxLines: 3, overlap: 1 });
    expect(chunks.some((c) => c.content.startsWith('@cached'))).toBe(true);
    expect(chunks.some((c) => c.content.startsWith('def beta'))).toBe(true);
  });

  it('keeps every chunk within the character budget', () => {
    const long = 'x'.repeat(9000);
    const chunks = chunkFile('a.ts', [long, long].join('\n'));
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(6000);
  });

  it('drops whitespace-only chunks', () => {
    const text = ['function a() {}', '', '', '', ''].join('\n');
    const chunks = chunkFile('a.ts', text, { maxLines: 2, overlap: 0 });
    for (const c of chunks) expect(c.content.trim().length).toBeGreaterThan(0);
  });
});
