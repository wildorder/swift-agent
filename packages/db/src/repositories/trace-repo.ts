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
      await db.insert(traceSpans).values(spans.map(toSpanInsert));
    },

    // Atomic trace finalization: the trace row and all of its spans commit in a
    // single transaction, so a concurrent reader (e.g. a run's trace poll) can
    // never observe the trace without its spans.
    async saveTraceWithSpans(trace: TraceRecordRow, spans: SpanRecordRow[]): Promise<void> {
      await db.transaction(async (tx) => {
        await tx.insert(traces).values({
          traceId: trace.traceId,
          runId: trace.runId,
          rootSpanId: trace.rootSpanId,
          startedAt: trace.startedAt,
          completedAt: trace.completedAt,
          totalDurationMs: trace.totalDurationMs,
        });
        if (spans.length > 0) {
          await tx.insert(traceSpans).values(spans.map(toSpanInsert));
        }
      });
    },

    async getTraceByRunId(runId: string): Promise<TraceRecordRow | null> {
      const [row] = await db.select().from(traces).where(eq(traces.runId, runId));
      return row ? toTraceRecord(row) : null;
    },

    // Resolve a trace by its own id so a `traceId` can be mapped back to its
    // owning `runId` for a workspace-ownership check (WS-23).
    async getTraceById(traceId: string): Promise<TraceRecordRow | null> {
      const [row] = await db.select().from(traces).where(eq(traces.traceId, traceId));
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

function toSpanInsert(s: SpanRecordRow): typeof traceSpans.$inferInsert {
  return {
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
