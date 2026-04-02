import { describe, it, expect } from 'vitest';
import { deriveRunMetrics } from '../metrics.js';
import type { SpanRecord } from '../types.js';

function makeSpan(overrides: Partial<SpanRecord> & Pick<SpanRecord, 'spanId' | 'type' | 'name'>): SpanRecord {
  return {
    traceId: 'tr_test',
    parentSpanId: null,
    startedAt: new Date('2025-01-01T00:00:00Z'),
    completedAt: null,
    durationMs: null,
    metadata: {},
    status: 'ok',
    ...overrides,
  };
}

describe('deriveRunMetrics', () => {
  it('computes total run duration from run_span', () => {
    const spans: SpanRecord[] = [
      makeSpan({ spanId: 'sp_root', type: 'run_span', name: 'run', durationMs: 500 }),
    ];
    const metrics = deriveRunMetrics(spans);
    expect(metrics.totalRunDurationMs).toBe(500);
  });

  it('computes time-to-first-token from run start to first model span end', () => {
    const runStart = new Date('2025-01-01T00:00:00.000Z');
    const modelEnd = new Date('2025-01-01T00:00:00.200Z');

    const spans: SpanRecord[] = [
      makeSpan({
        spanId: 'sp_root',
        type: 'run_span',
        name: 'run',
        startedAt: runStart,
        durationMs: 1000,
      }),
      makeSpan({
        spanId: 'sp_model1',
        type: 'model_call_span',
        name: 'model:gpt-4',
        parentSpanId: 'sp_root',
        startedAt: new Date('2025-01-01T00:00:00.050Z'),
        completedAt: modelEnd,
        durationMs: 150,
      }),
    ];

    const metrics = deriveRunMetrics(spans);
    expect(metrics.timeToFirstTokenMs).toBe(200);
  });

  it('counts model and tool calls', () => {
    const spans: SpanRecord[] = [
      makeSpan({ spanId: 'sp_root', type: 'run_span', name: 'run' }),
      makeSpan({ spanId: 'sp_m1', type: 'model_call_span', name: 'model:gpt-4', durationMs: 100 }),
      makeSpan({ spanId: 'sp_m2', type: 'model_call_span', name: 'model:gpt-4', durationMs: 200 }),
      makeSpan({ spanId: 'sp_t1', type: 'tool_call_span', name: 'tool:search', durationMs: 50 }),
    ];

    const metrics = deriveRunMetrics(spans);
    expect(metrics.modelCallCount).toBe(2);
    expect(metrics.toolCallCount).toBe(1);
    expect(metrics.totalModelLatencyMs).toBe(300);
    expect(metrics.totalToolLatencyMs).toBe(50);
  });

  it('aggregates token usage from metadata', () => {
    const spans: SpanRecord[] = [
      makeSpan({ spanId: 'sp_root', type: 'run_span', name: 'run' }),
      makeSpan({
        spanId: 'sp_m1',
        type: 'model_call_span',
        name: 'model:gpt-4',
        metadata: { promptTokens: 100, completionTokens: 50 },
      }),
      makeSpan({
        spanId: 'sp_m2',
        type: 'model_call_span',
        name: 'model:gpt-4',
        metadata: { promptTokens: 200, completionTokens: 100 },
      }),
    ];

    const metrics = deriveRunMetrics(spans);
    expect(metrics.totalTokens).toBe(450);
  });

  it('handles empty span list', () => {
    const metrics = deriveRunMetrics([]);
    expect(metrics.totalRunDurationMs).toBeNull();
    expect(metrics.timeToFirstTokenMs).toBeNull();
    expect(metrics.modelCallCount).toBe(0);
    expect(metrics.toolCallCount).toBe(0);
    expect(metrics.totalTokens).toBe(0);
  });
});
