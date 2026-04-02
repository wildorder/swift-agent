# WS-10: Observability & Tracing

## Goal

Implement structured tracing in `packages/observability` so each agent run produces queryable spans (run, model calls, tool calls) with timing, token usage, and error metadata. Persist traces to Postgres, expose trace query APIs via the control plane, and integrate pino with trace context for correlated structured logging.

## Dependencies

- WS-03
- WS-05b
- WS-07

## Package

`packages/observability` (with additive touches to `packages/db` for trace schema and `packages/api` for trace routes)

## Files Touched

- `packages/observability/src/tracer.ts`
- `packages/observability/src/span.ts`
- `packages/observability/src/types.ts`
- `packages/observability/src/logger.ts`
- `packages/observability/src/index.ts`
- `packages/db/src/schema/traces.ts` (new migration)
- `packages/db/src/repositories/trace-repo.ts`
- `packages/api/src/routes/traces.ts` (additive route)

## Implementation Steps

1. **Types (`types.ts`)**: Define `TraceId` (prefixed `tr_`), `SpanId` (prefixed `sp_`). Define `SpanType = "run_span" | "model_call_span" | "tool_call_span"`. Define `SpanRecord`: `{ spanId, parentSpanId: string | null, traceId, type: SpanType, name: string, startedAt: Date, completedAt: Date | null, durationMs: number | null, metadata: Record<string, unknown>, status: "ok" | "error", error?: { message: string; code?: string } }`. Define `TraceRecord`: `{ traceId, runId: string, rootSpanId: string, startedAt: Date, completedAt: Date | null, totalDurationMs: number | null }`.

2. **Span (`span.ts`)**: Class `Span` with constructor `(spanId, traceId, parentSpanId, type, name)`. Methods: `start()` — sets `startedAt = Date.now()`. `end(status: "ok" | "error", error?: Error)` — sets `completedAt`, computes `durationMs`. `addMetadata(partial: Record<string, unknown>)` — merges into metadata (model name, token counts, tool name, input/output byte sizes). `startChild(type: SpanType, name: string): Span` — creates child span with this span as parent, same traceId. `toRecord(): SpanRecord` — serializes to persistable form.

3. **Tracer (`tracer.ts`)**: Class `Tracer` with constructor `(traceSink: TraceSink)`. Method `startRunTrace(runId: string): RunTraceContext` — creates root `run_span`, generates `traceId`. `RunTraceContext` exposes: `startModelCall(modelName: string): Span`, `startToolCall(toolName: string, callId: string): Span`, `finish(status: "ok" | "error", error?: Error): Promise<void>` — ends root span, persists all spans via sink. Holds internal span list for batch persistence.

4. **TraceSink interface**: `interface TraceSink { saveTrace(trace: TraceRecord): Promise<void>; saveSpans(spans: SpanRecord[]): Promise<void> }`. Implemented by `TraceRepository` in `packages/db`.

5. **Trace schema (`packages/db`)**: Drizzle schema for `traces` table: `traceId` PK, `runId` FK → `runs.runId` unique indexed, `rootSpanId`, `startedAt`, `completedAt`, `totalDurationMs`. `trace_spans` table: `spanId` PK, `traceId` FK → `traces.traceId` indexed, `parentSpanId` nullable, `type` text, `name` text, `startedAt`/`completedAt` timestamps, `durationMs` integer nullable, `metadata` JSONB, `status` text, `error` JSONB nullable. Migration file ordered after existing tables.

6. **TraceRepository (`packages/db`)**: Implements `TraceSink`. Methods: `saveTrace(trace)`, `saveSpans(spans[])` in transaction, `getTraceByRunId(runId)`, `listSpansByTraceId(traceId)` ordered by `startedAt`.

7. **Trace API route (`packages/api`)**: `GET /runs/:runId/trace` — returns trace with nested spans. `GET /traces/:traceId/spans` — returns span list. Auth-scoped to workspace (join through run → session → agent → workspace). Register in WS-07's Fastify server.

8. **Logger integration (`logger.ts`)**: Export `createTracedLogger(baseLogger: pino.Logger, ctx: { traceId: string; spanId?: string }): pino.Logger` — wraps pino `child()` with `traceId` and `spanId` bindings injected into every log line. For MVP, explicit parameter passing; document AsyncLocalStorage approach for future.

9. **Metrics derivations**: Expose query helpers or SQL: time-to-first-token (gap between run start and first token span end), model call latency, tool call latency, total run latency, token usage aggregation per run and per session.

10. **Runtime integration point**: Document that `AgentEngine` (WS-05) accepts an optional `Tracer` instance. When present, the engine creates model and tool spans during the loop. When absent, tracing is a no-op. This keeps the runtime decoupled from observability.

## Tests

1. Span nesting: child span has correct `parentSpanId` and same `traceId` as parent.
2. Span timing: `durationMs` equals `completedAt - startedAt` for known timestamps.
3. Tracer: `startRunTrace` creates root span; `startModelCall` and `startToolCall` create children; `finish` calls sink with all spans.
4. TraceSink/Repository: save and load trace by `runId`; list spans ordered by start time.
5. Logger: traced logger output includes `traceId` and `spanId` in JSON.
6. Trace API route: `GET /runs/:runId/trace` returns correct shape with nested spans (mock or integration test).
7. Metrics: known span timestamps produce expected latency and TTFT values.

## Acceptance Criteria

1. Every completed run can produce a trace with a unique `traceId` and spans for the run, each model call, and each tool call.
2. Traces and spans are persisted to Postgres and queryable via `GET /runs/:runId/trace`.
3. Span records include timing (`durationMs`), metadata (model name, token counts, tool name), and status.
4. Pino logs include `traceId` and `spanId` when the traced logger is used.
5. Token usage and latency summaries (including time-to-first-token) are derivable from stored span data.
6. Tracing is opt-in for the runtime engine — no performance impact when disabled.
