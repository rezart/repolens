import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';

export function startTelemetry(url: string, token: string): void {
  if (!url || !token) return;
  const base = `${url.replace(/\/+$/, '')}/api/otel`;
  const headers = { Authorization: `Bearer ${token}` };
  const sdk = new NodeSDK({
    serviceName: 'repolens',
    traceExporter: new OTLPTraceExporter({ url: `${base}/v1/traces`, headers }),
    metricReaders: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics`, headers }) })],
  });
  sdk.start();
  process.once('SIGTERM', () => void sdk.shutdown());
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

export async function traceAi<T>(model: string, run: () => Promise<T>): Promise<T> {
  return trace.getTracer('repolens').startActiveSpan('chat-completion', { kind: SpanKind.CLIENT }, async (span) => {
    span.setAttributes({ 'gen_ai.system': 'openrouter', 'gen_ai.request.model': model, 'gen_ai.operation.name': 'chat' });
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
}
