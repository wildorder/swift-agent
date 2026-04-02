import { eq, asc } from 'drizzle-orm';
import type { Db } from '../client.js';
import { traces, traceSpans } from '../schema/index.js';

export interface TraceRecordRow {
  traceId: string;
  runId: string;
  rootSpanId: string;
  startedAt: Date;
  completedAt: Date | null;
  totalDurationMs: number | null;
}

export interface SpanRecordRow {
  spanId: string;
  parentSpanId: string | null;
  traceId: string;
  type: string;
  name: string;
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
  metadata: Record<string, unknown>;
  status: string;
  error?: { message: string; code?: string } | null;
}

export function createTraceRepo(db: Db) {
  return {
    async saveTrace(trace: TraceRecordRow): Promise<void> {
      await db.insert(traces).values({
        traceId: trace.traceId,
        runId: trace.runId,
        rootSpanId: trace.rootSpanId,
        startedAt: trace.startedAt,
        completedAt: trace.completedAt,
        totalDurationMs: trace.totalDurationMs,
      });
    },

    async saveSpans(spans: SpanRecordRow[]): Promise<void> {
      if (spans.length === 0) return;
      await db.insert(traceSpans).values(
        spans.map((s) => ({
          spanId: s.spanId,
          traceId: s.traceId,
          parentSpanId: s.parentSpanId,
          type: s.type as 'run_span' | 'model_call_span' | 'tool_call_span',
          name: s.name,
          startedAt: s.startedAt,
          completedAt: s.completedAt,
          durationMs: s.durationMs,
          metadata: s.metadata,
          status: s.status as 'ok' | 'error',
          error: s.error ?? null,
        })),
      );
    },

    async getTraceByRunId(runId: string): Promise<TraceRecordRow | null> {
      const [row] = await db.select().from(traces).where(eq(traces.runId, runId));
      return row ? toTraceRecord(row) : null;
    },

    async listSpansByTraceId(traceId: string): Promise<SpanRecordRow[]> {
      const rows = await db
        .select()
        .from(traceSpans)
        .where(eq(traceSpans.traceId, traceId))
        .orderBy(asc(traceSpans.startedAt));
      return rows.map(toSpanRecord);
    },
  };
}

function toTraceRecord(row: typeof traces.$inferSelect): TraceRecordRow {
  return {
    traceId: row.traceId,
    runId: row.runId,
    rootSpanId: row.rootSpanId,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    totalDurationMs: row.totalDurationMs,
  };
}

function toSpanRecord(row: typeof traceSpans.$inferSelect): SpanRecordRow {
  return {
    spanId: row.spanId,
    parentSpanId: row.parentSpanId,
    traceId: row.traceId,
    type: row.type,
    name: row.name,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    durationMs: row.durationMs,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    status: row.status,
    error: row.error as { message: string; code?: string } | null,
  };
}

export type TraceRepo = ReturnType<typeof createTraceRepo>;
