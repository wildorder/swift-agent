import { describe, it, expect } from 'vitest';
import {
  boundSpanRecord,
  MAX_SPAN_ERROR_MESSAGE_CHARS,
  MAX_SPAN_METADATA_BYTES,
} from '../bounds.js';
import { Span } from '../span.js';
import type { SpanRecord } from '../types.js';

function makeRecord(overrides: Partial<SpanRecord> = {}): SpanRecord {
  return {
    spanId: 'sp_001',
    parentSpanId: null,
    traceId: 'tr_001',
    type: 'model_call_span',
    name: 'model:gpt-4',
    startedAt: new Date('2025-01-01T00:00:00Z'),
    completedAt: new Date('2025-01-01T00:00:01Z'),
    durationMs: 1000,
    metadata: {},
    status: 'ok',
    ...overrides,
  };
}

describe('boundSpanRecord', () => {
  it('truncates an over-long error message and preserves the code', () => {
    const longMessage = 'x'.repeat(MAX_SPAN_ERROR_MESSAGE_CHARS + 500);
    const record = makeRecord({ error: { message: longMessage, code: 'TIMEOUT' } });

    const bounded = boundSpanRecord(record);

    expect(bounded.error?.message).toHaveLength(MAX_SPAN_ERROR_MESSAGE_CHARS + '…[truncated]'.length);
    expect(bounded.error?.message.endsWith('…[truncated]')).toBe(true);
    expect(bounded.error?.message.startsWith('x'.repeat(MAX_SPAN_ERROR_MESSAGE_CHARS))).toBe(true);
    expect(bounded.error?.code).toBe('TIMEOUT');
  });

  it('leaves a short error message unchanged', () => {
    const record = makeRecord({ error: { message: 'boom', code: 'E1' } });
    const bounded = boundSpanRecord(record);
    expect(bounded.error).toEqual({ message: 'boom', code: 'E1' });
  });

  it('truncates metadata that exceeds the byte budget and marks __truncated', () => {
    const huge = 'y'.repeat(MAX_SPAN_METADATA_BYTES + 1000);
    const record = makeRecord({ metadata: { small: 'ok', huge } });

    const bounded = boundSpanRecord(record);

    expect(bounded.metadata.small).toBe('ok');
    expect(bounded.metadata.huge).toBe('[truncated]');
    expect(bounded.metadata.__truncated).toBe(true);
  });

  it('returns small metadata unchanged with no __truncated marker', () => {
    const record = makeRecord({ metadata: { a: 1, b: 'two' } });
    const bounded = boundSpanRecord(record);
    expect(bounded.metadata).toEqual({ a: 1, b: 'two' });
    expect(bounded.metadata.__truncated).toBeUndefined();
  });

  it('preserves whitelisted keys even when junk keys are truncated', () => {
    const huge = 'z'.repeat(MAX_SPAN_METADATA_BYTES + 1000);
    const record = makeRecord({
      metadata: {
        junk: huge,
        promptTokens: 100,
        completionTokens: 50,
        modelName: 'gpt-4',
      },
    });

    const bounded = boundSpanRecord(record);

    expect(bounded.metadata.promptTokens).toBe(100);
    expect(bounded.metadata.completionTokens).toBe(50);
    expect(bounded.metadata.modelName).toBe('gpt-4');
    expect(bounded.metadata.junk).toBe('[truncated]');
    expect(bounded.metadata.__truncated).toBe(true);
  });

  it('does not mutate the input record, metadata, or error', () => {
    const huge = 'q'.repeat(MAX_SPAN_METADATA_BYTES + 1000);
    const metadata = { junk: huge, promptTokens: 100 };
    const error = { message: 'x'.repeat(MAX_SPAN_ERROR_MESSAGE_CHARS + 100), code: 'E' };
    const record = makeRecord({ metadata: { ...metadata }, error: { ...error } });

    boundSpanRecord(record);

    expect(record.metadata).toEqual(metadata);
    expect(record.metadata.junk).toBe(huge);
    expect(record.error).toEqual(error);
  });

  it('Span.toRecord() emits a bounded record (helper is wired into the span path)', () => {
    const span = new Span('sp_x', 'tr_x', null, 'model_call_span', 'model:gpt-4');
    span.start();
    span.addMetadata({ promptTokens: 100, junk: 'w'.repeat(MAX_SPAN_METADATA_BYTES + 1000) });
    span.end('ok');

    const record = span.toRecord();

    expect(record.metadata.promptTokens).toBe(100);
    expect(record.metadata.junk).toBe('[truncated]');
    expect(record.metadata.__truncated).toBe(true);
  });
});
