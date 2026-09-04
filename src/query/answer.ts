import type { ChatMessage, LLMProvider, OnDelta } from '../llm/types.js';
import { completeStreaming } from '../llm/types.js';
import type { RetrieveFn } from '../search/types.js';
import { chunksToSources, formatContext, type Source } from '../search/retrieve.js';
import { identifiersFromCode, tokenizeQuery } from '../search/tokenize.js';
import { ANSWER_SYSTEM_PROMPT, ANSWER_MAX_TOKENS, buildAnswerUserMessage } from './prompts.js';

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
  /** Receives the answer incrementally when the provider can stream. */
  onDelta?: OnDelta;
  /** Called as soon as retrieval finishes, before the (slow) generation step. */
  onSources?: (sources: Source[]) => void;
}

export interface AnswerResult {
  message: string;
  sources: Source[];
  /** The query actually used for retrieval (expanded with context for follow-ups). */
  query: string;
}

/** How many extra terms a follow-up borrows from the turns before it. */
const CONTEXT_TERMS_FROM_QUESTION = 10;
const CONTEXT_TERMS_FROM_ANSWER = 15;

/** `src/db.ts:12-40` and friends, as cited in a previous answer. */
const CITATION_RE = /[\w./-]+\.[A-Za-z0-9]+:\d+(?:-\d+)?/g;

/**
 * Build the retrieval query for a follow-up without a round-trip to the model.
 *
 * The last user message is the question, but "and what about expiry?" retrieves
 * nothing on its own. We widen it with the strongest terms from the turns
 * before it: the file:line citations the previous answer made (those name the
 * exact code under discussion), then its code identifiers, then the words of
 * the previous question.
 */
export function buildFollowUpQuery(prior: ChatMessage[], question: string): string {
  const seen = new Set(tokenizeQuery(question));
  const extra: string[] = [];
  const add = (term: string, budget: () => boolean) => {
    const key = term.toLowerCase();
    if (!term || seen.has(key) || !budget()) return;
    seen.add(key);
    extra.push(term);
  };

  const lastAnswer = [...prior].reverse().find((m) => m.role === 'assistant')?.content ?? '';
  const lastQuestion = [...prior].reverse().find((m) => m.role === 'user')?.content ?? '';

  let fromAnswer = 0;
  const answerBudget = () => fromAnswer++ < CONTEXT_TERMS_FROM_ANSWER;
  // Citations first: `src/auth.ts:12-40` pins the discussion to real code.
  for (const citation of lastAnswer.match(CITATION_RE) ?? []) {
    add(citation.split(':')[0]!, answerBudget);
  }
  for (const id of identifiersFromCode(lastAnswer)) add(id, answerBudget);

  let fromQuestion = 0;
  const questionBudget = () => fromQuestion++ < CONTEXT_TERMS_FROM_QUESTION;
  for (const token of tokenizeQuery(lastQuestion)) add(token, questionBudget);

  return extra.length ? `${question} ${extra.join(' ')}` : question;
}

/** Retrieve context for the latest user message and answer it with citations. */
export async function answerQuestion(opts: AnswerOptions): Promise<AnswerResult> {
  const { llm, retrieve, repoIds, messages, limit, extraContext, onDelta, onSources } = opts;

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
  // Widening the query costs nothing; a rewrite round-trip costs a whole LLM call.
  const query = prior.length ? buildFollowUpQuery(prior, question) : question;

  const chunks = await retrieve({ repoIds, query, limit });
  let context = formatContext(chunks);
  const extra = extraContext?.trim();
  if (extra) context = `### Additional context\n\n${extra}\n\n${context}`;

  const sources = chunksToSources(chunks);
  onSources?.(sources);

  const request = {
    system: ANSWER_SYSTEM_PROMPT,
    messages: [...prior, { role: 'user' as const, content: buildAnswerUserMessage(question, context) }],
    maxTokens: ANSWER_MAX_TOKENS,
  };
  const message = onDelta
    ? await completeStreaming(llm, request, onDelta)
    : await llm.complete(request);

  return { message, sources, query };
}
