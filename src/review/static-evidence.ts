export type StaticEvidenceKind =
  | 'declared-parameters'
  | 'response-property'
  | 'awaited-call'
  | 'unawaited-call'
  | 'local-api-arity'
  | 'runtime-version';

export interface StaticEvidenceFact {
  path: string;
  line: number;
  kind: StaticEvidenceKind;
  detail: string;
}

const MAX_FACTS = 40;
const MAX_SOURCE_CHARS = 64_000;
const MAX_DETAIL_CHARS = 240;
const CALL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function']);
const VALUE_NAMES = /\b(?:response|res|result|body|payload)\b/i;
const JS_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const HASH_COMMENT_EXTENSIONS = new Set(['.py', '.pyw', '.rb', '.rake']);

function clip(value: string): string {
  return value.length > MAX_DETAIL_CHARS ? `${value.slice(0, MAX_DETAIL_CHARS)}…` : value;
}

function extension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot).toLowerCase();
}

function maskSource(path: string, source: string): string {
  const ext = extension(path);
  if (!JS_EXTENSIONS.has(ext) && !HASH_COMMENT_EXTENSIONS.has(ext)) return '';
  const hashComments = HASH_COMMENT_EXTENSIONS.has(ext);
  let mode: 'code' | 'line-comment' | 'block-comment' | 'ruby-block-comment' | 'string' | 'regex' | 'triple' = 'code';
  let quote = '';
  let escaped = false;
  let regexClass = false;
  let out = '';
  const currentLine = () => out.slice(Math.max(out.lastIndexOf('\n'), out.lastIndexOf('\r')) + 1).trimEnd();
  const previousToken = () => currentLine().at(-1) ?? '';
  const regexStart = () => {
    const line = currentLine();
    const previous = previousToken();
    if (line.endsWith('=>') || !previous || /[=(:,!&|?{}[;\]~]/.test(previous)) return true;
    const word = line.match(/[A-Za-z_$][\w$]*$/)?.[0];
    return Boolean(word && /^(?:return|throw|case|delete|void|typeof|instanceof|in|of)$/.test(word));
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    const next = source[i + 1] ?? '';
    if (mode === 'line-comment') {
      if (char === '\n' || char === '\r') { mode = 'code'; out += char; } else out += ' ';
      continue;
    }
    if (mode === 'block-comment') {
      if (char === '*' && next === '/') { out += '  '; i++; mode = 'code'; } else out += char === '\n' || char === '\r' ? char : ' ';
      continue;
    }
    if (mode === 'ruby-block-comment') {
      const lineStart = i === 0 || source[i - 1] === '\n' || source[i - 1] === '\r';
      if (lineStart && source.startsWith('=end', i) && ['\n', '\r', ''].includes(source[i + 4] ?? '')) {
        out += '    '; i += 3; mode = 'code';
      } else out += char === '\n' || char === '\r' ? char : ' ';
      continue;
    }
    if (mode === 'triple') {
      if (source.startsWith(quote, i)) { out += ' '.repeat(quote.length); i += quote.length - 1; mode = 'code'; } else out += char === '\n' || char === '\r' ? char : ' ';
      continue;
    }
    if (mode === 'string') {
      if (escaped) { out += char === '\n' || char === '\r' ? char : ' '; escaped = false; }
      else if (char === '\\') { out += ' '; escaped = true; }
      else if (char === quote) { out += char; mode = 'code'; }
      else out += char === '\n' || char === '\r' ? char : ' ';
      continue;
    }
    if (mode === 'regex') {
      if (escaped) { out += ' '; escaped = false; }
      else if (char === '\\') { out += ' '; escaped = true; }
      else if (char === '[') { out += ' '; regexClass = true; }
      else if (char === ']' && regexClass) { out += ' '; regexClass = false; }
      else if (char === '/' && !regexClass) { out += ' '; mode = 'code'; }
      else out += char === '\n' || char === '\r' ? char : ' ';
      continue;
    }
    if (char === '\n' || char === '\r') { out += char; continue; }
    if (hashComments && (i === 0 || source[i - 1] === '\n' || source[i - 1] === '\r') && source.startsWith('=begin', i) && ['\n', '\r', ''].includes(source[i + 6] ?? '')) {
      out += '      '; i += 5; mode = 'ruby-block-comment'; continue;
    }
    if (char === '/' && next === '/') { out += '  '; i++; mode = 'line-comment'; continue; }
    if (char === '/' && next === '*') { out += '  '; i++; mode = 'block-comment'; continue; }
    if (hashComments && char === '#') { out += ' '; mode = 'line-comment'; continue; }
    if (hashComments && (char === '"' || char === "'") && source.startsWith(char.repeat(3), i)) {
      quote = char.repeat(3); out += '   '; i += 2; mode = 'triple'; continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; out += char; mode = 'string'; escaped = false; continue; }
    if (char === '/' && regexStart()) { out += ' '; mode = 'regex'; regexClass = false; escaped = false; continue; }
    out += char;
  }
  return out;
}

function splitTopLevel(value: string, trackAngles: boolean): string[] {
  if (!value.trim()) return [];
  let parens = 0;
  let braces = 0;
  let brackets = 0;
  let angles = 0;
  let anglesEnabled = trackAngles;
  let start = 0;
  const parts: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (char === '(') parens++;
    else if (char === ')') parens--;
    else if (char === '{') braces++;
    else if (char === '}') braces--;
    else if (char === '[') brackets++;
    else if (char === ']') brackets--;
    else if (anglesEnabled && char === '<') angles++;
    else if (anglesEnabled && char === '>' && angles > 0) angles--;
    else if (anglesEnabled && char === '=' && parens === 0 && braces === 0 && brackets === 0) anglesEnabled = false;
    else if (char === ',' && parens === 0 && braces === 0 && brackets === 0 && angles === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
      anglesEnabled = trackAngles;
    }
  }
  const last = value.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

function countArguments(value: string, trackAngles = false): number {
  return splitTopLevel(value, trackAngles).length;
}

interface ArityBounds {
  required: number;
  maximum: number;
}

function parameterBounds(value: string): ArityBounds | undefined {
  // The lightweight declaration matcher stops at the first ')'. A nested
  // parenthesis therefore cannot be trusted to describe the full signature.
  if (value.includes('(') || value.includes(')')) return undefined;
  const parameters = splitTopLevel(value, true);
  let required = 0;
  let maximum = 0;
  let optionalSeen = false;
  for (const parameter of parameters) {
    const trimmed = parameter.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('...')) {
      maximum = Number.POSITIVE_INFINITY;
      optionalSeen = true;
      continue;
    }
    const optional = /\?\s*(?::|$)/.test(trimmed) || /(^|[^=!<>])=(?!=|>)/.test(trimmed);
    if (optional) optionalSeen = true;
    else if (optionalSeen) return undefined;
    maximum = Number.isFinite(maximum) ? maximum + 1 : maximum;
    if (!optional) required++;
  }
  return { required, maximum };
}

