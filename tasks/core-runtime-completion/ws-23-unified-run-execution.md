# WS-23: Unified Run Execution and REST Semantics

## Goal

Collapse the two divergent run paths into one authoritative execution service. Today `POST /v1/sessions/:sessionId/runs` (REST) only persists a `RunRecord` + user message and returns `201` — it never executes — while the WebSocket `send_message` path calls `AgentEngine.run()` which independently generates its *own* `runId` and re-persists the user message and run. As a result REST-created runs stay `running` forever, the two paths create duplicate run records, and REST clients cannot trigger real execution. This workstream introduces a single `RunExecutionService` that owns user-message persistence, run creation, execution (delegating to `AgentEngine`/`runAgentLoop`), and final assistant-message persistence. Both REST and the gateway invoke it. REST becomes asynchronous: `POST .../runs` returns `202 Accepted` and executes process-bound in the background; `GET /v1/runs/:runId` exposes status; `POST /v1/runs/:runId/cancel` requests idempotent cancellation. Execution remains process-bound; restart recovery is explicitly out of scope (Phase 2).

## Traceability

- **SC-11** — REST run creation returns `202`, executes without a WebSocket client, and remains observable through run, message, tool-call, and trace endpoints.
- **SC-12** — REST and WebSocket entry points create one run and exhibit the same persistence and terminal-state behavior.

## Dependencies

- **WS-20** — the loop passes tools and validates tool calls (execution is meaningful).
- **WS-22** — remote runner path is production-ready (executed runs can call real tools).
- **product-x WS-06** — the gateway `SessionBridge` / `RuntimeDelegate`.
- **product-x WS-07** — REST run routes and `SessionService`.

## Context Files (Agent MUST read before implementing)

- `c:\dev\swift-agent\CLAUDE.md` — conventions.
- `c:\dev\swift-agent\packages\runtime\src\engine.ts` — `AgentEngine.run()` (generates its own `runId`, persists via loop, holds `SessionLock`).
- `c:\dev\swift-agent\packages\runtime\src\loop.ts` — `runAgentLoop` persistence (creates run + user message, terminal transitions).
- `c:\dev\swift-agent\packages\runtime\src\session-lock.ts` — `SessionLock` (one active run per session).
- `c:\dev\swift-agent\packages\runtime\src\types.ts` — `RunContext`, `AgentEngineDeps`.
- `c:\dev\swift-agent\packages\api\src\routes\runs.ts` — current REST run routes.
- `c:\dev\swift-agent\packages\api\src\routes\traces.ts` — `GET /runs/:runId/trace` (calls `getRun` — must adopt the new signature + ownership).
- `c:\dev\swift-agent\packages\api\src\services\session-service.ts` — `createRun`, `getRun`, `getRunToolCalls`.
- `c:\dev\swift-agent\packages\api\src\server.ts` — `buildApp`, route registration, `BuildAppOptions`.
- `c:\dev\swift-agent\packages\api\src\types.ts` — `CreateRunBodySchema`.
- `c:\dev\swift-agent\packages\gateway\src\session-bridge.ts` — `handleSendMessage` → `runtime.run(...)`.
- `c:\dev\swift-agent\packages\gateway\src\types.ts` — `RuntimeDelegate`.
- `c:\dev\swift-agent\apps\server\src\container.ts` — composition (engine, services).
- `c:\dev\swift-agent\apps\server\src\main.ts` — API + gateway wiring.

## Package

`packages/api`, `packages/runtime`, `packages/gateway`, `packages/sdk`, `packages/db`, `apps/server`

> **Note:** `packages/sdk` is required (and now declared in the manifest for WS-23). Because this workstream changes the `POST /v1/sessions/:sessionId/runs` response from a full `RunRecord` to `{ runId, status }` (202), the SDK `ControlPlaneClient.createRun` — which currently does `RunRecordSchema.parse(res)` — must be updated in lockstep or it will throw. The SDK touch is minimal (client/types/app).

## Files Touched

