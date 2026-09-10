import { afterAll, describe, expect, it } from 'vitest';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { context, trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { withTelemetryLogging } from '../src/telemetry.js';

const exporter = new InMemoryLogRecordExporter();
const provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter })] });
// Register the same async context support used by the server, without network exporters.
const sdk = new NodeSDK({ spanProcessors: [], logRecordProcessors: [], metricReaders: [] });
sdk.start();
logs.disable();
logs.setGlobalLoggerProvider(provider);

describe('server logging', () => {
  it('preserves console output and exports a log with the active trace context', async () => {
    const output: string[] = [];
    const log = withTelemetryLogging((message) => output.push(message));
    const spanContext = { traceId: '12345678901234567890123456789012', spanId: '1234567890123456', traceFlags: 1 };
    await context.with(trace.setSpanContext(context.active(), spanContext), async () => {
      await Promise.resolve();
      log('review completed');
    });
    await provider.forceFlush();
    expect(output).toEqual(['review completed']);
    expect(exporter.getFinishedLogRecords()).toEqual([expect.objectContaining({
      body: 'review completed', severityNumber: SeverityNumber.INFO, severityText: 'INFO', spanContext,
    })]);
  });

  it('keeps local logging available when telemetry is disabled', () => {
    logs.disable();
    const output: string[] = [];
    withTelemetryLogging((message) => output.push(message))('local only');
    expect(output).toEqual(['local only']);
  });
});

afterAll(async () => {
  logs.disable();
  await provider.shutdown();
  await sdk.shutdown();
});