function formatBounds(bounds: ArityBounds): string {
  if (!Number.isFinite(bounds.maximum)) return `${bounds.required}+`;
  return bounds.required === bounds.maximum ? String(bounds.maximum) : `${bounds.required}-${bounds.maximum}`;
}

function runtimeFacts(path: string, source: string): StaticEvidenceFact[] {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const facts: StaticEvidenceFact[] = [];
  const add = (line: number, detail: string) => facts.push({ path, line, kind: 'runtime-version', detail: clip(detail) });
  if (base === 'package.json') {
    try {
      const parsed = JSON.parse(source) as { engines?: Record<string, unknown>; volta?: Record<string, unknown> };
      const node = parsed.engines?.node ?? parsed.volta?.node;
      if (typeof node === 'string' && node.trim()) add(1, `node ${node.trim()}`);
    } catch { /* advisory evidence ignores malformed configuration */ }
  } else if (base === '.nvmrc' || base === '.node-version') {
    const version = source.split(/\r?\n/, 1)[0]?.trim();
    if (version) add(1, `node ${version}`);
  } else if (base === 'runtime.txt') {
    const version = source.split(/\r?\n/, 1)[0]?.trim();
    if (version) add(1, version);
  } else if (base === 'pyproject.toml') {
    const match = /^[ \t]*requires-python[ \t]*=[ \t]*["']([^"']+)["']/im.exec(source);
    if (match) add(source.slice(0, match.index).split(/\r?\n/).length, `python ${match[1]}`);
  } else if (base === 'dockerfile') {
    const lines = source.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const match = /^\s*FROM\s+(node|python|openjdk):([^\s]+)/i.exec(lines[i]!);
      if (match) add(i + 1, `${match[1]!.toLowerCase()} ${match[2]}`);
    }
  }
  return facts;
}

