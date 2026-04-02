import { describe, it, expect, vi } from 'vitest';
import { Tracer } from '../tracer.js';
import type { TraceSink, TraceRecord, SpanRecord } from '../types.js';

function createMockSink(): TraceSink & {
  savedTraces: TraceRecord[];
  savedSpans: SpanRecord[];
} {
  const savedTraces: TraceRecord[] = [];
  const savedSpans: SpanRecord[] = [];
  return {
    savedTraces,
    savedSpans,
    saveTrace: vi.fn(async (trace) => { savedTraces.push(trace); }),
    saveSpans: vi.fn(async (spans) => { savedSpans.push(...spans); }),
  };
}

describe('Tracer', () => {
  it('startRunTrace creates a root span and traceId', () => {
    const sink = createMockSink();
    const tracer = new Tracer(sink);
    const ctx = tracer.startRunTrace('run_abc');

    expect(ctx.traceId).toMatch(/^tr_/);
    expect(ctx.rootSpan).toBeDefined();
    expect(ctx.rootSpan.type).toBe('run_span');
  });

  it('startModelCall creates a child model span', () => {
    const sink = createMockSink();
    const tracer = new Tracer(sink);
    const ctx = tracer.startRunTrace('run_abc');

    const modelSpan = ctx.startModelCall('gpt-4');
    expect(modelSpan.type).toBe('model_call_span');
    expect(modelSpan.name).toBe('model:gpt-4');
    expect(modelSpan.parentSpanId).toBe(ctx.rootSpan.spanId);
    expect(modelSpan.traceId).toBe(ctx.traceId);
  });

  it('startToolCall creates a child tool span with metadata', () => {
    const sink = createMockSink();
    const tracer = new Tracer(sink);
    const ctx = tracer.startRunTrace('run_abc');

    const toolSpan = ctx.startToolCall('lookupOrder', 'tc_123');
    expect(toolSpan.type).toBe('tool_call_span');
    expect(toolSpan.name).toBe('tool:lookupOrder');

    const record = toolSpan.toRecord();
    expect(record.metadata.toolName).toBe('lookupOrder');
    expect(record.metadata.callId).toBe('tc_123');
  });

  it('finish persists trace and all spans via sink', async () => {
    const sink = createMockSink();
    const tracer = new Tracer(sink);
    const ctx = tracer.startRunTrace('run_abc');

    const modelSpan = ctx.startModelCall('gpt-4');
    modelSpan.addMetadata({ promptTokens: 100, completionTokens: 50 });
    modelSpan.end('ok');

    const toolSpan = ctx.startToolCall('search', 'tc_456');
    toolSpan.end('ok');

    await ctx.finish('ok');

    expect(sink.saveTrace).toHaveBeenCalledOnce();
    expect(sink.saveSpans).toHaveBeenCalledOnce();

    expect(sink.savedTraces).toHaveLength(1);
    const trace = sink.savedTraces[0];
    expect(trace).toBeDefined();
    expect(trace?.traceId).toBe(ctx.traceId);
    expect(trace?.runId).toBe('run_abc');
    expect(trace?.totalDurationMs).toBeTypeOf('number');

    // root + model + tool = 3 spans
    expect(sink.savedSpans).toHaveLength(3);
    const types = sink.savedSpans.map((s) => s.type);
    expect(types).toContain('run_span');
    expect(types).toContain('model_call_span');
    expect(types).toContain('tool_call_span');
  });

  it('finish with error captures error on root span', async () => {
    const sink = createMockSink();
    const tracer = new Tracer(sink);
    const ctx = tracer.startRunTrace('run_err');

    await ctx.finish('error', new Error('run failed'));

    const rootSpan = sink.savedSpans.find((s) => s.type === 'run_span');
    expect(rootSpan).toBeDefined();
    expect(rootSpan?.status).toBe('error');
    expect(rootSpan?.error?.message).toBe('run failed');
  });
});
