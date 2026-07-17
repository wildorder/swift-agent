# WS-28: Run History & Metrics API + Trace-Persistence Hardening

## Goal

Give clients a first-class, ownership-enforced way to read the derived metrics of a single run, and make the underlying trace data those metrics are computed from both **truthful** and **bounded**. This workstream delivers three cohesive things: (1) a new `GET /v1/runs/:runId/metrics` REST endpoint that reuses the exact run-ownership path from the existing trace routes, resolves the run's trace, and returns a Zod-validated `RunMetrics` roll-up derived from the persisted spans; (2) a source-level fix so token counts actually land on the model span's metadata (today `deriveRunMetrics` sums `promptTokens`/`completionTokens` from span metadata, but the loop never writes them there, so `totalTokens` is always `0`); and (3) trace-persistence hardening that surfaces previously-swallowed trace-write failures through the runtime's structured `Logger` and bounds span `metadata`/`error` payload sizes in the observability layer so a pathological tool error or huge metadata blob cannot bloat `trace_spans`.

Metrics are **computed on read**, never persisted — no new table, no enum, no migration. This deliberately keeps WS-28 off the DB-migration path.

## Traceability

- **SC-07** — `GET /v1/runs/:runId/metrics` returns token usage, latency, and model/tool span counts for a run under workspace-ownership enforcement (404 on cross-workspace or missing run/trace, no existence leak).
- **SC-08** — Model, tool, and error spans are correctly reflected in the trace and metrics responses. The token-metadata fix (deliverable 2) is what makes span-derived `totalTokens` correct rather than always `0`.
- **SC-09** — Trace-write failures are logged (structured, non-throwing) instead of being silently swallowed, and span `metadata`/`error` payloads are bounded before persistence with an explicit truncation indicator.
- **SC-12** — `pnpm exec tsc --noEmit`, `pnpm exec eslint . --quiet`, and the new unit tests pass.

## Dependencies

- **core-runtime-completion:WS-23** — the run routes and `sessionService.getRun(workspaceId, runId)` ownership path (`run → session → agent → workspace`, throws `NOT_FOUND` → 404). The metrics route consumes this verbatim.
- **core-runtime-completion:WS-24** — the tracer wired into the loop (`deps.tracer`, `deps.logger`, the `safe()` best-effort finalization, and the `finally` that calls `trace?.finish(...)`). This workstream modifies that same finalize path and the model-span handling.
- **product-x:WS-10** — the observability package: `deriveRunMetrics`, `RunMetrics`, `Tracer`, `Span`, `RunTraceContext`, `TraceSink`, `SpanRecord`.

The trace-repo reads this workstream needs (`getTraceByRunId`, `listSpansByTraceId`) already exist — **no `packages/db` change is required**.

## Context Files (Agent MUST read before implementing)