- `packages/runtime/src/run-execution-service.ts` **(NEW)** — the single execution service (create + execute + persist).
- `packages/runtime/src/engine.ts` **(MODIFY)** — add lock-free `executePreparedRun`; re-point `run` so there is exactly one lock owner.
- `packages/runtime/src/index.ts` **(MODIFY)** — export `RunExecutionService` / factory.
- `packages/api/src/routes/runs.ts` **(MODIFY)** — `POST .../runs` → `202`; add `POST /runs/:runId/cancel`; thread `workspaceId` through the `GET`s.
- `packages/api/src/routes/traces.ts` **(MODIFY)** — `GET /runs/:runId/trace` calls `sessionService.getRun(runId)`; update it to `getRun(workspaceId, runId)` (the signature changes) and enforce ownership. Also enforce ownership on `GET /traces/:traceId/spans` (resolve `traceId`→`runId`→ownership).
- `packages/db/src/repositories/trace-repo.ts` **(MODIFY)** — add `getTraceById(traceId)` so the trace-spans route can resolve the owning run for its ownership check.
- `packages/api/src/services/session-service.ts` **(MODIFY)** — delegate run creation/execution to the execution service; add `requestCancel`.
- `packages/api/src/server.ts` **(MODIFY)** — thread the execution service into route/service wiring via `BuildAppOptions`.
- `packages/api/src/types.ts` **(MODIFY)** — response schema for accepted run (`{ runId, status }`).
- `packages/gateway/src/session-bridge.ts` **(MODIFY)** — delegate to the execution service instead of a bare `runtime.run`.
- `apps/server/src/container.ts` **(MODIFY)** — construct the execution service; expose it to API and gateway.
- `apps/server/src/main.ts` **(MODIFY)** — pass the execution service into `buildApp` and `createGatewayServer`.
- `packages/sdk/src/client.ts` **(MODIFY)** — `createRun` returns an `AcceptedRun` (`{ runId, status }`), not a full `RunRecord`; add `getRun` polling helper and `cancelRun`.
- `packages/sdk/src/types.ts` **(MODIFY)** — add `AcceptedRun` type; update `CreateRunOptions`/`runs` result types.
- `packages/sdk/src/app.ts` **(MODIFY)** — `runs.create` returns `AcceptedRun`; add `runs.cancel`.
- `packages/runtime/src/__tests__/run-execution-service.test.ts` **(NEW)** — single-run + parity tests.
- `packages/api/src/routes/__tests__/runs-async.test.ts` **(NEW)** — `202`, status polling, cancel idempotency.

## Existing Interfaces to Consume

**`AgentEngine.run` today** (`packages/runtime/src/engine.ts`):

```typescript
async *run(sessionId: string, userMessage: string, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
  const runId = generateRunId();
  const lockController = this.sessionLock.acquire(sessionId, runId);
  // loads session (must be 'active') + agent, merges signal + lock signal, builds ctx, yields* runAgentLoop(...)
}
```

**`runAgentLoop` persistence** (`packages/runtime/src/loop.ts`): creates the user message, yields `message_started`, creates the run (`deps.db.runs.create({ runId, sessionId, model })`), streams, and on completion calls `deps.db.runs.complete(...)` / `deps.db.runs.fail(...)`.

**REST `POST .../runs` today** (`packages/api/src/routes/runs.ts`): calls `sessionService.createRun(...)` (persists run+message, no execution) and returns `201` with the run.

**`SessionService.createRun` today** (`packages/api/src/services/session-service.ts`): resolves session+agent, `runRepo.create({ runId: generateRunId(), sessionId, model })`, `messageRepo.create({ ..., role:'user', content })`, returns `{ run, message }`.

**`SessionService.getRun` / `getRunToolCalls` today** (`packages/api/src/services/session-service.ts`) — **no ownership check**:

```typescript
async getRun(runId) {
  const run = await runRepo.getById(runId);
  if (!run) throw new SwiftAgentError('NOT_FOUND', `Run ${runId} not found`);
  return run;                       // returns ANY workspace's run — cross-tenant leak
},
async getRunToolCalls(runId) {
  await this.getRun(runId);
  return toolCallRepo.listByRun(runId);
},
```

These take only `runId`. `getSession(workspaceId, sessionId)` already establishes the ownership pattern (session → `agentService.getById(workspaceId, agentId)` → `NOT_FOUND` on mismatch). Ownership for a run is: `run.sessionId` → `sessionRepo.getById` → `agentService.getById(workspaceId, session.agentId)`.

**Run routes today** (`packages/api/src/routes/runs.ts`): `GET /runs/:runId` and `GET /runs/:runId/tool-calls` call `sessionService.getRun(req.params.runId)` **without** passing `workspaceId` from the authenticated request.

**Trace route today** (`packages/api/src/routes/traces.ts`): `GET /runs/:runId/trace` also calls `await sessionService.getRun(runId)` with no `workspaceId` (comment even claims auth is sufficient — it is not; the run lookup is global). Because this workstream changes the `getRun` signature to `getRun(workspaceId, runId)`, this call site **must** be updated in lockstep or it will not compile, and it must pass the authenticated `workspaceId` so cross-workspace trace reads return `404`. The sibling `GET /traces/:traceId/spans` handler is **also** a cross-tenant leak today (it lists spans for any `traceId` with no ownership check) and must be closed too.

