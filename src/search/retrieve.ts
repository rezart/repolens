import type { Db, ChunkRow, SearchHit } from '../db.js';
import type { EmbeddingProvider } from '../embeddings/types.js';
import type { RetrieveFn, RetrieveRequest, RetrievedChunk } from './types.js';
import { buildFtsQuery, tokenizeQuery } from './tokenize.js';

/** A citation returned alongside an answer or review. */
export interface Source {
  repository: string;
  filepath: string;
  linestart: number;
  lineend: number;
  summary: string;
}

const DEFAULT_LIMIT = 12;
/** How many candidates each signal contributes per requested result. */
const CANDIDATE_FACTOR = 3;
const RRF_K = 60;
const SUMMARY_CHARS = 120;

/**
 * Reciprocal rank fusion. Each ranking is a list of chunk ids, best first;
 * an id scores `1 / (k + rank)` per list it appears in (rank is 1-based).
 */
export function rrf(rankings: number[][], k = RRF_K): Map<number, number> {
  const scores = new Map<number, number>();
  for (const ranking of rankings) {
    for (let i = 0; i < ranking.length; i++) {
      const id = ranking[i];
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
    }
  }
  return scores;
}

/** Changelogs and release notes mention every identifier; keep them but rank code above them. */
const LOW_SIGNAL_PATH = /(^|\/)(changelog|changes|history|release[-_]?notes|news)(\.(md|markdown|txt|rst|adoc))?$/i;

export function pathWeight(path: string): number {
  return LOW_SIGNAL_PATH.test(path) ? 0.6 : 1;
}

function toRetrieved(chunk: ChunkRow, score: number): RetrievedChunk {
  return {
    chunkId: chunk.id,
    repoId: chunk.repo_id,
    path: chunk.path,
    startLine: chunk.start_line,
    endLine: chunk.end_line,
    content: chunk.content,
    score,
  };
}

/**
 * Hybrid retriever: BM25 over the FTS index fused with vector similarity
 * (when an embedding provider and a vector table are both available).
 */
export function createRetriever({ db, embeddings }: { db: Db; embeddings?: EmbeddingProvider | null }): RetrieveFn {
  return async (req: RetrieveRequest): Promise<RetrievedChunk[]> => {
    const limit = req.limit ?? DEFAULT_LIMIT;
    if (limit <= 0 || req.repoIds.length === 0) return [];
    const tokens = tokenizeQuery(req.query);
    if (tokens.length === 0) return [];

    const pool = limit * CANDIDATE_FACTOR;
    const lexical = db.ftsSearch(req.repoIds, buildFtsQuery(tokens), pool);

    let semantic: SearchHit[] = [];
    if (embeddings && db.vectorDimension !== null) {
      try {
        const [vector] = await embeddings.embed([req.query]);
        if (vector && vector.length === db.vectorDimension) {
          semantic = db.vecSearch(req.repoIds, vector, pool);
        }
      } catch (err) {
        console.warn(`[retrieve] embedding the query failed, using lexical search only: ${(err as Error).message}`);
      }
    }

    const chunks = new Map<number, ChunkRow>();
    for (const hit of lexical) chunks.set(hit.chunk.id, hit.chunk);
    for (const hit of semantic) chunks.set(hit.chunk.id, hit.chunk);

    const fused = rrf([lexical.map((h) => h.chunk.id), semantic.map((h) => h.chunk.id)]);

    return [...fused.entries()]
      .flatMap(([id, score]) => {
        const chunk = chunks.get(id);
        if (!chunk) return [];
        if (req.excludePath && chunk.path === req.excludePath) return [];
        return [toRetrieved(chunk, score * pathWeight(chunk.path))];
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  };
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  scala: 'scala',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  html: 'html',
  css: 'css',
  scss: 'scss',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  vue: 'vue',
  ex: 'elixir',
  exs: 'elixir',
  dart: 'dart',
  lua: 'lua',
  r: 'r',
};

function languageFor(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return LANGUAGE_BY_EXTENSION[base.slice(dot + 1).toLowerCase()] ?? '';
}

function renderChunk(chunk: RetrievedChunk, content: string): string {
  const lang = languageFor(chunk.path);
  return `### ${chunk.repoId} ${chunk.path}:${chunk.startLine}-${chunk.endLine}\n\`\`\`${lang}\n${content}\n\`\`\``;
}

/**
 * Render retrieved chunks as Markdown for the model, stopping before the
 * character budget is exceeded. At least one chunk is always emitted; if it
 * alone overflows, its content is truncated.
 */
export function formatContext(chunks: RetrievedChunk[], budgetChars = 24000): string {
  const blocks: string[] = [];
  let used = 0;
  for (const chunk of chunks) {
    const separator = blocks.length > 0 ? 2 : 0;
    let block = renderChunk(chunk, chunk.content);
    if (used + separator + block.length > budgetChars) {
      if (blocks.length > 0) break;
      const overhead = renderChunk(chunk, '').length;
      block = renderChunk(chunk, chunk.content.slice(0, Math.max(0, budgetChars - overhead)));
    }
    blocks.push(block);
    used += separator + block.length;
  }
  return blocks.join('\n\n');
}

function summarize(content: string): string {
  const line = content.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.slice(0, SUMMARY_CHARS);
}

/** Map retrieved chunks onto the citation shape used by the API and UI. */
export function chunksToSources(chunks: RetrievedChunk[]): Source[] {
  return chunks.map((c) => ({
    repository: c.repoId,
    filepath: c.path,
    linestart: c.startLine,
    lineend: c.endLine,
    summary: summarize(c.content),
  }));
}
