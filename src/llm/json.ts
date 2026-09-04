export class JsonExtractError extends Error {
  constructor(public readonly raw: string) {
    super('No JSON object found in model output');
    this.name = 'JsonExtractError';
  }
}

/**
 * Find the first balanced JSON object or array in free-form model output.
 * Tolerates markdown fences and surrounding prose.
 */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = fenced ? [fenced[1], text] : [text];
  for (const c of candidates) {
    const found = scanBalanced(c);
    if (found !== undefined) return found;
  }
  throw new JsonExtractError(text);
}

function scanBalanced(text: string): unknown {
  for (let i = 0; i < text.length; i++) {
    const open = text[i];
    if (open !== '{' && open !== '[') continue;
    const end = findClose(text, i);
    if (end < 0) continue;
    try {
      return JSON.parse(text.slice(i, end + 1));
    } catch {
      // keep scanning from the next opener
    }
  }
  return undefined;
}

function findClose(text: string, start: number): number {
  const stack: string[] = [];
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}
