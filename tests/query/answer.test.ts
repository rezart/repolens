import { describe, it, expect } from 'vitest';
import type { ChatMessage, CompleteRequest, LLMProvider } from '../../src/llm/types.js';
import type { RetrieveFn, RetrieveRequest, RetrievedChunk } from '../../src/search/types.js';
import { answerQuestion } from '../../src/query/answer.js';
import { ANSWER_SYSTEM_PROMPT, REWRITE_SYSTEM_PROMPT, buildAnswerUserMessage } from '../../src/query/prompts.js';

const REPO = 'github:acme/app';

function fakeLlm(replies: string[]): LLMProvider & { calls: CompleteRequest[] } {
  const calls: CompleteRequest[] = [];
  return {
    name: 'fake',
    model: 'fake-1',
    concurrency: 1,
    calls,
    async complete(req: CompleteRequest) {
      calls.push(req);
      return replies[calls.length - 1] ?? '';
    },
  };
}

const CHUNK: RetrievedChunk = {
  chunkId: 1,
  repoId: REPO,
  path: 'src/auth.ts',
  startLine: 12,
  endLine: 40,
  content: 'export function verifyToken() {\n  return decodeJwt();\n}',
  score: 0.5,
};

function fakeRetrieve(chunks: RetrievedChunk[] = [CHUNK]): RetrieveFn & { calls: RetrieveRequest[] } {
  const calls: RetrieveRequest[] = [];
  const fn = async (req: RetrieveRequest) => {
    calls.push(req);
    return chunks;
  };
  return Object.assign(fn, { calls });
}

describe('buildAnswerUserMessage', () => {
  it('lays out the context above the question', () => {
    expect(buildAnswerUserMessage('why?', 'CTX')).toBe('# Code context\n\nCTX\n\n# Question\n\nwhy?');
  });
});

describe('answerQuestion', () => {
  it('answers a single-turn question without a rewrite call', async () => {
    const llm = fakeLlm(['Tokens are verified in `src/auth.ts:12-40`.']);
    const retrieve = fakeRetrieve();
    const messages: ChatMessage[] = [{ role: 'user', content: 'How does token verification work?' }];

    const res = await answerQuestion({ llm, retrieve, repoIds: [REPO], messages });

    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].system).toBe(ANSWER_SYSTEM_PROMPT);
    expect(res.query).toBe('How does token verification work?');
    expect(retrieve.calls[0]).toMatchObject({ repoIds: [REPO], query: 'How does token verification work?' });

    const userMessage = llm.calls[0].messages.at(-1)!;
    expect(userMessage.role).toBe('user');
    expect(userMessage.content).toContain('src/auth.ts:12-40');
    expect(userMessage.content).toContain('How does token verification work?');
    expect(userMessage.content).toContain('verifyToken');

    expect(res.message).toBe('Tokens are verified in `src/auth.ts:12-40`.');
    expect(res.sources).toEqual([
      { repository: REPO, filepath: 'src/auth.ts', linestart: 12, lineend: 40, summary: 'export function verifyToken() {' },
    ]);
  });

  it('rewrites a follow-up into a standalone retrieval query', async () => {
    const llm = fakeLlm(['token verification in the auth module', 'It decodes the JWT.']);
    const retrieve = fakeRetrieve();
    const messages: ChatMessage[] = [
      { role: 'system', content: 'ignored' },
      { role: 'user', content: 'How does token verification work?' },
      { role: 'assistant', content: 'It uses verifyToken.' },
      { role: 'user', content: 'And what about expiry?' },
    ];

    const res = await answerQuestion({ llm, retrieve, repoIds: [REPO], messages });

    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[0].system).toBe(REWRITE_SYSTEM_PROMPT);
    expect(llm.calls[0].messages.at(-1)!.content).toContain('And what about expiry?');
    // Prior turns are forwarded, system messages are dropped.
    expect(llm.calls[0].messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);

    expect(res.query).toBe('token verification in the auth module');
    expect(retrieve.calls[0].query).toBe('token verification in the auth module');

    expect(llm.calls[1].system).toBe(ANSWER_SYSTEM_PROMPT);
    expect(llm.calls[1].messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(llm.calls[1].messages.at(-1)!.content).toContain('And what about expiry?');
    expect(res.message).toBe('It decodes the JWT.');
  });

  it('falls back to the raw question when the rewrite is empty', async () => {
    const llm = fakeLlm(['   ', 'answer']);
    const retrieve = fakeRetrieve();
    const messages: ChatMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ];
    const res = await answerQuestion({ llm, retrieve, repoIds: [REPO], messages });
    expect(res.query).toBe('second');
    expect(retrieve.calls[0].query).toBe('second');
  });

  it('falls back to the raw question when the rewrite call throws', async () => {
    const calls: CompleteRequest[] = [];
    const llm: LLMProvider = {
      name: 'flaky',
      model: 'flaky-1',
      concurrency: 1,
      async complete(req) {
        calls.push(req);
        if (req.system === REWRITE_SYSTEM_PROMPT) throw new Error('boom');
        return 'answer';
      },
    };
    const retrieve = fakeRetrieve();
    const res = await answerQuestion({
      llm,
      retrieve,
      repoIds: [REPO],
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
    });
    expect(res.query).toBe('second');
    expect(res.message).toBe('answer');
    expect(calls).toHaveLength(2);
  });

  it('throws when there is no user message', async () => {
    const llm = fakeLlm(['x']);
    await expect(
      answerQuestion({ llm, retrieve: fakeRetrieve(), repoIds: [REPO], messages: [{ role: 'system', content: 'hi' }] }),
    ).rejects.toThrow(/user message/i);
  });

  it('includes extraContext in the answer prompt', async () => {
    const llm = fakeLlm(['ok']);
    const res = await answerQuestion({
      llm,
      retrieve: fakeRetrieve(),
      repoIds: [REPO],
      messages: [{ role: 'user', content: 'How does token verification work?' }],
      extraContext: 'Repo instructions: prefer functional style.',
    });
    const prompt = llm.calls[0].messages.at(-1)!.content;
    expect(prompt).toContain('### Additional context');
    expect(prompt).toContain('Repo instructions: prefer functional style.');
    expect(prompt.indexOf('### Additional context')).toBeLessThan(prompt.indexOf('src/auth.ts:12-40'));
    expect(res.message).toBe('ok');
  });

  it('passes the limit through to the retriever', async () => {
    const llm = fakeLlm(['ok']);
    const retrieve = fakeRetrieve();
    await answerQuestion({ llm, retrieve, repoIds: [REPO], messages: [{ role: 'user', content: 'verifyToken?' }], limit: 5 });
    expect(retrieve.calls[0].limit).toBe(5);
  });

  it('still answers when nothing is retrieved', async () => {
    const llm = fakeLlm(['I could not find that.']);
    const retrieve = fakeRetrieve([]);
    const res = await answerQuestion({ llm, retrieve, repoIds: [REPO], messages: [{ role: 'user', content: 'verifyToken?' }] });
    expect(res.sources).toEqual([]);
    expect(llm.calls[0].messages.at(-1)!.content).toContain('# Question');
  });
});
