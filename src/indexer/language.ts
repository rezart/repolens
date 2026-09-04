/** Language detection and index-worthiness rules for repository files. */

export const MAX_FILE_BYTES = 512 * 1024;

const EXT_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  rb: 'ruby',
  php: 'php',
  cs: 'csharp',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  swift: 'swift',
  scala: 'scala',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  sql: 'sql',
  md: 'markdown',
  mdx: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  json: 'json',
  toml: 'toml',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'css',
  vue: 'vue',
  svelte: 'svelte',
  tf: 'terraform',
  tfvars: 'terraform',
  proto: 'protobuf',
  graphql: 'graphql',
  gql: 'graphql',
  dart: 'dart',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hs: 'haskell',
  lua: 'lua',
  r: 'r',
  m: 'objective-c',
  pl: 'perl',
  txt: 'text',
};

const BASENAME_LANGUAGE: Record<string, string> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
};

/** Directory names that are never worth indexing. */
const SKIP_DIRS = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  '.git',
  'target',
  '__pycache__',
  '.next',
  '.venv',
  'venv',
  'coverage',
  '.idea',
  '.vscode',
]);

const SKIP_BASENAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Cargo.lock',
  'go.sum',
  'poetry.lock',
  'Pipfile.lock',
  'composer.lock',
  'Gemfile.lock',
]);

/** Binary-ish / generated extensions that carry no useful source text. */
const BINARY_EXTS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'ico',
  'webp',
  'woff',
  'woff2',
  'ttf',
  'eot',
  'zip',
  'gz',
  'tar',
  'tgz',
  'jar',
  'class',
  'pyc',
  'so',
  'dylib',
  'dll',
  'exe',
  'pdf',
  'mp4',
  'mp3',
  'wasm',
  'lock',
]);

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

function extension(path: string): string {
  const base = basename(path);
  const i = base.lastIndexOf('.');
  if (i <= 0) return '';
  return base.slice(i + 1).toLowerCase();
}

/** Language id for a repository-relative path, or null when unrecognised. */
export function detectLanguage(path: string): string | null {
  const base = basename(path);
  const lower = base.toLowerCase();
  const byName = BASENAME_LANGUAGE[lower];
  if (byName) return byName;
  // Dockerfile.prod, Dockerfile.dev, ...
  if (lower.startsWith('dockerfile.')) return 'dockerfile';
  if (lower.startsWith('makefile.')) return 'makefile';
  const ext = extension(path);
  if (!ext) return null;
  return EXT_LANGUAGE[ext] ?? null;
}

/** Whether a file is worth chunking and embedding. */
export function shouldIndex(path: string, size: number): boolean {
  if (size > MAX_FILE_BYTES) return false;
  const segments = path.split('/');
  for (const seg of segments.slice(0, -1)) {
    if (SKIP_DIRS.has(seg)) return false;
  }
  const base = basename(path);
  if (SKIP_DIRS.has(base)) return false;
  if (SKIP_BASENAMES.has(base)) return false;
  const lower = base.toLowerCase();
  if (lower.endsWith('.min.js') || lower.endsWith('.min.css') || lower.endsWith('.map')) return false;
  if (BINARY_EXTS.has(extension(path))) return false;
  return detectLanguage(path) !== null;
}
