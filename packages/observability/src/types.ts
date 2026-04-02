/** Branded type aliases for trace and span identifiers. */
export type TraceId = string & { readonly __brand: 'TraceId' };
export type SpanId = string & { readonly __brand: 'SpanId' };

export type SpanType = 'run_span' | 'model_call_span' | 'tool_call_span';

export type SpanStatus = 'ok' | 'error';

export interface SpanError {
  message: string;
  code?: string;
}

export interface SpanRecord {
  spanId: string;
  parentSpanId: string | null;
  traceId: string;
  type: SpanType;
  name: string;
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
  metadata: Record<string, unknown>;
  status: SpanStatus;
  error?: SpanError;
}

export interface TraceRecord {
  traceId: string;
  runId: string;
  rootSpanId: string;
  startedAt: Date;
  completedAt: Date | null;
  totalDurationMs: number | null;
}

/**
 * Sink interface for persisting trace data.
 * Implemented by TraceRepository in @swiftagent/db.
 */
export interface TraceSink {
  saveTrace(trace: TraceRecord): Promise<void>;
  saveSpans(spans: SpanRecord[]): Promise<void>;
}