- `c:\dev\swift-agent\CLAUDE.md` — conventions (Zod schemas are source of truth; derive types via `z.infer<>`; repos are factory functions; `ChatEvent` discriminated union; forced verification via `tsc --noEmit` + `eslint`).
- `c:\dev\swift-agent\packages\observability\src\metrics.ts` — `deriveRunMetrics(spans: SpanRecord[]): RunMetrics` and the `RunMetrics` interface. **Note:** `totalTokens` is `spans.reduce((sum, s) => sum + (s.metadata.promptTokens ?? 0) + (s.metadata.completionTokens ?? 0), 0)`. If nothing writes `promptTokens`/`completionTokens` onto a span, `totalTokens` is `0`.
- `c:\dev\swift-agent\packages\observability\src\index.ts` — barrel; exports `deriveRunMetrics`, `RunMetrics`, `Tracer`, `Span`, and the trace types.
- `c:\dev\swift-agent\packages\observability\src\tracer.ts` — `Tracer.startRunTrace(runId)` → `RunTraceContext`. `startModelCall(modelName)` adds only `{ modelName }` metadata today; `startToolCall(toolName, callId)` adds `{ toolName, callId }`; `finish(status, error?)` ends the root span and persists via the sink (`saveTraceWithSpans` preferred).
- `c:\dev\swift-agent\packages\observability\src\span.ts` — `Span` (`addMetadata`, `end`, `toRecord`); how `metadata` and `error` flow into a `SpanRecord`. `toRecord()` is the natural bounding point (it materializes `metadata` + `error` into the record).
- `c:\dev\swift-agent\packages\observability\src\types.ts` — `SpanRecord`, `TraceRecord`, `SpanError`, `SpanStatus`, `TraceSink`.
- `c:\dev\swift-agent\packages\db\src\repositories\trace-repo.ts` — `getTraceByRunId`, `getTraceById`, `listSpansByTraceId`, `saveTraceWithSpans` (atomic), `SpanRecordRow`, `TraceRecordRow`.
- `c:\dev\swift-agent\packages\api\src\routes\traces.ts` — existing trace routes + the ownership pattern (`await sessionService.getRun(workspaceId, runId)` before any read; `getTraceByRunId` → 404 if null with `{ error: { code: 'NOT_FOUND', message } }`).
- `c:\dev\swift-agent\packages\api\src\services\session-service.ts` — `SessionService` interface, `assertRunOwnership`, `getRun`. Metrics assembly reuses `getRun` for ownership.
- `c:\dev\swift-agent\packages\api\src\routes\runs.ts` — how run routes register (`app.get<{ Params: { runId: string } }>(...)`), the `AuthenticatedRequest` cast (`req as AuthenticatedRequest` → `workspaceId`), and `reply.send`/status conventions.
- `c:\dev\swift-agent\packages\api\src\server.ts` — `buildApp` wires the `/v1` plugin and calls `registerTraceRoutes(v1, { traceRepo, sessionService })`. Mirror this for the metrics route.
- `c:\dev\swift-agent\packages\api\src\types.ts` — where API Zod DTOs live (`ErrorBodySchema`, `AcceptedRunResponseSchema`, etc.). The metrics response schema goes here.
- `c:\dev\swift-agent\packages\api\src\index.ts` — barrel; export the new schema/type here.
- `c:\dev\swift-agent\packages\runtime\src\loop.ts` — trace usage: `deps.tracer?.startRunTrace`, `trace?.startModelCall(modelId)`, `modelSpan?.end('ok' | 'error', ...)`, and the `finally` that runs `await safe(() => trace?.finish(traceStatus, traceError))`. **`lastUsage` is captured from the model `finish` chunk (`chunk.usage` → `{ inputTokens, outputTokens, totalTokens }`) and written to `runs.complete(...)` (→ `runs.token_usage`) but is NOT added to the model span's metadata.**
- `c:\dev\swift-agent\packages\runtime\src\types.ts` — `Logger` type (`info`/`warn`/`error`), `AgentEngineDeps` (`tracer?`, `logger?`), `RunContext`.
- `c:\dev\swift-agent\apps\server\src\container.ts` — how the tracer, repos, `sessionService`, and routes are wired; where `AgentEngineDeps` is assembled (`engineDeps`) and where a `logger` would be injected (currently absent from `engineDeps`).
- `c:\dev\swift-agent\packages\api\src\__tests__\traces.test.ts` and `helpers.ts` — the in-memory trace-sink / mock-repo test pattern (`createMockTraceRepo`, `SEED_RUN`, `SEED_SPANS` with `metadata: { promptTokens: 100, completionTokens: 50 }`) to mirror for the metrics tests.

## Package

`packages/observability`, `packages/api`, `packages/runtime`, `apps/server`.

(`packages/db` is **not** touched — `getTraceByRunId` + `listSpansByTraceId` already exist.)

## Files Touched

