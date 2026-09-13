import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let spanExporter: import('@opentelemetry/sdk-trace-base').InMemorySpanExporter;
let spanProvider: import('@opentelemetry/sdk-trace-base').BasicTracerProvider;

beforeAll(async () => {
  const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = await import('@opentelemetry/sdk-trace-base');
  const { trace } = await import('@opentelemetry/api');
  spanExporter = new InMemorySpanExporter();
  spanProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] });
  trace.setGlobalTracerProvider(spanProvider);
});

describe('traceTask', () => {
  it('creates a consumer span for one background execution', async () => {
    const { SpanKind, trace } = await import('@opentelemetry/api');
    const { traceTask } = await import('../src/telemetry.js');

    await expect(traceTask('repolens.review', async () => 'done')).resolves.toBe('done');

    expect(spanExporter.getFinishedSpans()).toEqual([expect.objectContaining({ name: 'repolens.review', kind: SpanKind.CONSUMER })]);
  });
});

describe('AI span usage', () => {
  it('marks an incomplete paid review response as a failed AI span', async () => {
    const { OpenRouterProvider } = await import('../src/llm/openrouter.js');
    const { SpanStatusCode } = await import('@opentelemetry/api');
    const llm = new OpenRouterProvider({
      apiKey: 'test', model: 'incomplete-test',
      fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'length' }] })),
    });
    await expect(llm.complete({ messages: [{ role: 'user', content: 'review' }], reviewBudget: true, reviewStage: 'initial', maxTokens: 1 })).rejects.toThrow('did not finish');
    const span = spanExporter.getFinishedSpans().find((s) => s.attributes['gen_ai.request.model'] === 'incomplete-test');
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('attaches only to its own AI span and aggregates multiple records', async () => {
    const { traceAi, traceTask } = await import('../src/telemetry.js');
    const { UsageTracker } = await import('../src/usage/tracker.js');
    const { openDb } = await import('../src/db.js');
    const { reviewCallCost } = await import('../src/usage/review-cost.js');
    const db = openDb(':memory:');
    const tracker = new UsageTracker({ db, pricing: null });
    await reviewCallCost.run({ reported: false, costUsd: null, stage: 'initial', pass: 'focused' }, () =>
      traceAi('model', async () => {
        tracker.sinkFor('review')({ provider: 'claude-cli', model: 'a', inputTokens: 10, cachedInputTokens: 2, cacheWriteTokens: 3, outputTokens: 4, costUsd: 0 });
        tracker.sinkFor('review')({ provider: 'claude-cli', model: 'b', inputTokens: 20, cachedInputTokens: 5, cacheWriteTokens: 7, outputTokens: 6, costUsd: 0 });
        await tracker.sinkFor('embed')({ provider: 'embeddings', model: 'e', inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: 0 });
      }, { provider: 'claude-cli' }),
    );
    await traceTask('parent', async () => tracker.sinkFor('embed')({ provider: 'embeddings', model: 'e', inputTokens: 9, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: 0 }));
    const span = spanExporter.getFinishedSpans().find((item) => item.name === 'review.initial');
    expect(span?.attributes).toMatchObject({
      'gen_ai.usage.input_tokens': 47,
      'gen_ai.usage.output_tokens': 10,
      'gen_ai.usage.cache_read_input_tokens': 7,
      'gen_ai.usage.cache_write_input_tokens': 10,
    });
    expect(span?.attributes).not.toHaveProperty('role', 'embed');
    const parent = spanExporter.getFinishedSpans().find((item) => item.name === 'parent');
    expect(parent?.attributes).not.toHaveProperty('gen_ai.usage.input_tokens');
    db.close();
  });
});

describe('usage telemetry', () => {
  it('records bounded usage metrics and keeps invalid costs unpriced', async () => {
    const { AggregationTemporality, InMemoryMetricExporter, PeriodicExportingMetricReader, MeterProvider } = await import('@opentelemetry/sdk-metrics');
    const { metrics } = await import('@opentelemetry/api');
    const { openDb } = await import('../src/db.js');
    const { UsageTracker } = await import('../src/usage/tracker.js');
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter });
    metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
    const db = openDb(':memory:');
    const tracker = new UsageTracker({ db, pricing: null });

    tracker.sinkFor('chat')({
      provider: 'openrouter', model: 'chat-test', inputTokens: 3, cachedInputTokens: 2,
      cacheWriteTokens: 1, outputTokens: 4, costUsd: null,
    });
    tracker.sinkFor('chat')({
      provider: 'openrouter', model: 'chat-test', inputTokens: -1, cachedInputTokens: Number.NaN,
      cacheWriteTokens: 0, outputTokens: 0, costUsd: -1,
    });
    tracker.sinkFor('chat')({
      provider: 'openrouter', model: 'chat-test', inputTokens: 0, cachedInputTokens: 0,
      cacheWriteTokens: 0, outputTokens: 0, costUsd: 0,
    });
    await reader.forceFlush();
    const data = exporter.getMetrics().flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics));
    const point = (name: string) => data.find((metric) => metric.descriptor.name === name)!.dataPoints.find((item) => item.attributes.model === 'chat-test')!;
    expect(point('repolens.llm.usage_records').value).toBe(3);
    expect(point('repolens.llm.unpriced_records').value).toBe(2);
    expect(point('repolens.llm.reported_cost_usd').value).toBe(0);
    expect(data.find((metric) => metric.descriptor.name === 'repolens.llm.tokens')!.dataPoints).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 3, attributes: expect.objectContaining({ token_type: 'input', stage: 'chat', pass: 'normal' }) }),
      expect.objectContaining({ value: 2, attributes: expect.objectContaining({ token_type: 'cache_read' }) }),
      expect.objectContaining({ value: 1, attributes: expect.objectContaining({ token_type: 'cache_write' }) }),
      expect.objectContaining({ value: 4, attributes: expect.objectContaining({ token_type: 'output' }) }),
    ]));
    db.insertUsage = () => { throw new Error('disk full'); };
    expect(() => tracker.sinkFor('chat')({ provider: 'openrouter', model: 'chat-test', inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1, costUsd: null })).not.toThrow();
    db.close();
    await reader.shutdown();
  });
});

afterAll(async () => {
  const { metrics, trace } = await import('@opentelemetry/api');
  metrics.disable();
  trace.disable();
  await spanProvider.shutdown();
});
