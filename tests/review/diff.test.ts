import { describe, it, expect } from 'vitest';
import { parseUnifiedDiff, changedNewLines, commentableNewLines, hunkText, type DiffFile } from '../../src/review/diff.js';

const FIXTURE = [
  'diff --git a/src/auth.ts b/src/auth.ts',
  'index 1111111..2222222 100644',
  '--- a/src/auth.ts',
  '+++ b/src/auth.ts',
  '@@ -1,6 +1,7 @@ export function auth()',
  " import { verify } from './jwt.js';",
  ' ',
  '-export function login(user: string) {',
  '+export function login(user: string, pw: string) {',
  '+  audit(user);',
  '   return verify(user);',
  ' }',
  ' ',
  '@@ -20,4 +21,5 @@ function helper()',
  ' const x = 1;',
  ' ',
  '-const y = 2;',
  '+const y = 3;',
  '+const z = 4;',
  ' export { x };',
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,2 @@',
  '+export const a = 1;',
  '+export const b = 2;',
  '\\ No newline at end of file',
  '',
].join('\n');

const RENAMED = [
  'diff --git a/src/old-name.ts b/src/new-name.ts',
  'similarity index 90%',
  'rename from src/old-name.ts',
  'rename to src/new-name.ts',
  'index aaaaaaa..bbbbbbb 100644',
  '--- a/src/old-name.ts',
  '+++ b/src/new-name.ts',
  '@@ -1,2 +1,2 @@',
  '-const a = 1;',
  '+const a = 2;',
  ' export { a };',
  '',
].join('\n');

const DELETED = [
  'diff --git a/src/gone.ts b/src/gone.ts',
  'deleted file mode 100644',
  'index ccccccc..0000000',
  '--- a/src/gone.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-const gone = true;',
  '-export { gone };',
  '',
].join('\n');

const BINARY = [
  'diff --git a/assets/logo.png b/assets/logo.png',
  'index ddddddd..eeeeeee 100644',
  'Binary files a/assets/logo.png and b/assets/logo.png differ',
  '',
].join('\n');

const BINARY_PATCH = [
  'diff --git a/assets/logo.png b/assets/logo.png',
  'index ddddddd..eeeeeee 100644',
  'GIT binary patch',
  'literal 12',
  'zcmZ?wbhEHb',
  '',
].join('\n');

function byPath(files: DiffFile[], p: string): DiffFile {
  const f = files.find((x) => x.newPath === p || x.oldPath === p);
  if (!f) throw new Error(`no diff file for ${p}`);
  return f;
}