- `packages/api/src/routes/metrics.ts` **(NEW)** — `registerMetricsRoutes(app, { traceRepo, sessionService })` exposing `GET /runs/:runId/metrics`. (A dedicated module rather than extending `traces.ts` — see Design Notes for justification.)
- `packages/api/src/types.ts` **(MODIFY)** — add `RunMetricsResponseSchema` (+ `RunMetricsResponse` type) validating the metrics body on the way out.
- `packages/api/src/index.ts` **(MODIFY)** — export `RunMetricsResponseSchema` + `RunMetricsResponse`.
- `packages/api/src/server.ts` **(MODIFY)** — import + call `registerMetricsRoutes(v1, { traceRepo, sessionService })` inside the `/v1` plugin, next to `registerTraceRoutes`.
- `packages/observability/src/span.ts` **(MODIFY)** — bound `metadata` + `error` in `Span.toRecord()` via the shared bounding helper.
- `packages/observability/src/bounds.ts` **(NEW)** — `boundSpanRecord(record: SpanRecord): SpanRecord` (+ exported limit constants). Shared so both the metrics path and raw trace reads benefit.
- `packages/observability/src/index.ts` **(MODIFY)** — export `boundSpanRecord` + the limit constants (so tests and any future caller can reference them).
- `packages/runtime/src/loop.ts` **(MODIFY)** — (a) add `{ promptTokens, completionTokens }` to the model span's metadata from `lastUsage` before `modelSpan.end('ok')`; (b) replace the swallowed `await safe(() => trace?.finish(...))` with a logged finalize that reports a trace-write failure via `deps.logger` (fallback `console.warn`) with `runId`, `traceId`, and the error — without throwing.
- `apps/server/src/container.ts` **(MODIFY)** — register the metrics route wiring (via `buildApp` → `server.ts`, already covered) and ensure a `logger` is present in `engineDeps` so the loop's finalize logging is real in production (inject the Fastify/pino logger or a thin console adapter).
- `packages/api/src/__tests__/metrics.test.ts` **(NEW)** — unit tests with mocked repos mirroring `traces.test.ts`.
- `packages/observability/src/__tests__/bounds.test.ts` **(NEW)** — unit tests for `boundSpanRecord` truncation behavior.
- `packages/runtime/src/__tests__/loop-metrics-finalize.test.ts` **(NEW)** — unit tests (mocked repos + fake provider + spy tracer/logger) proving token metadata is written to the model span and that a failing `trace.finish` is logged, not swallowed silently.

> **No DB/schema/migration change.** Metrics are derived on read from existing `traces` / `trace_spans` rows. The end-to-end DB-backed coverage (real Testcontainers Postgres proving a full run produces spans whose derived `totalTokens` matches `runs.token_usage`) is **WS-29's** job; WS-28's tests are unit-level with mocked repos.

## Existing Interfaces to Consume

**`RunMetrics` + `deriveRunMetrics`** (`packages/observability/src/metrics.ts`) — the shape the endpoint returns and the function that computes it:

```typescript
export interface RunMetrics {
  totalRunDurationMs: number | null;
  timeToFirstTokenMs: number | null;
  modelCallCount: number;
  toolCallCount: number;
  totalModelLatencyMs: number;
  totalToolLatencyMs: number;
  totalTokens: number;
}

export function deriveRunMetrics(spans: SpanRecord[]): RunMetrics {
  const runSpan = spans.find((s) => s.type === 'run_span');
  const modelSpans = spans.filter((s) => s.type === 'model_call_span');
  const toolSpans = spans.filter((s) => s.type === 'tool_call_span');
  // ...latency reductions...
  const totalTokens = spans.reduce((sum, s) => {
    const promptTokens = (s.metadata.promptTokens as number) ?? 0;
    const completionTokens = (s.metadata.completionTokens as number) ?? 0;
    return sum + promptTokens + completionTokens; // 0 today — nothing writes these
  }, 0);
  return { /* ... */ totalTokens };
}
```

**`SpanRecord`** (`packages/observability/src/types.ts`) — the bounding target and the input to `deriveRunMetrics`:

```typescript
export interface SpanError {
  message: string;
  code?: string;
}

export interface SpanRecord {
  spanId: string;
  parentSpanId: string | null;
  traceId: string;
  type: SpanType;            // 'run_span' | 'model_call_span' | 'tool_call_span'
  name: string;
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
  metadata: Record<string, unknown>;
  status: SpanStatus;        // 'ok' | 'error'
  error?: SpanError;
}
```

**`Span.toRecord()`** (`packages/observability/src/span.ts`) — the natural place to bound before a record leaves the observability layer:

```typescript
toRecord(): SpanRecord {
  const record: SpanRecord = {
    spanId: this.spanId,
    parentSpanId: this.parentSpanId,
    traceId: this.traceId,
    type: this.type,
    name: this.name,
    startedAt: this.startedAt ?? new Date(),
    completedAt: this.completedAt,
    durationMs: this.durationMs,
    metadata: { ...this.metadata },
    status: this.status,
  };
  if (this.error) {
    record.error = this.error;
  }
  return record;
}
```

**Trace-repo reads** (`packages/db/src/repositories/trace-repo.ts`) — consumed unchanged:

