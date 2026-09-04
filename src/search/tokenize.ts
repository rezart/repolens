/**
 * Query and code tokenisation for lexical retrieval.
 *
 * The FTS5 table uses `unicode61` with `_` as a token character, so a
 * `snake_case` identifier is a single token in the index. We therefore index
 * both the full identifier and its parts so that a question mentioning
 * "user id" can still reach `getUserById`.
 */

/** Words that carry no retrieval signal in a question about code. */
const STOPWORDS = new Set([
  'a', 'about', 'after', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'because', 'been', 'being',
  'between', 'but', 'by', 'call', 'called', 'calls', 'can', 'code', 'codebase', 'could', 'did', 'do', 'does', 'doing',
  'done', 'each', 'explain', 'file', 'files', 'find', 'for', 'from', 'function', 'get', 'gets', 'give', 'had', 'has',
  'have', 'here', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'know', 'let', 'like', 'make', 'many',
  'may', 'me', 'method', 'might', 'more', 'most', 'much', 'must', 'my', 'need', 'no', 'not', 'of', 'on', 'once', 'one',
  'only', 'or', 'other', 'our', 'out', 'over', 'please', 'repo', 'repository', 'same', 'see', 'should', 'show', 'so',
  'some', 'such', 'tell', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those',
  'through', 'to', 'up', 'us', 'use', 'used', 'uses', 'using', 'very', 'want', 'was', 'we', 'were', 'what', 'when',
  'where', 'which', 'while', 'who', 'why', 'will', 'with', 'work', 'working', 'works', 'would', 'you', 'your',
]);

/** Keywords stripped from code before it is turned into a retrieval query. */
const CODE_KEYWORDS = new Set([
  'abstract', 'and', 'any', 'args', 'as', 'assert', 'async', 'await', 'begin', 'bool', 'boolean', 'break', 'byte',
  'case', 'catch', 'char', 'class', 'const', 'constexpr', 'continue', 'crate', 'def', 'default', 'defer', 'del',
  'delete', 'do', 'double', 'elif', 'else', 'elseif', 'end', 'endif', 'enum', 'except', 'export', 'extends', 'extern',
  'false', 'final', 'finally', 'float', 'fn', 'for', 'foreach', 'from', 'func', 'function', 'global', 'go', 'goto',
  'if', 'impl', 'implements', 'import', 'in', 'include', 'instanceof', 'int', 'interface', 'is', 'lambda', 'let',
  'long', 'match', 'mod', 'module', 'mut', 'namespace', 'native', 'new', 'nil', 'none', 'nonlocal', 'not', 'null',
  'nullptr', 'operator', 'or', 'package', 'pass', 'print', 'private', 'protected', 'pub', 'public', 'raise', 'range',
  'ref', 'require', 'return', 'select', 'self', 'short', 'signed', 'sizeof', 'static', 'std', 'str', 'string',
  'struct', 'super', 'switch', 'synchronized', 'template', 'then', 'this', 'throw', 'throws', 'trait', 'transient',
  'true', 'try', 'type', 'typedef', 'typeof', 'undefined', 'union', 'unsigned', 'use', 'using', 'var', 'void',
  'volatile', 'where', 'while', 'with', 'yield',
]);

const MIN_TOKEN_LENGTH = 2;
const MIN_IDENTIFIER_LENGTH = 3;
const MAX_IDENTIFIERS = 40;

/** Split an identifier segment on camelCase and acronym boundaries. */
function splitCamel(word: string): string[] {
  return word
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(' ')
    .filter(Boolean);
}

/** Lowercased camelCase + snake_case parts of a single word. */
export function splitIdentifier(word: string): string[] {
  const parts: string[] = [];
  for (const segment of word.split(/_+/)) {
    if (!segment) continue;
    for (const piece of splitCamel(segment)) parts.push(piece.toLowerCase());
  }
  return parts;
}

/**
 * Turn a natural-language question into lexical search tokens: each word,
 * plus its camelCase / snake_case parts, lowercased, stopword-filtered and
 * deduped in first-seen order. Sub-parts of a compound identifier are always
 * kept (so `getUserById` still contributes `by` and `id`).
 */
export function tokenizeQuery(q: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    if (t.length < MIN_TOKEN_LENGTH || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  for (const raw of q.match(/[A-Za-z0-9_]+/g) ?? []) {
    const lower = raw.toLowerCase();
    const parts = splitIdentifier(raw);
    const compound = parts.length > 1;
    // A plain word must survive the stopword list; a compound identifier is
    // always meaningful even when its parts are stopwords.
    if (!compound && STOPWORDS.has(lower)) continue;
    push(lower);
    if (compound) for (const p of parts) push(p);
  }
  return out;
}

/** Build an FTS5 MATCH expression: every token quoted, OR-ed together. */
export function buildFtsQuery(tokens: string[]): string {
  const quoted = tokens.filter((t) => t.length > 0).map((t) => `"${t.replace(/"/g, '""')}"`);
  return quoted.join(' OR ');
}

/**
 * Extract the identifiers that best characterise a blob of code (used to turn
 * a PR diff into a retrieval query). Ordered by frequency, capped.
 */
export function identifiersFromCode(text: string): string[] {
  const counts = new Map<string, number>();
  for (const raw of text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    if (raw.length < MIN_IDENTIFIER_LENGTH) continue;
    if (CODE_KEYWORDS.has(raw.toLowerCase())) continue;
    counts.set(raw, (counts.get(raw) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_IDENTIFIERS)
    .map(([id]) => id);
}
