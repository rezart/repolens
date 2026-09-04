import { detectLanguage } from './language.js';

export interface Chunk {
  path: string;
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. */
  endLine: number;
  content: string;
}

export interface ChunkOptions {
  maxLines?: number;
  overlap?: number;
}

/** Hard cap so a minified or generated line never blows up an embedding request. */
export const MAX_CHUNK_CHARS = 6000;

const GENERIC = [/^[A-Za-z_]/];

const BOUNDARY_PATTERNS: Record<string, RegExp[]> = {
  typescript: [/^(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|enum|const|let|var|abstract class)\b/],
  javascript: [/^(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|enum|const|let|var|abstract class)\b/],
  vue: [/^(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|enum|const|let|var)\b/, /^<\/?(template|script|style)\b/],
  svelte: [/^(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|enum|const|let|var)\b/, /^<\/?(script|style)\b/],
  python: [/^(async\s+)?(def|class)\s/, /^@\w+/],
  go: [/^(func|type)\s/],
  rust: [/^(pub(\(crate\))?\s+)?(fn|struct|enum|impl|trait|mod|const|static)\b/],
  java: [/^\s{0,4}(public|private|protected|static|final|abstract|class|interface|enum|record)\b/],
  kotlin: [/^\s{0,4}(public|private|protected|static|final|abstract|class|interface|enum|record|fun|object|val|var)\b/],
  csharp: [/^\s{0,4}(public|private|protected|static|final|abstract|class|interface|enum|record|namespace)\b/],
  ruby: [/^(def|class|module)\s/],
  markdown: [/^#{1,6}\s/],
  php: [/^\s{0,4}(public|private|protected|static|abstract|final|function|class|interface|trait)\b/],
  swift: [/^\s{0,4}(public|private|internal|open|final|func|class|struct|enum|protocol|extension)\b/],
  scala: [/^\s{0,4}(def|class|object|trait|case class|val|var)\b/],
  elixir: [/^\s{0,4}(def|defp|defmodule|defmacro)\s/],
};

/** Line comment prefixes used to pull a leading comment block into the chunk below it. */
const COMMENT_PREFIXES = ['//', '#', '--', ';', '%', '*', '/*', '"""', "'''", '<!--'];

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

function isComment(line: string): boolean {
  const t = line.trim();
  if (t.length === 0) return false;
  return COMMENT_PREFIXES.some((p) => t.startsWith(p));
}

function patternsFor(path: string): RegExp[] {
  const lang = detectLanguage(path);
  if (!lang) return GENERIC;
  return BOUNDARY_PATTERNS[lang] ?? GENERIC;
}

/**
 * Line indexes (0-based) where a new chunk should start. Index 0 is always included.
 * A definition only starts a boundary when the block above it begins after a blank
 * line, so a leading comment/docstring stays attached to the definition it documents.
 */
function findBoundaries(lines: string[], patterns: RegExp[]): number[] {
  const boundaries = new Set<number>([0]);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line)) continue;
    if (!patterns.some((re) => re.test(line))) continue;
    // Walk up over the contiguous comment block directly above the definition.
    let start = i;
    while (start > 0 && isComment(lines[start - 1])) start--;
    if (start === 0 || isBlank(lines[start - 1])) boundaries.add(start);
  }
  return [...boundaries].sort((a, b) => a - b);
}

interface Segment {
  start: number;
  end: number; // inclusive, 0-based
}

function mergeSegments(segments: Segment[], maxLines: number): Segment[] {
  const out: Segment[] = [];
  for (const seg of segments) {
    const last = out[out.length - 1];
    if (last && seg.end - last.start + 1 <= maxLines) {
      last.end = seg.end;
    } else {
      out.push({ ...seg });
    }
  }
  return out;
}

function windowSegment(seg: Segment, maxLines: number, overlap: number): Segment[] {
  const size = seg.end - seg.start + 1;
  if (size <= maxLines) return [seg];
  const step = Math.max(1, maxLines - overlap);
  const out: Segment[] = [];
  for (let s = seg.start; s <= seg.end; s += step) {
    const e = Math.min(s + maxLines - 1, seg.end);
    out.push({ start: s, end: e });
    if (e === seg.end) break;
  }
  return out;
}

/** Split a window further when its text exceeds the character budget. */
function enforceCharBudget(path: string, lines: string[], seg: Segment): Chunk[] {
  const out: Chunk[] = [];
  let bufStart = seg.start;
  let buf: string[] = [];
  let len = 0;

  const flush = (endIdx: number) => {
    if (buf.length === 0) return;
    const content = buf.join('\n');
    if (content.trim().length > 0) {
      out.push({ path, startLine: bufStart + 1, endLine: endIdx + 1, content });
    }
    buf = [];
    len = 0;
  };

  for (let i = seg.start; i <= seg.end; i++) {
    const raw = lines[i];
    const line = raw.length > MAX_CHUNK_CHARS ? raw.slice(0, MAX_CHUNK_CHARS) : raw;
    if (line.length >= MAX_CHUNK_CHARS) {
      flush(i - 1);
      bufStart = i;
      if (line.trim().length > 0) out.push({ path, startLine: i + 1, endLine: i + 1, content: line });
      bufStart = i + 1;
      continue;
    }
    if (buf.length > 0 && len + line.length + 1 > MAX_CHUNK_CHARS) {
      flush(i - 1);
      bufStart = i;
    }
    buf.push(line);
    len += line.length + 1;
  }
  flush(seg.end);
  return out;
}

/**
 * Split a source file into overlapping, definition-aligned chunks.
 * Line numbers in the result are 1-based and inclusive.
 */
export function chunkFile(path: string, text: string, options: ChunkOptions = {}): Chunk[] {
  const maxLines = options.maxLines ?? 80;
  const overlap = Math.max(0, Math.min(options.overlap ?? 8, maxLines - 1));
  if (text.trim().length === 0) return [];

  const lines = text.split('\n');
  const boundaries = findBoundaries(lines, patternsFor(path));

  const segments: Segment[] = boundaries.map((start, i) => ({
    start,
    end: (i + 1 < boundaries.length ? boundaries[i + 1] : lines.length) - 1,
  }));

  const merged = mergeSegments(segments, maxLines);
  const chunks: Chunk[] = [];
  for (const seg of merged) {
    for (const win of windowSegment(seg, maxLines, overlap)) {
      chunks.push(...enforceCharBudget(path, lines, win));
    }
  }
  return chunks;
}