```typescript
async getTraceByRunId(runId: string): Promise<TraceRecordRow | null>;
async listSpansByTraceId(traceId: string): Promise<SpanRecordRow[]>; // ordered by startedAt asc
```

`SpanRecordRow` is structurally compatible with `SpanRecord` except `type`/`status` are `string` (from the DB) and `error` is `{ message; code? } | null`. `deriveRunMetrics` only reads `.type`, `.durationMs`, `.startedAt`, `.completedAt`, and `.metadata`, so passing `SpanRecordRow[]` works at runtime; cast to `SpanRecord[]` at the call site (the rows come from a trusted enum column). See Design Notes.

**Existing ownership pattern** (`packages/api/src/routes/traces.ts`) — copy this exactly:

```typescript
const { workspaceId } = req as AuthenticatedRequest;
const { runId } = req.params;
// Throws NOT_FOUND (→ 404) if the run is missing OR in another workspace.
await sessionService.getRun(workspaceId, runId);
const trace = await traceRepo.getTraceByRunId(runId);
if (!trace) {
  return reply.status(404).send({
    error: { code: 'NOT_FOUND', message: `No trace found for run ${runId}` },
  });
}
const spans = await traceRepo.listSpansByTraceId(trace.traceId);
```

**Loop model-span + token capture today** (`packages/runtime/src/loop.ts`) — where `lastUsage` is filled and where the model span ends without it:

```typescript
let lastUsage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {};
const modelSpan = trace?.startModelCall(modelId);
try {
  const stream = provider.generate({ /* ... */, signal: modelDeadline.signal });
  for await (const chunk of stream) {
    throwIfAborted();
    switch (chunk.type) {
      case 'token': /* ... */ break;
      case 'tool_call': /* ... */ break;
      case 'finish':
        lastUsage = chunk.usage;   // <-- captured here
        break;
    }
  }
  modelSpan?.end('ok');            // <-- ends WITHOUT token metadata (the gotcha)
} catch (err) {
  modelSpan?.end('error', asError(err));
  /* ... */
}
// ...later, on completion:
await deps.db.runs.complete(ctx.runId, {
  inputTokens: lastUsage.inputTokens ?? 0,
  outputTokens: lastUsage.outputTokens ?? 0,
  totalTokens: lastUsage.totalTokens ?? 0,
}); // <-- runs.token_usage: the authoritative persisted total
```

**Loop finalize today** (`packages/runtime/src/loop.ts`) — the swallowing to replace:

```typescript
const safe = async (fn: () => Promise<unknown> | undefined): Promise<void> => {
  try { await fn(); } catch { /* swallow — best-effort finalization */ }
};
// ...
} finally {
  for (const callId of openToolCalls) {
    await safe(() => deps.db.toolCalls.fail(callId));
  }
  await safe(() => trace?.finish(traceStatus, traceError)); // <-- trace-write errors vanish
}
```

**Runtime `Logger`** (`packages/runtime/src/types.ts`):

```typescript
export type Logger = {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
};
// AgentEngineDeps carries `tracer?: Tracer` and `logger?: Logger`.
```

**API DTO conventions** (`packages/api/src/types.ts`) — the new schema mirrors these (`.strict()`, `z.infer<>` for the type):

```typescript
export const AcceptedRunResponseSchema = z.object({
  runId: z.string(),
  status: z.string(),
}).strict();
export type AcceptedRunResponse = z.infer<typeof AcceptedRunResponseSchema>;
```

## Design Notes

- **Route placement — dedicated `metrics.ts`.** Both trace and metrics reads are trace-derived and share the ownership path, so extending `traces.ts` is defensible. This spec chooses a **new `routes/metrics.ts`** because: (1) the metrics endpoint carries its own Zod response schema and validation concern that does not belong to the raw trace/span readers; (2) it keeps each route module single-responsibility (the trace module returns raw trace/span rows; the metrics module returns a computed roll-up); (3) it mirrors the codebase convention of one `register*Routes` per resource (`runs.ts`, `traces.ts`, `sessions.ts`). The ownership snippet is short and copied verbatim — the small duplication is preferable to overloading `traces.ts`.

- **Reuse the EXACT ownership semantics.** Do not reinvent 404 handling. Call `await sessionService.getRun(workspaceId, runId)` first (throws `NOT_FOUND` → 404 via the API error handler, no existence leak), then `traceRepo.getTraceByRunId(runId)` and 404 with `{ error: { code: 'NOT_FOUND', message: 'No trace found for run ${runId}' } }` if null — byte-for-byte the `traces.ts` shape.

