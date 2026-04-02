import { describe, it, expect, vi } from 'vitest';
import { Span } from '../span.js';

describe('Span', () => {
  it('creates a span with correct properties', () => {
    const span = new Span('sp_001', 'tr_001', null, 'run_span', 'test-run');
    const record = span.toRecord();
    expect(record.spanId).toBe('sp_001');
    expect(record.traceId).toBe('tr_001');
    expect(record.parentSpanId).toBeNull();
    expect(record.type).toBe('run_span');
    expect(record.name).toBe('test-run');
    expect(record.status).toBe('ok');
  });

  it('start() sets startedAt', () => {
    const span = new Span('sp_001', 'tr_001', null, 'run_span', 'run');
    span.start();
    const record = span.toRecord();
    expect(record.startedAt).toBeInstanceOf(Date);
  });

  it('end() computes durationMs correctly', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    const span = new Span('sp_001', 'tr_001', null, 'run_span', 'run');
    span.start();

    vi.advanceTimersByTime(150);
    span.end('ok');

    const record = span.toRecord();
    expect(record.durationMs).toBe(150);
    expect(record.completedAt).toBeInstanceOf(Date);
    expect(record.status).toBe('ok');

    vi.useRealTimers();
  });

  it('end() with error captures error details', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    const span = new Span('sp_001', 'tr_001', null, 'run_span', 'run');
    span.start();

    vi.advanceTimersByTime(50);
    const err = new Error('something broke');
    (err as Error & { code: string }).code = 'TIMEOUT';
    span.end('error', err);

    const record = span.toRecord();
    expect(record.status).toBe('error');
    expect(record.error).toEqual({ message: 'something broke', code: 'TIMEOUT' });

    vi.useRealTimers();
  });

  it('addMetadata merges metadata', () => {
    const span = new Span('sp_001', 'tr_001', null, 'model_call_span', 'model:gpt-4');
    span.addMetadata({ modelName: 'gpt-4', promptTokens: 100 });
    span.addMetadata({ completionTokens: 50 });

    const record = span.toRecord();
    expect(record.metadata).toEqual({
      modelName: 'gpt-4',
      promptTokens: 100,
      completionTokens: 50,
    });
  });

  it('startChild creates a child span with correct parent and traceId', () => {
    const parent = new Span('sp_parent', 'tr_001', null, 'run_span', 'run');
    parent.start();

    const child = parent.startChild('model_call_span', 'model:claude');
    const childRecord = child.toRecord();

    expect(childRecord.parentSpanId).toBe('sp_parent');
    expect(childRecord.traceId).toBe('tr_001');
    expect(childRecord.type).toBe('model_call_span');
    expect(childRecord.name).toBe('model:claude');
    expect(childRecord.startedAt).toBeInstanceOf(Date);
    expect(childRecord.spanId).toMatch(/^sp_/);
  });

  it('toRecord returns a clean copy of metadata', () => {
    const span = new Span('sp_001', 'tr_001', null, 'run_span', 'run');
    span.addMetadata({ key: 'value' });
    const record1 = span.toRecord();
    record1.metadata.key = 'mutated';
    const record2 = span.toRecord();
    expect(record2.metadata.key).toBe('value');
  });
});
