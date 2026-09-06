import type { DiffFile, Hunk } from './diff.js';

export interface ChangeRisk {
  score: number;
  signals: string[];
}

export interface ReviewCandidate {
  file: DiffFile;
  risk: ChangeRisk;
  hunkRisks: ChangeRisk[];
}

const SIGNALS: Array<[string, RegExp, number]> = [
  // ponytail: lexical security routing is bounded; replace with syntax-aware analysis if false negatives become measurable.
  ['security', /\b(auth|authenticat\w*|authoriz\w*|permissions?|sessions?|token|secret|password|credential|crypto|encrypt|decrypt|sql|xss|csrf|eval|exec)\b/i, 4],
  ['control-flow', /\b(if|else|for|while|switch|case|return|throw|catch|finally|await|async|yield)\b|&&|\|\||\?\?/i, 2],
  ['contracts', /\b(export|public|private|protected|interface|type|schema|route|endpoint|api)\b/i, 3],
  ['dependencies', /(^|\s)(import|export)\b|\b(require|package|dependency|dependencies)\b/i, 2],
  ['data', /\b(insert|update|delete|select|query|migration|migrate|cache|transaction|filesystem|database)\b/i, 2],
];

function changedLines(hunk: Hunk): string[] {
  return hunk.lines.filter((line) => line.type === 'add' || line.type === 'del').map((line) => line.content);
}

function isProvablyNoOp(hunk: Hunk): boolean {
  const changed = changedLines(hunk);
  // Deletions stay reviewable: removing a comment can still expose behavior or
  // signal an accidental removal, and deletion-only files need coverage.
  return changed.length === 0;
}

export function assessChange(file: DiffFile): ChangeRisk {
  const text = `${file.newPath ?? file.oldPath ?? ''}\n${file.hunks.flatMap(changedLines).join('\n')}`;
  let score = 0;
  const signals: string[] = [];
  for (const [name, pattern, weight] of SIGNALS) {
    if (pattern.test(text)) {
      score += weight;
      signals.push(name);
    }
  }
  if (text.trim() && !signals.length) {
    score = 1;
    signals.push('execution');
  }
  return { score, signals };
}

/** Select reviewable hunks without dropping an unrecognized executable change. */
export function selectReviewCandidates(file: DiffFile): ReviewCandidate {
  const hunks = file.hunks.filter((hunk) => !isProvablyNoOp(hunk));
  const selected = { ...file, hunks };
  const hunkRisks = selected.hunks.map((hunk) => assessChange({ ...selected, hunks: [hunk] }));
  const ordered = selected.hunks.map((hunk, i) => ({ hunk, risk: hunkRisks[i]! }))
    .sort((a, b) => b.risk.score - a.risk.score);
  const orderedFile = { ...selected, hunks: ordered.map(({ hunk }) => hunk) };
  return { file: orderedFile, risk: assessChange(orderedFile), hunkRisks: ordered.map(({ risk }) => risk) };
}
