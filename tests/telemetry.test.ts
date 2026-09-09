import { describe, expect, it } from 'vitest';

describe('traceTask', () => {
  it('creates a consumer span for one background execution', async () => {
    const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = await import('@opentelemetry/sdk-trace-base');
    const { SpanKind, trace } = await import('@opentelemetry/api');
    const { traceTask } = await import('../src/telemetry.js');
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    trace.setGlobalTracerProvider(provider);

    await expect(traceTask('repolens.review', async () => 'done')).resolves.toBe('done');

    expect(exporter.getFinishedSpans()).toEqual([expect.objectContaining({ name: 'repolens.review', kind: SpanKind.CONSUMER })]);
  });
});