**`TraceRepo` today** (`packages/db/src/repositories/trace-repo.ts`) exposes `getTraceByRunId(runId)`, `listSpansByTraceId(traceId)`, `saveTrace`, `saveSpans` — but **no** `getTraceById(traceId)`, so there is currently no way to resolve a `traceId` back to its `runId` for an ownership check. This workstream adds `getTraceById(traceId): Promise<TraceRecordRow | null>` (a `SELECT ... WHERE trace_id = $1`).

**Gateway `handleSendMessage` today** (`packages/gateway/src/session-bridge.ts`): `generator = this.runtime.run(sessionId, content)`; consumes and broadcasts `ChatEvent`s; on `CONFLICT` (`RUN_IN_PROGRESS`) sends error to sender only.

**`RuntimeDelegate`** (`packages/gateway/src/types.ts`): `run(sessionId, userMessage, signal?): AsyncGenerator<ChatEvent>`.

**`CreateRunBodySchema`** (`packages/api/src/types.ts`): `{ content: z.string().min(1) }`.

## Design: single execution service

The root cause of duplication is that `AgentEngine.run` mints its own `runId` and the loop persists the run/message, while REST *also* mints a `runId` and persists. The fix is one owner.

`RunExecutionService` (in `packages/runtime`) is the single authority:

```typescript
export interface StartRunInput {
  sessionId: string;
  content: string;
  metadata?: Record<string, unknown>;
}
export interface RunExecutionService {
  /** Create the run + user message eagerly, return the runId, and start
   *  process-bound execution. Callers that want to stream (gateway) pass
   *  an onEvent sink; REST omits it and polls. Returns once the run row
   *  exists (so REST can 202 immediately). */
  start(input: StartRunInput, opts?: { onEvent?: (e: ChatEvent) => void; signal?: AbortSignal }): Promise<{ runId: string }>;
  /** Idempotent cancellation request for an in-flight run. */
  requestCancel(runId: string): Promise<{ requested: boolean }>;
}
```

Key rules:
- **The service is the sole run-id + lock owner.** To avoid the current double-lock/double-id hazard (today `AgentEngine.run` mints its own `runId` and acquires its own `SessionLock`), refactor the engine to expose a **lock-free** execution entry that accepts a pre-created `runId` and does NOT touch the session lock (see step 1). `AgentEngine.run` (the legacy lock-owning wrapper) is re-pointed to go through the service so there is exactly one lock owner and one id owner. No component acquires the lock twice.
- **One `runId`, one user message.** The service creates the run row + user message once, then drives the lock-free engine entry. Both REST and gateway get identical behavior.
- **Shared lock + registry.** The service holds the `SessionLock` and the `activeRuns` registry, so concurrent runs on one session `CONFLICT` regardless of entry point and `requestCancel` can find the in-flight run.
- **Process-bound.** `start` kicks off execution with `void` (fire-and-forget) for REST; for gateway it iterates events into `onEvent`. The service keeps `Map<runId, AbortController>` so `requestCancel` can abort. Document that a process restart abandons in-flight runs (Phase 2 recovery).
- **Terminal states.** On completion/failure the loop persists terminal status (WS-24 adds `cancelled`/`timed_out`). This service ensures the run row reaches a terminal state on every exit path.

## Implementation Steps

1. **Lock-free engine entry (`packages/runtime/src/engine.ts`)**: Add `AgentEngine.executePreparedRun(runId: string, sessionId: string, userMessage: string, signal: AbortSignal): AsyncGenerator<ChatEvent>` that performs the existing session/agent loading and `yield* runAgentLoop(...)` but does **NOT** acquire the `SessionLock` and does **NOT** generate a `runId` (both are supplied by the service). Refactor the existing `AgentEngine.run` to delegate: the service becomes the lock owner, so `run` either (a) is re-pointed to call the service, or (b) remains for legacy tests but is documented as the only place that self-locks. Ensure exactly one lock acquisition per logical run.