/** Extract bounded, non-executing clues; these facts are advisory, not citations. */
export function collectStaticEvidence(path: string, source: string): StaticEvidenceFact[] {
  const bounded = source.slice(0, MAX_SOURCE_CHARS);
  const facts = runtimeFacts(path, bounded);
  if (facts.length >= MAX_FACTS) return facts.slice(0, MAX_FACTS);

  const masked = maskSource(path, bounded);
  if (!masked) return facts;
  const lines = masked.split(/\r?\n/);
  const sourceLines = bounded.split(/\r?\n/);
  const slashSensitive = JS_EXTENSIONS.has(extension(path)) || ['.rb', '.rake'].includes(extension(path));
  const slashLines = new Set(slashSensitive ? sourceLines.flatMap((line, index) => line.includes('/') ? [index] : []) : []);
  const declarations = new Map<string, { arity: ArityBounds; line: number }>();
  const calls: Array<{ name: string; args: string; line: number; text: string; awaited: boolean }> = [];
  const add = (line: number, kind: StaticEvidenceKind, detail: string) => {
    if (facts.length < MAX_FACTS) facts.push({ path, line, kind, detail: clip(detail) });
  };

  for (let index = 0; index < lines.length && facts.length < MAX_FACTS; index++) {
    if (slashLines.has(index)) continue;
    const line = lines[index]!;
    for (const match of line.matchAll(/\b(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g)) {
      const name = match[1]!;
      const bounds = parameterBounds(match[2]!);
      if (bounds) {
        declarations.set(name, { arity: bounds, line: index + 1 });
        add(index + 1, 'declared-parameters', `${name} declares ${formatBounds(bounds)} parameters`);
      }
    }
    for (const match of line.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g)) {
      const bounds = parameterBounds(match[2]!.replace(/^\(|\)$/g, ''));
      if (bounds) {
        declarations.set(match[1]!, { arity: bounds, line: index + 1 });
        add(index + 1, 'declared-parameters', `${match[1]} declares ${formatBounds(bounds)} parameters`);
      }
    }
    if (VALUE_NAMES.test(line)) {
      for (const match of line.matchAll(/\b(?:response|res|result|body|payload)\s*(?:\?\.)?\.\s*([A-Za-z_$][\w$]*)/gi)) {
        add(index + 1, 'response-property', `${match[0]}`);
      }
      for (const match of line.matchAll(/\b(?:response|res|result|body|payload)\s*\[\s*(['"])([^'"]+)\1\s*\]/gi)) {
        add(index + 1, 'response-property', match[0]);
      }
    }
    for (const match of line.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(([^()]*)\)/g)) {
      const name = match[1]!;
      const simpleName = name.slice(name.lastIndexOf('.') + 1);
      const before = line.slice(0, match.index).trimEnd();
      if (CALL_KEYWORDS.has(simpleName) || /\bfunction\s*$/.test(before) || /\b(?:if|for|while|switch|catch)\s*$/.test(before)) continue;
      const awaited = /\bawait\s*$/.test(before);
      const text = `${name}(${match[2]!.trim()})`;
      calls.push({ name: simpleName, args: match[2]!, line: index + 1, text, awaited });
      if (awaited) add(index + 1, 'awaited-call', text);
      else if (!/\b(?:return|void|new)\s*$/.test(before)) add(index + 1, 'unawaited-call', text);
    }
  }

  for (const call of calls) {
    const declaration = declarations.get(call.name);
    const actual = countArguments(call.args);
    if (declaration && (actual < declaration.arity.required || actual > declaration.arity.maximum)) {
      add(call.line, 'local-api-arity', `${call.name} expects ${formatBounds(declaration.arity)} arguments but receives ${actual}`);
    }
  }
  return facts.slice(0, MAX_FACTS);
}