describe('parseUnifiedDiff', () => {
  it('parses a two-file diff with paths, statuses and hunk counts', () => {
    const files = parseUnifiedDiff(FIXTURE);
    expect(files).toHaveLength(2);

    const auth = files[0]!;
    expect(auth.oldPath).toBe('src/auth.ts');
    expect(auth.newPath).toBe('src/auth.ts');
    expect(auth.status).toBe('modified');
    expect(auth.binary).toBe(false);
    expect(auth.hunks).toHaveLength(2);

    const added = files[1]!;
    expect(added.oldPath).toBeNull();
    expect(added.newPath).toBe('src/new.ts');
    expect(added.status).toBe('added');
    expect(added.hunks).toHaveLength(1);
    expect(added.hunks[0]!.lines.map((l) => l.type)).toEqual(['add', 'add']);
  });

  it('records hunk ranges and headers', () => {
    const auth = parseUnifiedDiff(FIXTURE)[0]!;
    const [h1, h2] = auth.hunks;
    expect(h1).toMatchObject({ oldStart: 1, oldLines: 6, newStart: 1, newLines: 7 });
    expect(h1!.header).toContain('@@ -1,6 +1,7 @@');
    expect(h2).toMatchObject({ oldStart: 20, oldLines: 4, newStart: 21, newLines: 5 });
  });

  it('assigns old and new line numbers', () => {
    const auth = parseUnifiedDiff(FIXTURE)[0]!;
    const h1 = auth.hunks[0]!;
    expect(h1.lines[0]).toMatchObject({ type: 'ctx', oldLine: 1, newLine: 1 });
    const del = h1.lines.find((l) => l.type === 'del')!;
    expect(del.oldLine).toBe(3);
    expect(del.newLine).toBeUndefined();
    const firstAddH1 = h1.lines.find((l) => l.type === 'add')!;
    expect(firstAddH1.newLine).toBe(3);
    expect(firstAddH1.oldLine).toBeUndefined();

    // Hunk 2 starts at new line 21: ctx 21, ctx 22, del(old 22), add 23, add 24, ctx 25
    const h2 = auth.hunks[1]!;
    const firstAddH2 = h2.lines.find((l) => l.type === 'add')!;
    expect(firstAddH2.newLine).toBe(23);
    expect(firstAddH2.content).toBe('const y = 3;');
    expect(h2.lines.at(-1)).toMatchObject({ type: 'ctx', oldLine: 23, newLine: 25 });
  });

  it('treats a missing count in the @@ header as 1', () => {
    const files = parseUnifiedDiff(
      ['diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt', '@@ -5 +5 @@', '-old', '+new', ''].join('\n'),
    );
    const h = files[0]!.hunks[0]!;
    expect(h).toMatchObject({ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 });
    expect(h.lines.find((l) => l.type === 'add')!.newLine).toBe(5);
  });

  it('ignores "\\ No newline at end of file" markers', () => {
    const added = parseUnifiedDiff(FIXTURE)[1]!;
    expect(added.hunks[0]!.lines).toHaveLength(2);
    expect(added.hunks[0]!.lines.every((l) => !l.content.startsWith('\\'))).toBe(true);
  });

  it('parses renamed files', () => {
    const [f] = parseUnifiedDiff(RENAMED);
    expect(f!.status).toBe('renamed');
    expect(f!.oldPath).toBe('src/old-name.ts');
    expect(f!.newPath).toBe('src/new-name.ts');
    expect(f!.hunks[0]!.lines.find((l) => l.type === 'add')!.newLine).toBe(1);
  });

  it('parses deleted files', () => {
    const [f] = parseUnifiedDiff(DELETED);
    expect(f!.status).toBe('deleted');
    expect(f!.oldPath).toBe('src/gone.ts');
    expect(f!.newPath).toBeNull();
    expect(changedNewLines(f!).size).toBe(0);
  });

  it('flags binary files and gives them no hunks', () => {
    const [f] = parseUnifiedDiff(BINARY);
    expect(f!.binary).toBe(true);
    expect(f!.hunks).toHaveLength(0);
    expect(f!.newPath).toBe('assets/logo.png');

    const [g] = parseUnifiedDiff(BINARY_PATCH);
    expect(g!.binary).toBe(true);
    expect(g!.hunks).toHaveLength(0);
  });

  it('returns an empty array for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff('   \n')).toEqual([]);
  });

  it('handles paths containing spaces via the ---/+++ lines', () => {
    const files = parseUnifiedDiff(
      [
        'diff --git a/my dir/a b.ts b/my dir/a b.ts',
        '--- a/my dir/a b.ts',
        '+++ b/my dir/a b.ts',
        '@@ -1 +1 @@',
        '-x',
        '+y',
        '',
      ].join('\n'),
    );
    expect(files[0]!.newPath).toBe('my dir/a b.ts');
  });
});

describe('changedNewLines / commentableNewLines', () => {
  it('returns only added new-file line numbers', () => {
    const auth = byPath(parseUnifiedDiff(FIXTURE), 'src/auth.ts');
    expect([...changedNewLines(auth)].sort((a, b) => a - b)).toEqual([3, 4, 23, 24]);
  });

  it('includes context lines for commentable lines', () => {
    const auth = byPath(parseUnifiedDiff(FIXTURE), 'src/auth.ts');
    expect([...commentableNewLines(auth)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 21, 22, 23, 24, 25]);
  });
});

describe('hunkText', () => {
  it('renders numbered lines with +/-/space markers', () => {
    const auth = byPath(parseUnifiedDiff(FIXTURE), 'src/auth.ts');
    const text = hunkText(auth);
    expect(text).toContain('@@ -1,6 +1,7 @@');
    expect(text).toContain('    3 + export function login(user: string, pw: string) {');
    expect(text).toContain('    4 +   audit(user);');
    expect(text).toContain('    3 - export function login(user: string) {');
    expect(text).toContain('    1   import { verify } from \'./jwt.js\';');
    expect(text).toContain('@@ -20,4 +21,5 @@');
    expect(text).toContain('   23 + const y = 3;');
  });

  it('truncates once over the budget', () => {
    const auth = byPath(parseUnifiedDiff(FIXTURE), 'src/auth.ts');
    const text = hunkText(auth, 60);
    expect(text.length).toBeLessThan(200);
    expect(text).toContain('... (truncated)');
  });

  it('returns an empty string for a file with no hunks', () => {
    const [f] = parseUnifiedDiff(BINARY);
    expect(hunkText(f!)).toBe('');
  });
});
