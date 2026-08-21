# WS-24: Cancellation, Timeout, and Failure Hardening

## Goal

Make run termination correct, race-safe, and fully finalized on every exit path. This workstream extends the run status model with `cancelled` and `timed_out` terminal states (in both the shared Zod schema and the Drizzle `pgEnum`, with a backward-compatible migration), propagates an `AbortSignal` through the model and tool boundaries for cancellation and deadlines, enforces model / tool / total-run deadlines that abort supported work and persist `timed_out`, makes terminal transitions conditional and idempotent so a late provider or runner response cannot overwrite a terminal state, finalizes tool-call and trace records on every exit path (success, failure, cancel, timeout), adds an explicit WebSocket `cancel` message, and defines disconnect behavior independently from cancellation. It also wires the observability `Tracer` into the runtime loop (currently instantiated but never passed in) so trace and tool-call records are consistently populated before a run emits or returns its terminal result.

## Traceability

- **SC-13** — Repeated cancellation requests are safe, and a cancelled run cannot later transition to completed, failed, or timed out.
- **SC-14** — Model, tool, and total-run deadlines abort supported work and persist `timed_out` state.
- **SC-15** — Provider, validation, transport, and tool-handler failures finalize run, tool-call, and trace records consistently.

## Dependencies

- **WS-23** — the `RunExecutionService`, `POST /runs/:runId/cancel`, and the shared active-run registry / session lock.
- **product-x WS-10** — observability `Tracer`, `Span`, `TraceSink`, `deriveRunMetrics`.
- **db-migration-baseline WS-01** — greenfield baseline migration; `migrate` is the single source of truth. Add the new `run_status` enum values via a **generated incremental migration** (`db:generate`) layered on the baseline — never hand-written `ALTER TYPE ... IF NOT EXISTS` or edits to `test/setup-db.ts` (which now applies real migrations). (WS-24 also depends transitively on WS-19, which introduces the first incremental `0001`; this workstream's enum migration is the next index.)

## Context Files (Agent MUST read before implementing)

- `c:\dev\swift-agent\CLAUDE.md` — conventions.
- `c:\dev\swift-agent\packages\shared\src\types\run.ts` — `RunStatusSchema` (`running|completed|failed`), `RunRecordSchema`.
- `c:\dev\swift-agent\packages\shared\src\index.ts` — shared barrel.
- `c:\dev\swift-agent\packages\db\src\schema\runs.ts` — `runStatusEnum` + `runs` table (source of truth; `db:generate` diffs this against the prior snapshot).
- `c:\dev\swift-agent\packages\db\src\repositories\run-repo.ts` — `updateStatus`, `complete`, `fail`, `getById`.
- `c:\dev\swift-agent\packages\db\src\repositories\tool-call-repo.ts` — `updateResult`, `fail`, `create`, `listByRun`.
- `c:\dev\swift-agent\packages\db\drizzle\0000_baseline.sql` + `meta\*_snapshot.json` + `meta\_journal.json` — the migration history (baseline + WS-19's `0001`); **managed by `drizzle-kit generate`** — do NOT hand-edit.
- `c:\dev\swift-agent\packages\db\drizzle.config.ts` + `packages\db\package.json` — `db:generate` (`tsc && drizzle-kit generate`, schema from `dist/schema/*.js`) is the migration-authoring command.
- `c:\dev\swift-agent\test\setup-db.ts` — Testcontainers globalSetup; it applies the real migrations, so the new enum values appear automatically once the generated migration is committed. **Do NOT hand-edit its schema.**
- `c:\dev\swift-agent\packages\runtime\src\loop.ts` — abort checks (`throw new Error('Run was cancelled')`), terminal transitions, `MAX_ITERATIONS`.
- `c:\dev\swift-agent\packages\runtime\src\engine.ts` — signal merge (`AbortSignal.any`), session lock release.
- `c:\dev\swift-agent\packages\runtime\src\run-execution-service.ts` — active-run registry + cancel (WS-23).
- `c:\dev\swift-agent\packages\runtime\src\types.ts` — runtime `Tracer` type (`startSpan`/`endSpan`) and `AgentEngineOptions`.
- `c:\dev\swift-agent\packages\observability\src\tracer.ts` — `Tracer.startRunTrace(runId)` → `RunTraceContext` (`startModelCall`, `startToolCall`, `finish`).
- `c:\dev\swift-agent\packages\observability\src\span.ts` — `Span` lifecycle (`start`, `end(status, error?)`, `addMetadata`, `startChild`, `toRecord`).
- `c:\dev\swift-agent\packages\gateway\src\types.ts` — `InboundMessageSchema` (only `send_message`, `ping`).
- `c:\dev\swift-agent\packages\gateway\src\events.ts` — `parseInboundMessage`.
- `c:\dev\swift-agent\packages\gateway\src\server.ts` — inbound message handling.
- `c:\dev\swift-agent\packages\gateway\src\session-bridge.ts` — run consumption, disconnect handling.
- `c:\dev\swift-agent\apps\server\src\container.ts` — tracer instantiated but not wired into the engine.

## Package

`packages/shared`, `packages/db`, `packages/runtime`, `packages/gateway`, `packages/observability`

## Files Touched

- `packages/shared/src/types/run.ts` **(MODIFY)** — add `cancelled`, `timed_out` to `RunStatusSchema`.
- `packages/db/src/schema/runs.ts` **(MODIFY)** — add enum values to `runStatusEnum` (source of truth for the generated migration).
- `packages/db/drizzle/000N_<generated_name>.sql` **(NEW, generated)** — the incremental migration adding the enum values, produced by `pnpm --filter @swiftagent/db db:generate` (next index after WS-19's `0001`; do NOT hand-write it).
- `packages/db/drizzle/meta/000N_snapshot.json` **(NEW, generated)** — snapshot emitted by `db:generate`.
- `packages/db/drizzle/meta/_journal.json` **(MODIFY, generated)** — new entry appended by `db:generate` (do NOT hand-edit).
- `packages/db/src/repositories/run-repo.ts` **(MODIFY)** — conditional terminal transitions (`cancel`, `timeout`, guarded `complete`/`fail`).
- `packages/db/src/repositories/tool-call-repo.ts` **(MODIFY)** — conditional tool-call terminal transitions guarded by `status = 'started'`.
- `packages/runtime/src/deadlines.ts` **(NEW)** — model/tool/total-run deadline signal composition.
- `packages/runtime/src/loop.ts` **(MODIFY)** — deadline signals, tracer spans, finalize tool-calls/traces on every exit, distinguish cancel vs timeout.
- `packages/runtime/src/engine.ts` **(MODIFY)** — build deadline signal; ensure terminal finalize + lock release on all paths.
- `packages/runtime/src/run-execution-service.ts` **(MODIFY)** — map abort cause to `cancelled` vs `timed_out`; finalize terminal status race-safely.
- `packages/runtime/src/types.ts` **(MODIFY)** — align runtime `Tracer` type with observability `Tracer`; add deadline options to `AgentEngineOptions`.
- `packages/observability/src/tracer.ts` **(MODIFY, if needed)** — ensure spans finalize with error status; export a runtime-friendly adapter.
- `packages/gateway/src/types.ts` **(MODIFY)** — add `CancelMessageSchema` to `InboundMessageSchema`.
- `packages/gateway/src/server.ts` **(MODIFY)** — handle `cancel`; define disconnect policy.
- `packages/gateway/src/session-bridge.ts` **(MODIFY)** — route `cancel` to the execution service; disconnect does not auto-cancel.
- `apps/server/src/container.ts` **(MODIFY)** — pass the observability `Tracer` into the engine/execution service.
- `packages/runtime/src/__tests__/lifecycle-hardening.test.ts` **(NEW)** — cancel/timeout/race/finalize tests using **mocked** repos + fake provider (unit; no DB).
- `packages/gateway/src/__tests__/cancel-protocol.test.ts` **(NEW)** — cancel message + disconnect tests (unit; mocked runtime).
- `test/integration/run-repo-terminal.integration.test.ts` **(NEW)** — conditional run- and tool-call terminal-transition tests against the real Testcontainers DB (schema materialized by the migrator in `test/setup-db.ts`, which applies the committed migrations including this workstream's enum migration). **Must** live at repo root under `test/integration/` with the `.integration.test.ts` suffix (discovered by `pnpm test:integration` + `test/setup-db.ts` globalSetup), NOT under `packages/db/src/__tests__` where the package default `*.test.ts` glob would run it as a DB-less unit test.

> **No `test/setup-db.ts` change.** As of db-migration-baseline WS-01, the test bootstrap runs the real Drizzle migrator, so the new `run_status` values are added automatically once the generated migration is committed — do not hand-edit the test schema.

## Existing Interfaces to Consume

**Run status today** (`packages/shared/src/types/run.ts`):

```typescript
export const RunStatusSchema = z.enum(['running', 'completed', 'failed']);
export type RunStatus = z.infer<typeof RunStatusSchema>;
```

**Drizzle enum today** (`packages/db/src/schema/runs.ts`):

```typescript
export const runStatusEnum = pgEnum('run_status', ['running', 'completed', 'failed']);
```

**`run-repo` terminal methods today** (`packages/db/src/repositories/run-repo.ts`): `updateStatus(runId, status)`, `complete(runId, tokenUsage)`, `fail(runId)`, `getById(runId)` — none are currently conditional on the existing status.

**`tool-call-repo` methods today** (`packages/db/src/repositories/tool-call-repo.ts`): `create({ callId, runId, toolName, input })`, `updateResult(callId, output, status='completed')`, `fail(callId)`, `listByRun(runId)` — `updateResult`/`fail` are **unconditional** writes today (a late runner response could overwrite a finalized failure). These must become conditional on `status = 'started'`.

**`Span` lifecycle today** (`packages/observability/src/span.ts`) — used via `RunTraceContext.startModelCall`/`startToolCall`, which return a `Span`:

```typescript
export class Span {
  start(): this;
  end(status: 'ok' | 'error', error?: Error): this;   // sets completedAt, durationMs, error
  addMetadata(partial: Record<string, unknown>): this;
  startChild(type: SpanType, name: string): Span;      // auto-starts child
  toRecord(): SpanRecord;
}
```

`RunTraceContext` (`packages/observability/src/tracer.ts`): `{ traceId; rootSpan: Span; startModelCall(modelName): Span; startToolCall(toolName, callId): Span; finish(status: 'ok'|'error', error?: Error): Promise<void> }`. `finish` ends the root span and persists trace + all spans via the `TraceSink`.

**Loop abort handling today** (`packages/runtime/src/loop.ts`): `if (ctx.abortSignal.aborted) throw new Error('Run was cancelled')` (checked at loop top and inside the chunk stream). On max iterations it calls `deps.db.runs.fail(runId)` and yields `run_failed`. On success it calls `deps.db.runs.complete(...)`.

**Engine signal merge today** (`packages/runtime/src/engine.ts`): `mergedSignal = signal ? AbortSignal.any([signal, lockController.signal]) : lockController.signal`.

**Observability `Tracer` today** (`packages/observability/src/tracer.ts`): `startRunTrace(runId)` returns `{ traceId, rootSpan, startModelCall(modelName), startToolCall(toolName, callId), finish(status, error?) }`. Runtime's `types.ts` declares a *different* `Tracer` shape (`startSpan`/`endSpan`) that nothing implements — reconcile to the observability one.

**Gateway inbound protocol today** (`packages/gateway/src/types.ts`): `InboundMessageSchema = z.discriminatedUnion('type', [SendMessageSchema, PingMessageSchema])`.

## Design Notes

- **Cancel vs timeout distinction.** Use distinct `AbortController`s so the loop can tell *why* it aborted:
  - `cancelController` — fired by `requestCancel` (user cancellation) → terminal `cancelled`. **Owned by the `RunExecutionService`** (WS-23), which already keeps `Map<runId, AbortController>`; its signal is passed into `executePreparedRun`.
  - `deadlineController` — fired by a deadline timer → terminal `timed_out`. Created inside `executePreparedRun`.
  - The session lock is owned and released by the `RunExecutionService` (WS-23), **not** re-acquired here.
  Merge with `AbortSignal.any([signal, deadlineController.signal])` in `executePreparedRun`, and distinguish causes by reason: deadline controllers abort with a `RunTimeoutError` (see step 5), user cancel aborts without one. Read `signal.reason` (and the merged sub-signals) to classify.
- **Conditional terminal transitions (SC-13).** Terminal writes must be guarded in SQL: `UPDATE runs SET status = $new WHERE run_id = $id AND status = 'running'`. Once a run is any terminal state, further terminal writes are no-ops. This prevents a late provider/runner response from overwriting `cancelled` with `completed`/`failed`/`timed_out`.
- **Finalize everything (SC-15).** On any exit path, before the run emits/returns its terminal result: mark still-`started` tool calls as `failed`, close all open spans with the correct status, persist the trace via `TraceSink`. Use `try/finally` so failures in the middle still finalize.
- **Disconnect ≠ cancel.** A WebSocket disconnect must NOT abort a server-owned run. Only an explicit `cancel` message (or REST cancel) cancels. Document this.
- **Deadline policy (definitive).** Any deadline — per-model-call, per-tool-call, or total-run — terminates the whole run as `timed_out`. A tool that exceeds `toolTimeoutMs` is finalized as a `failed` tool call AND the run transitions to `timed_out` (the run does not silently continue). There is no "continue past a deadline" branch. This makes SC-14 unambiguous.

## Implementation Steps

1. **Shared status (`packages/shared/src/types/run.ts`)**: `RunStatusSchema = z.enum(['running','completed','failed','cancelled','timed_out'])`. `RunRecordSchema` unchanged otherwise.

2. **Drizzle enum (`packages/db/src/schema/runs.ts`)**: `pgEnum('run_status', ['running','completed','failed','cancelled','timed_out'])`.

3. **Generate the migration (`packages/db/drizzle/000N_*.sql` + `meta/000N_snapshot.json` + `_journal.json`)**: After editing the enum in the schema (step 2), run `pnpm --filter @swiftagent/db db:generate`. drizzle-kit diffs the schema against the prior snapshot and emits an incremental migration adding the two enum values (roughly `ALTER TYPE "public"."run_status" ADD VALUE 'cancelled';` and `... ADD VALUE 'timed_out';`), plus `meta/000N_snapshot.json` and an appended `_journal.json` entry. Commit all three generated artifacts verbatim. **Do NOT hand-write the SQL, do NOT add `IF NOT EXISTS`, and do NOT hand-edit `_journal.json`.** On PostgreSQL 12+ (tests run `postgres:16-alpine`; prod is PG 16), `ALTER TYPE ... ADD VALUE` executes fine inside the migrator's per-migration transaction as long as the new values are not *used* in the same migration (this one only adds them). Inspect the generated SQL to confirm it contains only the two `ADD VALUE` statements; if it shows anything else, rebuild `dist` and regenerate.

3b. **Verify the migration applies**: `test/setup-db.ts` runs the migrator, so `pnpm test:integration` proves the enum migration applies cleanly on top of the baseline and WS-19's `0001`. No `test/setup-db.ts` edit is needed or permitted.

4. **run-repo conditional transitions (`packages/db/src/repositories/run-repo.ts`)**: Add:
   - `cancel(runId): Promise<RunRecord | null>` → `UPDATE ... SET status='cancelled', updated_at=now() WHERE run_id=$id AND status='running' RETURNING *` (returns `null` if not transitioned).
   - `timeout(runId): Promise<RunRecord | null>` → same pattern with `status='timed_out'`.
   - Make `complete` and `fail` conditional on `status='running'` too (guard clause) so they cannot overwrite a terminal state (SC-13). Return `null` when no row transitioned; callers treat `null` as "already terminal — do nothing."

4b. **tool-call-repo conditional transitions (`packages/db/src/repositories/tool-call-repo.ts`)**: Guard `updateResult` and `fail` with `WHERE call_id=$id AND status='started'` so a late/duplicate runner response cannot overwrite an already-finalized tool call (returns `null` when no row transitioned). This closes the tool-call analogue of the run race (SC-15).

5. **Deadlines (`packages/runtime/src/deadlines.ts`)**: Export a typed cause `class RunTimeoutError extends SwiftAgentError` (code `TIMEOUT`, carrying `scope: 'model' | 'tool' | 'total'`). Export `createDeadlineController(totalRunMs?: number): { controller: AbortController; dispose(): void }` for the total-run deadline, and helpers that derive per-model-call and per-tool-call deadline `AbortController`s and merge them with the run signal. **Every deadline controller aborts with a `RunTimeoutError` as its `reason`** (not a bare `AbortSignal.timeout()`), so downstream code can distinguish a timeout from a user cancel by inspecting `signal.reason instanceof RunTimeoutError`. Read defaults from `AgentEngineOptions` (add `modelTimeoutMs`, `toolTimeoutMs` already exists, `totalRunMs`).

6. **Options (`packages/runtime/src/types.ts`)**: Extend `AgentEngineOptions` with `modelTimeoutMs?`, `totalRunMs?` (keep `toolTimeoutMs`). Replace the unused `Tracer` type with an import/alias of the observability `Tracer` (or a minimal `RunTracer` interface matching `startRunTrace`). Ensure `AgentEngineDeps.tracer?` uses the reconciled type.

7. **Engine (`packages/runtime/src/engine.ts`)**: Deadlines compose **inside the lock-free `executePreparedRun`** entry that WS-23 introduced — do **not** reintroduce lock handling here (WS-23 made the `RunExecutionService` the sole `SessionLock` owner; `executePreparedRun` must stay lock-free). In `executePreparedRun`, build `deadlineController` from `options.totalRunMs` and merge only the **supplied** run/cancellation signal with the deadline signal: `AbortSignal.any([signal, deadlineController.signal])` (the incoming `signal` already carries the service's cancellation and any session-lock signal the service chose to merge in). Pass the individual controllers/signals down to the loop (via `RunContext` or params) so the loop can distinguish cancel vs timeout causes. Ensure a `finally` disposes the deadline timer. The legacy `AgentEngine.run` wrapper (if retained) is the only place that may touch the lock, and even it should delegate through the service per WS-23 — never double-acquire.

8. **Loop hardening (`packages/runtime/src/loop.ts`)**:
   - Start a trace: `const trace = deps.tracer?.startRunTrace(ctx.runId)`. Wrap each model call in `trace?.startModelCall(modelId)` and each tool call in `trace?.startToolCall(toolName, swiftCallId)`; end each span with `ok`/`error`.
   - Apply per-model-call and per-tool-call deadline signals from `deadlines.ts` (merged with `ctx.abortSignal`). When the remote executor returns a timeout result (`{ ok:false, error }` from an aborted request whose merged signal carried a `RunTimeoutError`), or a per-model-call deadline fires, **promote it to a run timeout** rather than treating it as an ordinary tool/model failure: set a `timedOut` flag with the timeout scope.
   - Classify the terminal cause explicitly:
     - `signal.reason instanceof RunTimeoutError` **or** the local `timedOut` flag → **timeout** → finalize via `runRepo.timeout(runId)`.
     - aborted without a timeout reason (user/`requestCancel`) → **cancel** → finalize via `runRepo.cancel(runId)`.
     - otherwise (provider/handler error) → **failure** → finalize via `runRepo.fail(runId)`.
     Replace the generic `throw new Error('Run was cancelled')` with this classification. Emit an appropriate terminal event using `run_failed` with a distinct `code` (`CANCELLED` / `TIMED_OUT` / the error code) to avoid a breaking `ChatEvent` schema change; document this choice.
   - In a `finally`/`catch` that runs on every exit path: mark any `started` tool calls for this run as `failed` via the **conditional** `toolCallRepo.fail` (guarded by `status='started'`), call `trace?.finish(status, error?)` to persist spans/trace, and perform the conditional terminal run transition via the classification above (SC-14, SC-15). Because all terminal writes are conditional, whichever cause fires first wins.

9. **Execution service (`packages/runtime/src/run-execution-service.ts`)**: In `requestCancel`, abort the run's `cancelController` (not the deadline one). After the loop ends, finalize the run's terminal status **race-safely** using conditional repo methods: if cancellation was requested, call `runRepo.cancel(runId)`; if a deadline fired, `runRepo.timeout(runId)`; on normal completion/failure the loop already finalized. Because all terminal writes are `WHERE status='running'`, whichever fires first wins and the rest are no-ops (SC-13). `requestCancel` remains idempotent (repeated calls: abort is a no-op if already aborted; return `{ requested: true }`).

10. **Observability wiring (`apps/server/src/container.ts`)**: Pass `tracer` into the engine/execution service deps (`AgentEngineDeps.tracer = tracer`). This fixes the known tech debt where the tracer was instantiated but never wired, so `GET /v1/runs/:runId/trace` returns real spans (SC-15).

11. **Gateway cancel message (`packages/gateway/src/types.ts`, `events.ts`, `server.ts`, `session-bridge.ts`)**:
    - Add `CancelMessageSchema = z.object({ type: z.literal('cancel') }).strict()` and include it in `InboundMessageSchema`.
    - In the server inbound handler, on `cancel` call `sessionBridge.handleCancel(sessionId)` → `runExecutionService.requestCancel(activeRunIdForSession)`. The bridge tracks the active `runId` per session (it already tracks `currentRunId` in the replay buffer).
    - **Disconnect policy**: on socket close, remove the connection but DO NOT cancel the run. Add a comment/const documenting that server-owned runs survive client disconnects (reconnection replays buffered events). Only an explicit `cancel` message cancels.

12. **Tracer span finalize (`packages/observability/src/tracer.ts`)**: Verify `finish('error', err)` ends the root span with error status and persists spans; if a runtime-friendly per-call API is missing, add a thin adapter but keep the existing `startRunTrace` contract.

## Tests

1. **Shared/enum**: `RunStatusSchema` accepts `cancelled` and `timed_out`.
2. **Conditional cancel (SC-13)**: `run-repo.cancel` transitions `running`→`cancelled` and returns the row; calling `complete`/`fail`/`timeout` afterward returns `null` and leaves status `cancelled` (integration, Testcontainers).
2b. **Conditional tool-call transition (SC-15)**: `tool-call-repo.updateResult`/`fail` on an already-finalized (`completed`/`failed`) tool call returns `null` and does not overwrite the prior result.
3. **Idempotent cancel (SC-13)**: `requestCancel` twice on an in-flight run is safe; the run ends `cancelled`; a late provider completion does not flip it to `completed`.
4. **Model deadline (SC-14)**: fake provider hangs beyond `modelTimeoutMs` → run aborts and persists `timed_out`; provider stream is aborted.
5. **Tool deadline (SC-14)**: tool handler hangs beyond `toolTimeoutMs` → the tool call is finalized `failed` AND the run persists `timed_out` (per the definitive deadline policy — no silent continuation).
6. **Total-run deadline (SC-14)**: multi-round run exceeding `totalRunMs` → `timed_out`.
7. **Finalize on failure (SC-15)**: provider throws mid-stream → run `failed`, any `started` tool call → `failed`, trace persisted with an error span.
8. **Finalize on cancel (SC-15)**: cancel mid-tool → tool call `failed`, trace finalized, run `cancelled`.
9. **Tracer wired (SC-15)**: after a successful run, `traceRepo` has a trace + spans (root/model/tool) — proving the tracer is now passed into the loop.
10. **Cancel message**: gateway parses `{ type:'cancel' }` and cancels the active run; broadcasts a terminal event.
11. **Disconnect ≠ cancel**: closing the socket does not cancel the run; the run continues to a terminal state and events are buffered for replay.
12. **Race safety**: fire cancel and normal completion near-simultaneously → exactly one terminal state persists; no overwrite.

## Acceptance Criteria

1. `RunStatus` includes `cancelled` and `timed_out` in both the shared schema and the Drizzle enum, added via a `db:generate`-produced incremental migration (`000N_*.sql` + `meta/000N_snapshot.json` + appended `_journal.json` entry) layered on the baseline — no hand-written DDL, no `IF NOT EXISTS`, no test-bootstrap edits.
2. Terminal run transitions are conditional (`WHERE status='running'`) and idempotent; a cancelled run can never later become completed, failed, or timed out (SC-13).
3. An `AbortSignal` propagates through model and tool boundaries; every model, tool, and total-run deadline aborts supported work and persists `timed_out` (no silent continuation past a deadline) (SC-14).
4. Provider, validation, transport, and tool-handler failures finalize the run, all still-open tool calls, and the trace consistently on every exit path; tool-call terminal writes are conditional so late responses cannot overwrite a finalized tool call (SC-15).
5. The observability `Tracer` is wired into the runtime loop; `GET /v1/runs/:runId/trace` returns populated spans.
6. The gateway supports an explicit `cancel` inbound message; ordinary disconnects do not cancel server-owned runs, and this policy is documented.
7. Cancellation requests are idempotent and safe under races with completion/timeout.
8. `pnpm exec tsc --noEmit` and `pnpm exec eslint . --quiet` pass; new lifecycle, repo, and gateway tests pass.