- **Metrics are COMPUTED, not persisted.** No new schema, no enum, no migration. The endpoint loads spans and calls `deriveRunMetrics` on each request. This keeps WS-28 entirely off the DB-migration path (WS-29 owns the DB-backed end-to-end proof).

- **Two token sources — reconcile explicitly.** After deliverable 2, tokens live in **two** places:
  - `runs.token_usage` — written once by `runs.complete(...)` from the model `finish` chunk. This remains the **authoritative persisted total** for a completed run and is what `GET /v1/runs/:runId` surfaces.
  - Model-span `metadata.promptTokens` / `metadata.completionTokens` — newly written per model call; summed by `deriveRunMetrics` into `RunMetrics.totalTokens`.
  The metrics endpoint **surfaces the span-derived `totalTokens`** (from `deriveRunMetrics`) because it must be internally consistent with the latency figures, which are *also* span-derived — mixing a span-derived latency with a run-row token total would let the two drift (e.g. a multi-round run whose row total lags a still-open trace). To defend against a run whose spans lack token metadata (older traces, or a provider that omits usage), the route MAY additionally read the run's `tokenUsage` (already available from the `getRun` ownership call) and, when `deriveRunMetrics` yields `totalTokens === 0` but `run.tokenUsage.totalTokens > 0`, **fall back** to the run-row total. Specify this fallback precisely in the implementation and cover it with a test. The response body carries a single `totalTokens`; do not expose both sources as separate fields (keep the DTO stable and small).

- **Bounding lives in observability, at `toRecord()`.** Placing `boundSpanRecord` inside `Span.toRecord()` (via the shared `packages/observability/src/bounds.ts` helper) means **every** path that produces a `SpanRecord` — the tracer's `finish` persistence AND any future in-memory read — is bounded before the record leaves the package. This protects `trace_spans` at write time regardless of caller. The helper is also exported so it can be applied defensively to rows read back if ever needed, and so its limits are unit-testable in isolation.

- **Concrete bounding limits (justified).**
  - `error.message` capped at **2,048 chars**. A stack-trace-laden tool error can be tens of KB; 2 KB preserves the human-readable head while bounding the row. When truncated, append `…[truncated]` and set `error.code` to the original code (never drop the code — it is small and load-bearing for classification).
  - `metadata` capped at a **total serialized budget of 8,192 bytes** (JSON length). Iterate keys in insertion order, keeping whole values while under budget; the **first value that would exceed the budget and every subsequent value is replaced** by the string `'[truncated]'`, and a boolean marker `metadata.__truncated = true` is added so the truncation is observable rather than silent. Known small numeric keys used by metrics (`promptTokens`, `completionTokens`, plus `modelName`, `toolName`, `callId`) are preserved first (whitelist them ahead of the budget walk) so bounding can never zero out the token counts that `deriveRunMetrics` depends on.
  - Rationale: 8 KB per span comfortably fits realistic metadata (model name, token counts, a few tags) while capping a pathological blob; 2 KB per error message likewise. Limits are exported constants (`MAX_SPAN_ERROR_MESSAGE_CHARS`, `MAX_SPAN_METADATA_BYTES`) so tests assert against the source of truth, not magic numbers.

- **Logged (not thrown) finalize.** The `finally` in the loop must still never throw — a thrown finalize would mask the real terminal cause. Replace the blanket `safe(() => trace?.finish(...))` with a variant that, on catch, calls `deps.logger?.warn('trace persistence failed', { runId, traceId, err })` (fall back to `console.warn` with the same structured fields when no logger is present) and then continues. The `traceId` is available from the trace context (`trace.traceId`). Keep the tool-call `fail` finalizations `safe()` as before (those are already conditional/idempotent and less diagnostically interesting; optionally log them too, but the trace write is the required one for SC-09).

- **`SpanRecordRow` vs `SpanRecord` at the route.** `listSpansByTraceId` returns `SpanRecordRow[]` (`type`/`status` typed as `string`). `deriveRunMetrics` expects `SpanRecord[]`. The columns are constrained by DB enums, so a `as unknown as SpanRecord[]` cast at the single call site is safe and localized; add a one-line comment explaining why. Do not widen `deriveRunMetrics`'s signature.

