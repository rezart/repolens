import type { ChatMessage, LLMProvider } from '../llm/types.js';
import type { RetrieveFn } from '../search/types.js';
import { chunksToSources, formatContext, type Source } from '../search/retrieve.js';
import { ANSWER_SYSTEM_PROMPT, REWRITE_SYSTEM_PROMPT, buildAnswerUserMessage } from './prompts.js';

export type { Source };

export interface AnswerOptions {
  llm: LLMProvider;
  retrieve: RetrieveFn;
  repoIds: string[];
  /** Full conversation; the last user message is the question. */
  messages: ChatMessage[];
  limit?: number;
  /** Prepended to the code context, e.g. repository-specific instructions. */
  extraContext?: string;
}

export interface AnswerResult {
  message: string;
  sources: Source[];
  /** The query actually used for retrieval (rewritten for follow-ups). */
  query: string;
}

const REWRITE_MAX_TOKENS = 200;
const ANSWER_MAX_TOKENS = 2000;

/** Rewrite a follow-up into a standalone query; returns null to keep the original. */
async function rewriteQuery(llm: LLMProvider, prior: ChatMessage[], question: string): Promise<string | null> {
  try {
    const raw = await llm.complete({
      system: REWRITE_SYSTEM_PROMPT,
      messages: [...prior, { role: 'user', content: `Latest message: ${question}\n\nStandalone query:` }],
      maxTokens: REWRITE_MAX_TOKENS,
    });
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (err) {
    console.warn(`[answer] query rewrite failed, using the raw question: ${(err as Error).message}`);
    return null;
  }
}

/** Retrieve context for the latest user message and answer it with citations. */
export async function answerQuestion(opts: AnswerOptions): Promise<AnswerResult> {
  const { llm, retrieve, repoIds, messages, limit, extraContext } = opts;

  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUser = i;
      break;
    }
  }
  if (lastUser === -1) throw new Error('answerQuestion: no user message in the conversation');

  const question = messages[lastUser].content;
  const prior = messages.slice(0, lastUser).filter((m) => m.role !== 'system');
  const isFollowUp = messages.filter((m) => m.role !== 'system').length >= 2;

  const query = (isFollowUp ? await rewriteQuery(llm, prior, question) : null) ?? question;

  const chunks = await retrieve({ repoIds, query, limit });
  let context = formatContext(chunks);
  const extra = extraContext?.trim();
  if (extra) context = `### Additional context\n\n${extra}\n\n${context}`;

  const message = await llm.complete({
    system: ANSWER_SYSTEM_PROMPT,
    messages: [...prior, { role: 'user', content: buildAnswerUserMessage(question, context) }],
    maxTokens: ANSWER_MAX_TOKENS,
  });

  return { message, sources: chunksToSources(chunks), query };
}
