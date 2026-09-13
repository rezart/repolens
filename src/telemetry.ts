import { metrics, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorage } from 'node:async_hooks';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { reviewCallCost } from './usage/review-cost.js';
import type { UsageRecord, UsageRole } from './usage/types.js';

const METRIC_SCOPE = 'repolens';
const aiUsage = new AsyncLocalStorage<{ span: ReturnType<typeof trace.getActiveSpan>; input: number; cacheRead: number; cacheWrite: number; output: number }>();

export interface TraceAiOptions {
  provider?: string;
  stage?: string;
}

export function startTelemetry(url: string, token: string): void {
  if (!url || !token) return;
  const base = `${url.replace(/\/+$/, '')}/api/otel`;
  const headers = { Authorization: `Bearer ${token}` };
  const sdk = new NodeSDK({
    serviceName: 'repolens',
    logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: `${base}/v1/logs`, headers }) })],
    traceExporter: new OTLPTraceExporter({ url: `${base}/v1/traces`, headers }),
    metricReaders: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics`, headers }) })],
  });
  sdk.start();
  process.once('SIGTERM', () => void sdk.shutdown());
}

export function withTelemetryLogging(output: (message: string) => void): (message: string) => void {
  return (message) => {
    output(message);
    try {
      logs.getLogger('repolens').emit({ body: message, severityNumber: SeverityNumber.INFO, severityText: 'INFO' });
    } catch {
      // Telemetry must never interrupt application logging or job execution.
    }
  };
}

export async function traceTask<T>(name: string, run: () => Promise<T>): Promise<T> {
  return trace.getTracer('repolens').startActiveSpan(name, { kind: SpanKind.CONSUMER }, async (span) => {
    try {
      const result = await run();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}

export async function traceAi<T>(model: string, run: () => Promise<T>, options: TraceAiOptions = {}): Promise<T> {
  const store = reviewCallCost.getStore();
  const provider = options.provider ?? 'openrouter';
  const stage = options.stage ?? (store?.stage ? `review.${store.stage}` : 'chat-completion');
  return trace.getTracer('repolens').startActiveSpan(stage, { kind: SpanKind.CLIENT }, async (span) => {
    span.setAttributes({ 'gen_ai.system': provider, 'gen_ai.request.model': model, 'gen_ai.operation.name': 'chat' });
    return aiUsage.run({ span, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, async () => {
      try {
        return await run();
      } catch (error) {
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
        throw error;
      } finally {
        span.end();
      }
    });
  });
}

function validCount(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/** Records usage metrics without ever affecting durable usage accounting. */
export function recordUsageTelemetry(role: UsageRole, record: UsageRecord): void {
  try {
    const store = reviewCallCost.getStore();
    const stage = role === 'review' ? store?.stage ?? 'unknown' : role;
    const pass = role === 'review' ? store?.pass ?? 'normal' : 'normal';
    const attributes = { role, provider: record.provider, model: record.model, stage, pass };
    const meter = metrics.getMeter(METRIC_SCOPE);
    meter.createCounter('repolens.llm.usage_records').add(1, attributes);
    const tokenCounts: Array<[string, number]> = [
      ['input', record.inputTokens],
      ['cache_read', record.cachedInputTokens],
      ['cache_write', record.cacheWriteTokens],
      ['output', record.outputTokens],
    ];
    const tokens = meter.createCounter('repolens.llm.tokens');
    for (const [tokenType, value] of tokenCounts) {
      if (validCount(value)) tokens.add(value, { ...attributes, token_type: tokenType });
    }
    if (validCount(record.costUsd ?? NaN)) {
      meter.createCounter('repolens.llm.reported_cost_usd').add(record.costUsd!, attributes);
    } else {
      meter.createCounter('repolens.llm.unpriced_records').add(1, attributes);
    }
    const state = aiUsage.getStore();
    const span = state?.span;
    if (role !== 'embed' && state && span) {
      if (validCount(record.inputTokens)) state.input += record.inputTokens;
      if (validCount(record.cachedInputTokens)) state.cacheRead += record.cachedInputTokens;
      if (validCount(record.cacheWriteTokens)) state.cacheWrite += record.cacheWriteTokens;
      if (validCount(record.outputTokens)) state.output += record.outputTokens;
      span.setAttributes({
        'gen_ai.usage.input_tokens': state.input + state.cacheRead + state.cacheWrite,
        'gen_ai.usage.output_tokens': state.output,
        'gen_ai.usage.cache_read_input_tokens': state.cacheRead,
        'gen_ai.usage.cache_write_input_tokens': state.cacheWrite,
      });
    }
  } catch {
    // Telemetry must never break usage storage or the provider call.
  }
}