2. **Execution service (`packages/runtime/src/run-execution-service.ts`)**: Implement `createRunExecutionService(deps: AgentEngineDeps, options?: AgentEngineOptions): RunExecutionService`. Hold a single `SessionLock` and `activeRuns = new Map<string, AbortController>()`.
   - `start`: generate `runId`; acquire the session lock (throw `SwiftAgentError(CONFLICT)` if busy → gateway maps to `RUN_IN_PROGRESS`, REST maps to `409`); create the `AbortController`, register in `activeRuns`; create the run row + user message **once** (own this instead of the loop — make the loop's `runs.create`/user-message-create a no-op-if-exists or move creation here) so REST can `202` immediately. Then drive `engine.executePreparedRun(runId, sessionId, content, signal)`. For `onEvent` callers, forward each event; for pollers, consume internally (state is persisted). Always `activeRuns.delete(runId)` and release the lock in a `finally`.
   - `requestCancel`: look up `activeRuns.get(runId)`; if present, `abort()` and return `{ requested: true }`; if absent (already terminal or unknown-in-this-process), return `{ requested: true }` idempotently (do not throw for repeated calls). Actual terminal `cancelled` status is finalized in WS-24; here cancellation aborts the signal and the loop ends.

3. **Barrel (`packages/runtime/src/index.ts`)**: Export `RunExecutionService`, `createRunExecutionService`, `StartRunInput`.

4. **API service (`packages/api/src/services/session-service.ts`)**: Replace `createRun`'s manual persistence with a delegation to the injected `runExecutionService.start({ sessionId, content })`, returning `{ runId }`. **Add workspace ownership to run reads** (required for the ownership test and to close the current cross-tenant leak): change the `SessionService` interface so `getRun(workspaceId, runId)` and `getRunToolCalls(workspaceId, runId)` take `workspaceId`, and add `requestCancel(workspaceId, runId)`. Implement a shared private helper `assertRunOwnership(workspaceId, runId): Promise<RunRecord>` that loads the run (`runRepo.getById`), loads its session (`sessionRepo.getById(run.sessionId)`), and calls `agentService.getById(workspaceId, session.agentId)` — throwing `SwiftAgentError('NOT_FOUND', ...)` if the run is missing OR belongs to another workspace (never distinguish the two, to avoid leaking existence). `getRun`/`getRunToolCalls`/`requestCancel` all call it first; `requestCancel` then calls `runExecutionService.requestCancel(runId)`.

5. **API routes (`packages/api/src/routes/runs.ts`)**: every handler must read `const { workspaceId } = req as AuthenticatedRequest` and pass it through — the current GET handlers do not, which is the cross-tenant leak.
   - `POST /sessions/:sessionId/runs`: parse `CreateRunBodySchema`; verify session ownership; call the service; return `202` with `{ runId, status: 'running' }`. Map `CONFLICT` to `409`.
   - `GET /runs/:runId`: call `sessionService.getRun(workspaceId, req.params.runId)` (returns `RunRecord`; `404` for another workspace's run) (SC-11).
   - `GET /runs/:runId/tool-calls`: call `sessionService.getRunToolCalls(workspaceId, req.params.runId)` (same `404` ownership behavior).
   - `POST /runs/:runId/cancel`: call `sessionService.requestCancel(workspaceId, req.params.runId)` (which asserts ownership → `404`); return `202` with `{ runId, status: 'cancelling' }` (or current). Idempotent — repeated calls also `202` (SC-11; full idempotency of terminal state in WS-24).

5b. **Trace routes (`packages/api/src/routes/traces.ts` + `packages/db/src/repositories/trace-repo.ts`)**:
   - Add `getTraceById(traceId): Promise<TraceRecordRow | null>` to `trace-repo.ts` (`SELECT * FROM traces WHERE trace_id = $1`), so a `traceId` can be resolved to its `runId`.
   - `GET /runs/:runId/trace`: read `const { workspaceId } = req as AuthenticatedRequest` and call `sessionService.getRun(workspaceId, req.params.runId)` — mandatory because the `getRun` signature changed (otherwise it won't compile), and it closes the cross-tenant leak (another workspace's trace → `404`). Remove the stale comment claiming auth alone is sufficient.
   - `GET /traces/:traceId/spans`: read `workspaceId`, resolve the trace via `traceRepo.getTraceById(traceId)` (→ `404` if missing), then assert ownership with `sessionService.getRun(workspaceId, trace.runId)` (→ `404` for another workspace) before returning spans. This closes the direct trace-spans cross-tenant leak.

6. **API wiring (`packages/api/src/server.ts`, `types.ts`)**: Add `runExecutionService` to `BuildAppOptions`; pass into `createSessionService`. Add an `AcceptedRunResponseSchema = z.object({ runId: z.string(), status: z.string() }).strict()` to `types.ts` and use it for the `202` body.

7. **Gateway (`packages/gateway/src/session-bridge.ts`)**: Change `SessionBridgeDeps.runtime` to the execution service (or keep `RuntimeDelegate` but back it with the service). In `handleSendMessage`, call `runExecutionService.start({ sessionId, content }, { onEvent: (e) => { buffer + broadcast } , signal })` so the gateway path and REST path share identical persistence and terminal behavior (SC-12). Preserve replay-buffer behavior and `RUN_IN_PROGRESS` handling.

8. **Server composition (`apps/server/src/container.ts`, `main.ts`)**: Construct one `runExecutionService` from the engine deps; store on `Container`. Pass it into `buildApp({ ..., runExecutionService })` and into `createGatewayServer(..., runExecutionService)` (adapting the gateway to accept the service or an adapter implementing the delegate). Ensure both entry points share the SAME service instance so the session lock and `activeRuns` registry are unified (so a REST-triggered run blocks a concurrent WS run and vice versa).

9. **SDK client (`packages/sdk/src/client.ts`, `types.ts`, `app.ts`)**: The control-plane `createRun` response changes from a full `RunRecord` to `{ runId, status }` (202). Update `ControlPlaneClient.createRun` to parse the new `AcceptedRunResponseSchema` shape instead of `RunRecordSchema.parse(res)`; add `cancelRun(runId)` calling `POST /v1/runs/:runId/cancel`. `getRun` (already present) is used for polling to a terminal state. Update `app.runs` (`create` returns `AcceptedRun`; add `cancel`) and the `CreateRunOptions`/result types in `types.ts`. Without this change the SDK would throw parsing the `202` body.

10. **Restart docs**: Add a short comment/README note in the service that execution is process-bound and in-flight runs are abandoned on restart (Phase 2 durable execution).

## Tests

1. **REST 202 + async execution (SC-11)**: `POST /v1/sessions/:id/runs` returns `202` with `{ runId }`; with a fake provider, poll `GET /v1/runs/:runId` until `completed`; assert an assistant message exists and no WebSocket was used.
2. **Single run record (SC-12)**: after a REST run, exactly one `RunRecord` exists for that logical run (no duplicate ids); the user message is persisted once.
3. **Parity REST vs WS (SC-12)**: run the same content through REST and through `SessionBridge`; assert identical persistence shape (one run, one user message, one assistant message, same terminal status semantics).
4. **Cancel idempotent (SC-11)**: `POST /runs/:runId/cancel` twice → both `202`; the run stops; a third cancel after terminal state still `202`.
5. **Concurrent-run conflict**: starting a second run on a session with an active run → `409` (REST) / `RUN_IN_PROGRESS` (gateway), shared across both entry points.
6. **Observable via existing endpoints (SC-11)**: after a tool-using REST run, `GET /runs/:runId/tool-calls` returns the tool calls and `GET /runs/:runId/trace` returns a trace (trace population depends on WS-24 tracer wiring — assert tool-calls here at minimum).
7. **Gateway still streams**: `SessionBridge` forwards `message_started`/`token`/`message_completed` via `onEvent` and buffers for replay.
8. **Ownership enforcement**: `GET /runs/:runId`, `GET /runs/:runId/tool-calls`, `GET /runs/:runId/trace`, `GET /traces/:traceId/spans`, and `POST /runs/:runId/cancel` for a run/trace owned by another workspace all return `404` (no existence leak).

## Acceptance Criteria

1. A single `RunExecutionService` in `@swiftagent/runtime` owns user-message persistence, run creation, execution, and final assistant-message persistence, used by both REST and the gateway.
2. Exactly one run record and one user message are created per logical run regardless of entry point; the previous dual-path duplication is eliminated (SC-12).
3. `POST /v1/sessions/:sessionId/runs` returns `202`, executes process-bound without a WebSocket client, and the run is observable through run, message, tool-call, and trace endpoints (SC-11).
4. `GET /v1/runs/:runId` reflects current and terminal status; `POST /v1/runs/:runId/cancel` is idempotent and returns `202`.
5. REST and WebSocket runs exhibit the same persistence and terminal-state behavior and share one session lock / active-run registry (SC-12).
6. `GET /v1/runs/:runId`, `GET /v1/runs/:runId/tool-calls`, `GET /v1/runs/:runId/trace`, and `POST /v1/runs/:runId/cancel` enforce workspace ownership (run → session → agent → workspace) and return `404` for a run in another workspace, without leaking existence.
7. Execution is documented as process-bound with restart recovery deferred to Phase 2.
8. `pnpm exec tsc --noEmit` and `pnpm exec eslint . --quiet` pass; new service and async-route tests pass.