## Implementation Steps

1. **Bounding helper (`packages/observability/src/bounds.ts`)** — create and export:
   - `export const MAX_SPAN_ERROR_MESSAGE_CHARS = 2048;`
   - `export const MAX_SPAN_METADATA_BYTES = 8192;`
   - `export function boundSpanRecord(record: SpanRecord): SpanRecord` that returns a new record with:
     - `error` (if present): `message` truncated to `MAX_SPAN_ERROR_MESSAGE_CHARS` with a `…[truncated]` suffix when it exceeded; `code` preserved verbatim.
     - `metadata`: a bounded copy. Preserve the whitelist keys (`promptTokens`, `completionTokens`, `modelName`, `toolName`, `callId`) first, then walk the remaining keys in insertion order accumulating serialized byte length; once the running total would exceed `MAX_SPAN_METADATA_BYTES`, replace that value and all subsequent values with `'[truncated]'` and set `__truncated: true`. Never mutate the input `record` or its `metadata` (return fresh objects).
   - Keep the function pure and dependency-free (no I/O).

2. **Apply bounding in `Span.toRecord()` (`packages/observability/src/span.ts`)** — build the `SpanRecord` exactly as today, then `return boundSpanRecord(record);` (import from `./bounds.js`). This guarantees the tracer's `finish` persistence path emits bounded records.

3. **Export from the observability barrel (`packages/observability/src/index.ts`)** — add `export { boundSpanRecord, MAX_SPAN_ERROR_MESSAGE_CHARS, MAX_SPAN_METADATA_BYTES } from './bounds.js';`.

4. **Token metadata on the model span (`packages/runtime/src/loop.ts`)** — in the model-call `try` block, after the stream loop completes and before `modelSpan?.end('ok')`, add:
   ```typescript
   modelSpan?.addMetadata({
     promptTokens: lastUsage.inputTokens ?? 0,
     completionTokens: lastUsage.outputTokens ?? 0,
   });
   ```
   Keep the existing `runs.complete(...)` write of `lastUsage` unchanged — the run row's `token_usage` stays authoritative. (The `RunSpan` structural type in `runtime/src/types.ts` already declares `addMetadata`, so no type change is needed.)

