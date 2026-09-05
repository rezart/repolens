/**
 * Minimal unified-diff parser, good enough for GitHub pull request diffs
 * (`Accept: application/vnd.github.v3.diff`).
 */

export type DiffLineType = 'add' | 'del' | 'ctx';
export type DiffStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DiffLine {
  type: DiffLineType;
  /** Line content without the leading +/-/space marker. */
  content: string;
  /** 1-based line number in the old file (absent for `add` lines). */
  oldLine?: number;
  /** 1-based line number in the new file (absent for `del` lines). */
  newLine?: number;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The raw `@@ -a,b +c,d @@ section heading` line. */
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  oldPath: string | null;
  newPath: string | null;
  status: DiffStatus;
  binary: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface Draft {
  oldPath: string | null;
  newPath: string | null;
  status: DiffStatus;
  explicitStatus: boolean;
  binary: boolean;
  hunks: Hunk[];
}

function newDraft(): Draft {
  return { oldPath: null, newPath: null, status: 'modified', explicitStatus: false, binary: false, hunks: [] };
}

function stripPrefix(raw: string): string | null {
  const p = raw.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  if (p.startsWith('"') && p.endsWith('"')) {
    // git quotes paths containing unusual bytes
    try {
      const unquoted = JSON.parse(p) as string;
      return stripPrefix(unquoted);
    } catch {
      return p;
    }
  }
  return p;
}

/** Best-effort path extraction from `diff --git a/x b/y` (ambiguous when paths contain spaces). */
function pathsFromGitHeader(line: string): { old: string | null; next: string | null } {
  const rest = line.slice('diff --git '.length);
  const m = /^(.*) (b\/.*)$/.exec(rest); // greedy: matches the last " b/..."
  if (!m) return { old: null, next: null };
  return { old: stripPrefix(m[1]!), next: stripPrefix(m[2]!) };
}

function finish(draft: Draft, out: DiffFile[]) {
  if (draft.oldPath === null && draft.newPath === null && draft.hunks.length === 0 && !draft.binary) return;
  out.push({ oldPath: draft.oldPath, newPath: draft.newPath, status: draft.status, binary: draft.binary, hunks: draft.hunks });
}

export function parseUnifiedDiff(text: string): DiffFile[] {
  const out: DiffFile[] = [];
  if (!text || !text.trim()) return out;
  const lines = text.split('\n');

  let draft: Draft | null = null;
  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;

  const closeHunk = () => {
    hunk = null;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      closeHunk();
      if (draft) finish(draft, out);
      draft = newDraft();
      const p = pathsFromGitHeader(line);
      draft.oldPath = p.old;
      draft.newPath = p.next;
      continue;
    }
    if (!draft) {
      // Diff without a `diff --git` header (e.g. plain `diff -u` output).
      if (line.startsWith('--- ')) draft = newDraft();
      else continue;
    }

    if (hunk) {
      const consumable = oldLeft > 0 || newLeft > 0;
      if (line.startsWith('\\')) continue; // "\ No newline at end of file"
      if (consumable && (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-') || line === '')) {
        const marker = line === '' ? ' ' : line[0]!;
        const content = line === '' ? '' : line.slice(1);
        if (marker === '+') {
          hunk.lines.push({ type: 'add', content, newLine: newNo++ });
          newLeft--;
        } else if (marker === '-') {
          hunk.lines.push({ type: 'del', content, oldLine: oldNo++ });
          oldLeft--;
        } else {
          hunk.lines.push({ type: 'ctx', content, oldLine: oldNo++, newLine: newNo++ });
          oldLeft--;
          newLeft--;
        }
        continue;
      }
      closeHunk();
    }

    const hm = HUNK_RE.exec(line);
    if (hm) {
      const oldStart = Number(hm[1]);
      const oldLines = hm[2] === undefined ? 1 : Number(hm[2]);
      const newStart = Number(hm[3]);
      const newLines = hm[4] === undefined ? 1 : Number(hm[4]);
      hunk = { oldStart, oldLines, newStart, newLines, header: line, lines: [] };
      draft.hunks.push(hunk);
      oldNo = oldStart;
      newNo = newStart;
      oldLeft = oldLines;
      newLeft = newLines;
      continue;
    }

    if (line.startsWith('--- ')) {
      const p = stripPrefix(line.slice(4));
      draft.oldPath = p;
      if (p === null && !draft.explicitStatus) draft.status = 'added';
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = stripPrefix(line.slice(4));
      draft.newPath = p;
      if (p === null && !draft.explicitStatus) draft.status = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      draft.oldPath = stripPrefix(line.slice('rename from '.length));
      draft.status = 'renamed';
      draft.explicitStatus = true;
      continue;
    }
    if (line.startsWith('rename to ')) {
      draft.newPath = stripPrefix(line.slice('rename to '.length));
      draft.status = 'renamed';
      draft.explicitStatus = true;
      continue;
    }
    if (line.startsWith('new file mode')) {
      draft.status = 'added';
      draft.explicitStatus = true;
      draft.oldPath = null;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      draft.status = 'deleted';
      draft.explicitStatus = true;
      continue;
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      draft.binary = true;
      continue;
    }
  }

  if (draft) finish(draft, out);
  // A deleted file has no new path even if the `+++ /dev/null` line was absent.
  for (const f of out) {
    if (f.status === 'deleted') f.newPath = null;
    if (f.status === 'added') f.oldPath = null;
  }
  return out;
}

/** New-file line numbers of added (`+`) lines — the lines GitHub accepts RIGHT-side comments on. */
export function changedNewLines(file: DiffFile): Set<number> {
  const set = new Set<number>();
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.type === 'add' && l.newLine !== undefined) set.add(l.newLine);
    }
  }
  return set;
}

/** Added plus context new-file line numbers (every RIGHT-side line present in the diff). */
export function commentableNewLines(file: DiffFile): Set<number> {
  const set = new Set<number>();
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if ((l.type === 'add' || l.type === 'ctx') && l.newLine !== undefined) set.add(l.newLine);
    }
  }
  return set;
}

const TRUNCATED = '... (truncated)';

/** Render a file's hunks with line numbers so the model can cite `line` accurately. */
export function hunkText(file: DiffFile, maxChars = Infinity): string {
  const out: string[] = [];
  let size = 0;
  let truncated = false;

  const push = (s: string): boolean => {
    if (size + s.length + 1 > maxChars) {
      truncated = true;
      return false;
    }
    out.push(s);
    size += s.length + 1;
    return true;
  };

  outer: for (const h of file.hunks) {
    if (!push(h.header)) break;
    for (const l of h.lines) {
      const num = l.type === 'del' ? l.oldLine : l.newLine;
      const label = num === undefined ? '     ' : String(num).padStart(5);
      const sign = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
      if (!push(`${label} ${sign} ${l.content}`)) break outer;
    }
  }

  if (truncated) out.push(TRUNCATED);
  return out.join('\n');
}