5. **Logged finalize (`packages/runtime/src/loop.ts`)** — replace the trace-finalize line in `finally` with a logged variant:
   ```typescript
   try {
     await trace?.finish(traceStatus, traceError);
   } catch (finishErr) {
     const fields = { runId: ctx.runId, traceId: trace?.traceId, err: asError(finishErr).message };
     if (deps.logger) deps.logger.warn('trace persistence failed', fields);
     else console.warn('trace persistence failed', fields);
   }
   ```
   Do **not** rethrow. Leave the `openToolCalls` `safe()` loop above it as-is. (If `RunTraceContext.traceId` is not surfaced through the runtime's structural `RunTrace` interface, add `readonly traceId: string;` to `RunTrace` in `runtime/src/types.ts` — the concrete `RunTraceContext` already exposes it.)

6. **Metrics response schema (`packages/api/src/types.ts`)** — add:
   ```typescript
   export const RunMetricsResponseSchema = z.object({
     runId: z.string(),
     traceId: z.string(),
     totalRunDurationMs: z.number().nullable(),
     timeToFirstTokenMs: z.number().nullable(),
     modelCallCount: z.number().int().nonnegative(),
     toolCallCount: z.number().int().nonnegative(),
     totalModelLatencyMs: z.number().nonnegative(),
     totalToolLatencyMs: z.number().nonnegative(),
     totalTokens: z.number().int().nonnegative(),
   }).strict();
   export type RunMetricsResponse = z.infer<typeof RunMetricsResponseSchema>;
   ```
   (Includes `runId` + `traceId` for client correlation beyond the raw `RunMetrics` fields.)

7. **Export the schema (`packages/api/src/index.ts`)** — add `RunMetricsResponseSchema` to the value export block and `RunMetricsResponse` to the type export block.

8. **Metrics route (`packages/api/src/routes/metrics.ts`)** — new module:
   ```typescript
   export function registerMetricsRoutes(
     app: FastifyInstance,
     deps: { traceRepo: TraceRepo; sessionService: SessionService },
   ): void {
     const { traceRepo, sessionService } = deps;
     app.get<{ Params: { runId: string } }>('/runs/:runId/metrics', async (req, reply) => {
       const { workspaceId } = req as AuthenticatedRequest;
       const { runId } = req.params;
       // Ownership first — 404 on missing/cross-workspace, no existence leak.
       const run = await sessionService.getRun(workspaceId, runId);
       const trace = await traceRepo.getTraceByRunId(runId);
       if (!trace) {
         return reply.status(404).send({
           error: { code: 'NOT_FOUND', message: `No trace found for run ${runId}` },
         });
       }
       const spans = await traceRepo.listSpansByTraceId(trace.traceId);
       // Rows carry DB-enum-constrained `type`/`status`; safe to treat as SpanRecord[].
       const metrics = deriveRunMetrics(spans as unknown as SpanRecord[]);
       // Fall back to the run row's authoritative total only when spans carry no tokens.
       const totalTokens =
         metrics.totalTokens === 0 && (run.tokenUsage?.totalTokens ?? 0) > 0
           ? run.tokenUsage!.totalTokens
           : metrics.totalTokens;
       return reply.send(
         RunMetricsResponseSchema.parse({
           runId,
           traceId: trace.traceId,
           ...metrics,
           totalTokens,
         }),
       );
     });
   }
   ```
   Import `deriveRunMetrics` + `type SpanRecord` from `@swiftagent/observability`, `RunMetricsResponseSchema` from `../types.js`, `AuthenticatedRequest` from `../types.js`, `TraceRepo` from `@swiftagent/db`, `SessionService` from `../services/session-service.js`.

9. **Wire the route (`packages/api/src/server.ts`)** — import `registerMetricsRoutes` and call it inside the `/v1` plugin immediately after `registerTraceRoutes(v1, { traceRepo: opts.repos.traceRepo, sessionService })`:
   ```typescript
   registerMetricsRoutes(v1, { traceRepo: opts.repos.traceRepo, sessionService });
   ```

10. **Inject a logger into the engine deps (`apps/server/src/container.ts`)** — add a `logger` to `engineDeps` so the loop's finalize logging is real in production. Use a thin adapter over the app/pino logger or a minimal `console`-backed object satisfying the `Logger` type (`info`/`warn`/`error`). If the container has no logger to hand, construct a small `{ info: (m, d) => console.info(m, d), warn: ..., error: ... }`. Ensure `createRunExecutionService(engineDeps)` and `new AgentEngine(engineDeps)` both receive it (they share `engineDeps`). The metrics route needs no new container wiring beyond the `server.ts` registration.

## Tests

> All unit-level, mocked repos / in-memory sink — mirror `packages/api/src/__tests__/traces.test.ts` + `helpers.ts`. The DB-backed end-to-end proof (real spans → derived metrics == `runs.token_usage`) is **WS-29's** responsibility and is explicitly out of scope here.

**`packages/api/src/__tests__/metrics.test.ts`** (mirror the trace-routes test harness — `buildApp` with mock repos, `createMockTraceRepo` seeded with a trace + spans):

1. **Happy path (SC-07/SC-08):** with a seeded trace whose spans include a `run_span` (durationMs), two `model_call_span`s (each `metadata: { promptTokens, completionTokens }`) and one `tool_call_span`, `GET /v1/runs/:runId/metrics` returns 200 with `modelCallCount === 2`, `toolCallCount === 1`, `totalModelLatencyMs`/`totalToolLatencyMs` equal to the summed span durations, and `totalTokens` equal to the summed prompt+completion tokens across spans. Assert `runId` + `traceId` echo the seed.
2. **Token correctness (SC-08):** a span metadata of `{ promptTokens: 100, completionTokens: 50 }` (one model span) yields `totalTokens === 150` — proving span-derived tokens are surfaced (guards against the regression where they were always `0`).
3. **Run-row fallback:** when the seeded spans carry **no** token metadata (`metadata: {}`) but the seeded run's `tokenUsage.totalTokens === 150`, the response `totalTokens === 150` (fallback engaged). Conversely, when spans DO carry tokens, the span-derived value wins even if the run row differs (assert the span sum, not the row).
4. **404 — no trace (SC-07):** run exists (ownership passes) but `getTraceByRunId` returns null → 404 with `{ error: { code: 'NOT_FOUND', ... } }`.
5. **404 — cross-workspace / missing run (SC-07):** `sessionService.getRun` throws `NOT_FOUND` → 404, and the trace repo is never consulted (assert no existence leak; a missing run and a foreign run are indistinguishable).
6. **Response is Zod-validated:** the returned body satisfies `RunMetricsResponseSchema.parse(...)` (no extra keys — `.strict()`), confirming the DTO contract.

**`packages/observability/src/__tests__/bounds.test.ts`:**

7. **Error truncation:** an `error.message` longer than `MAX_SPAN_ERROR_MESSAGE_CHARS` is truncated to that length with a `…[truncated]` suffix and the original `code` preserved; a short message is returned unchanged.
8. **Metadata budget:** a metadata object exceeding `MAX_SPAN_METADATA_BYTES` has over-budget values replaced with `'[truncated]'` and `__truncated === true`; a small metadata object is returned unchanged with no `__truncated` marker.
9. **Whitelist preserved:** metadata containing huge junk keys AND `{ promptTokens, completionTokens, modelName }` retains the whitelisted keys with their original values even when the junk is truncated (so `deriveRunMetrics` still sees the tokens).
10. **Purity:** `boundSpanRecord` does not mutate its input record or the input `metadata`/`error` objects (assert the originals are unchanged).
11. **`Span.toRecord()` integration:** a `Span` with oversized metadata produces a bounded `SpanRecord` from `toRecord()` (proves the helper is wired into the span path).

**`packages/runtime/src/__tests__/loop-metrics-finalize.test.ts`** (mocked repos + fake provider streaming a `finish` chunk with `usage`, plus a spy tracer whose `startModelCall` returns a spy span and whose `finish` can be made to reject):

12. **Token metadata written (SC-08):** after a run where the provider emits `finish` with `usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }`, the spy model span received `addMetadata({ promptTokens: 100, completionTokens: 50 })`, AND `runs.complete` was called with the same `token_usage` (both sources populated).
13. **Finalize failure logged, not thrown (SC-09):** with a spy tracer whose `finish` rejects, the loop completes without throwing and `deps.logger.warn` was called with a payload containing `runId` and `traceId`; with no `logger` in deps, `console.warn` is invoked instead (spy `console.warn`). Assert the run still reached its terminal event (finalize did not mask the outcome).

## Acceptance Criteria

1. `GET /v1/runs/:runId/metrics` returns a Zod-validated `RunMetricsResponse` (token usage, run/model/tool latency, model/tool span counts, `timeToFirstTokenMs`) for an owned run, computed from the run's persisted spans via `deriveRunMetrics` — with no new table, enum, or migration (SC-07).
2. The endpoint enforces workspace ownership via `sessionService.getRun(workspaceId, runId)` **before** any trace read, returning 404 on a missing or cross-workspace run with no existence leak, and 404 with `{ error: { code: 'NOT_FOUND', ... } }` when the run has no trace — byte-for-byte the `routes/traces.ts` semantics.
3. The runtime loop writes `{ promptTokens, completionTokens }` onto the model span's metadata from the model `finish` usage, so `deriveRunMetrics` sums **real** tokens (not `0`); the `runs.token_usage` write is retained and remains the authoritative persisted total (SC-08).
4. The metrics response surfaces span-derived `totalTokens` for internal consistency with the span-derived latencies, falling back to the run row's `tokenUsage.totalTokens` only when spans carry no token metadata — the reconciliation is documented and tested (SC-08).
5. Trace-write failures in the loop's `finally` are logged via `deps.logger` (fallback `console.warn`) with structured `runId` + `traceId` + error, without throwing or masking the terminal cause (SC-09).
6. Span `metadata` and `error` payloads are bounded in the observability layer (`boundSpanRecord`, wired into `Span.toRecord()`) with concrete exported limits and an explicit truncation indicator (`…[truncated]` suffix / `__truncated` marker); the token whitelist keys are always preserved (SC-09).
7. The metrics route is registered in `buildApp` next to the trace routes, and `engineDeps` carries a `logger` so finalize logging is live in production.
8. `pnpm exec tsc --noEmit` and `pnpm exec eslint . --quiet` pass; the new API, observability, and runtime unit tests pass. (DB-backed end-to-end metrics coverage is deferred to WS-29.) (SC-12)
