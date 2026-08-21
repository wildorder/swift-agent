# WS-25: Full Runtime Integration Tests

## Goal

Prove the completed registration-to-response runtime end to end against the real deployed shape: SDK-registered agents with persisted tools, provider tool-calling, secure remote SDK-runner execution, multi-turn continuation, asynchronous REST runs, streaming WebSocket runs, cancellation, timeout, SSRF rejection, replay-safe retries, and each defined failure boundary. Tests use deterministic fake model providers (no real model API calls), Testcontainers PostgreSQL (real persistence), and **real** local SDK tool-runner servers (real HTTP boundary).

**Reuse the existing integration-test infrastructure — do not invent a parallel one, and do not touch its schema bootstrap.** The repo already has a working integration harness: root `test/vitest.integration.config.ts` (globs `test/integration/**/*.integration.test.ts`, `globalSetup: ['./test/setup-db.ts']`), driven by the `pnpm test:integration` script. As of **db-migration-baseline WS-01**, `test/setup-db.ts` starts a Testcontainers PostgreSQL, sets `DATABASE_URL`, and materializes the schema by running the **real Drizzle migrator** against `packages/db/drizzle` (the committed migrations — baseline `0000` plus every incremental, including WS-19's `agents.tools` and WS-24's `run_status` values — are the single source of truth; there is no hand-written raw SQL and no `drizzle-kit push`). Therefore this workstream makes **no changes to `test/setup-db.ts`**: the entire schema (core tables, `agents.tools`, the new `run_status` values, and the `traces`/`trace_spans` tables + `span_type`/`span_status` enums already present in the baseline) is provided automatically by the migrations. This workstream only places new integration suites under root `test/integration/` with the mandatory `.integration.test.ts` suffix (so they are discovered by the integration config and get the Testcontainers globalSetup — and are NOT picked up as unit tests by the package-level `*.test.ts` default globs), adds shared helpers under `test/support/`, declares the required workspace `devDependencies` at the root, and confirms the whole monorepo type-checks, lints, and passes unit + integration tests.

## Traceability

- **SC-16** — Integration tests cover successful no-tool runs, successful remote-tool runs, multiple tool turns, cancellation, timeout, replay, SSRF rejection, and each defined failure boundary.
- **SC-17** — Monorepo type-checking, linting, unit tests, and runtime integration tests pass.

## Dependencies

- **WS-24** — all runtime behavior (tools, executor resolution, secure runner, unified execution, lifecycle hardening) is complete.
- **db-migration-baseline WS-01** (transitively via WS-19/WS-24) — `test/setup-db.ts` applies the real Drizzle migrations, and the baseline already includes the observability schema (`traces`/`trace_spans`, `span_type`/`span_status`). This workstream therefore does not bootstrap any schema itself.

## Context Files (Agent MUST read before implementing)

- `c:\dev\swift-agent\CLAUDE.md` — conventions; Vitest + Testcontainers; integration vs unit test split.
- `c:\dev\swift-agent\test\vitest.integration.config.ts` — the integration config (globs `test/integration/**/*.integration.test.ts`, `globalSetup`). New suites just need the correct path + suffix; no config change required.
- `c:\dev\swift-agent\test\setup-db.ts` — the Testcontainers globalSetup; it runs the **real Drizzle migrator** (db-migration-baseline WS-01), so the full schema is already provisioned. **Read-only reference — do NOT modify.**
- `c:\dev\swift-agent\packages\db\drizzle\0000_baseline.sql` — confirms the observability schema (`traces`/`trace_spans`, `span_type`/`span_status`) is already created by the baseline, so trace-persistence assertions work with no bootstrap changes.
- `c:\dev\swift-agent\test\integration\db.integration.test.ts` and `test\integration\management.integration.test.ts` — existing integration suites; copy their structure (naming, imports, harness usage).
- `c:\dev\swift-agent\package.json` — root `test:integration` script (`vitest run --config test/vitest.integration.config.ts`).
- `c:\dev\swift-agent\packages\api\src\__tests__\` — existing test patterns (`buildApp`, `inject`). NOTE: `helpers.ts` there provides **mocked** repos, not a real database — do NOT assume it is a Testcontainers harness; real DB persistence comes from `test/setup-db.ts`.
- `c:\dev\swift-agent\packages\runtime\src\run-execution-service.ts` — the unified service under test (WS-23).
- `c:\dev\swift-agent\packages\runtime\src\tool-executor-resolver.ts` — executor resolution (WS-21).
- `c:\dev\swift-agent\packages\runtime\src\tool-executor-remote.ts` — remote executor (WS-22).
- `c:\dev\swift-agent\packages\runtime\src\runner-credentials.ts` + `ssrf.ts` — security under test (WS-22).
- `c:\dev\swift-agent\packages\sdk\src\app.ts`, `tool-runner.ts`, `tool.ts`, `agent.ts` — real SDK runner + registration.
- `c:\dev\swift-agent\packages\gateway\src\server.ts`, `session-bridge.ts`, `types.ts` — WS run + cancel protocol (WS-23, WS-24).
- `c:\dev\swift-agent\packages\models\src\provider.ts`, `types.ts` — `ModelProvider` interface + chunk union to fake.
- `c:\dev\swift-agent\packages\shared\src\types\events.ts` — `ChatEvent` to assert on.
- `c:\dev\swift-agent\.github\workflows\ci.yml` — CI test invocation (the `integration-tests` job runs `pnpm test:integration`). The stale `pnpm --filter @swiftagent/db migrate` step and the redundant `postgres` service were already removed by db-migration-baseline WS-01 — no CI change is required here (read-only reference).

## Package

Root integration-test tree (`test/integration/`, `test/support/`) plus root `package.json` for test `devDependencies`. All new suites live at the repo root under `test/integration/` (the only location the integration config discovers), NOT inside package `src/__tests__` or package `test/` folders. **`test/setup-db.ts`, the integration config, and CI are read-only here** — the migrator-based bootstrap (db-migration-baseline WS-01) already provisions the full schema and CI is already clean.

## Files Touched

- `package.json` **(MODIFY, root)** — the new root integration suites import `@swiftagent/runtime`, `@swiftagent/models`, `@swiftagent/gateway`, `@swiftagent/sdk`, and `@swiftagent/observability`; add these as root `devDependencies` (`workspace:^`) alongside the existing `@swiftagent/api|db|shared` (and `drizzle-orm`, already added by db-migration-baseline WS-01), and refresh the lockfile (`pnpm install`). Under strict pnpm, root-level test files cannot import undeclared workspace packages.

> **No `test/setup-db.ts` change and no `.github/workflows/ci.yml` change.** db-migration-baseline WS-01 already (a) switched the test bootstrap to the real Drizzle migrator — which materializes the entire schema including the observability `traces`/`trace_spans` tables and `span_type`/`span_status` enums from `0000_baseline`, plus `agents.tools` (WS-19) and the new `run_status` values (WS-24) — and (b) removed the stale `pnpm --filter @swiftagent/db migrate` CI step and the redundant `postgres` service. Do not re-do either.
- `test/support/fake-provider.ts` **(NEW)** — deterministic `ModelProvider` yielding scripted token/tool_call/finish chunks.
- `test/support/fake-runner.ts` **(NEW)** — helper to start a real SDK tool runner with scripted tools (delay/throw/echo/counter) for local execution.
- `test/support/runtime-harness.ts` **(NEW)** — builds the real repos/services against the globalSetup `DATABASE_URL` (engine, resolver, `RunExecutionService`, composed `buildApp`/gateway) plus keypair + policy for local runners; reused by all suites.
- `test/integration/registration-to-response.integration.test.ts` **(NEW)** — no-tool run, single remote-tool run, multi-tool-turn run.
- `test/integration/executor-routing.integration.test.ts` **(NEW)** — two agents / two runners, no cross-routing (SC-07 end-to-end).
- `test/integration/runner-security.integration.test.ts` **(NEW)** — scoped-auth reject, SSRF rejection, replay-safe retry, payload bounds.
- `test/integration/lifecycle.integration.test.ts` **(NEW)** — cancellation, model/tool/total timeout, race-safe terminal state, failure finalization.
- `test/integration/rest-runs.integration.test.ts` **(NEW)** — `202` REST run, poll to terminal, cancel; observable via run/message/tool-call/trace endpoints.
- `test/integration/ws-runs.integration.test.ts` **(NEW)** — streaming WS run, cancel message, disconnect≠cancel + replay.
- `test/integration/rest-ws-parity.integration.test.ts` **(NEW)** — same content via both entry points → identical persistence (SC-12); full composed-server stack.

## Existing Interfaces to Consume

**`ModelProvider` to fake** (`packages/models/src/provider.ts`):

```typescript
export interface ModelProvider {
  generate(request: ModelRequest): AsyncGenerator<ModelStreamChunk, void, undefined>;
}
// chunk order: token* → tool_call* (fully assembled) → exactly one finish
```

**Stream chunks** (`packages/models/src/types.ts`): `{ type:'token', text }`, `{ type:'tool_call', toolName, callId, arguments }`, `{ type:'finish', finishReason, usage }`.

**`RunExecutionService`** (WS-23): `start({ sessionId, content }, { onEvent?, signal? }) → { runId }`; `requestCancel(runId) → { requested }`.

**SDK real runner**: `createAgentApp(...).listen(0)` returns `Promise<void>` and does not expose the assigned port/URL, so the harness starts the runner via **`startToolRunner(...)`** directly (it returns the `FastifyInstance`). Per WS-22 the runner verifies asymmetric scoped tokens and requires **`publicKey`**, **`expectedAudience`**, and **`expectedWorkspaceId`** at startup. Because `expectedAudience` must equal the registered `toolRunnerUrl` (WS-22 mints `aud = agent.toolRunnerUrl`) and it must be supplied *before* the server starts, **do not use `port: 0` and read the port back** — instead reserve a concrete free port first (see step 3), compute `toolRunnerUrl = http://127.0.0.1:${port}`, and pass it as `expectedAudience`. After the runner is up, register the agent with `ControlPlaneClient.registerAgent({ ..., tools, toolRunnerUrl })`. The startup signature today is `startToolRunner({ port, registry, apiKey, toolTimeoutMs? })`; after WS-22 it is `startToolRunner({ port, registry, publicKey, expectedAudience, expectedWorkspaceId, toolTimeoutMs? })`.

**Fake provider registration**: register the fake into a `ProviderRegistry` under a provider id (e.g. `fake`) so agents can use `model: 'fake/deterministic'`.

**Test DB bootstrap**: do NOT start a second Testcontainers instance and do NOT modify `test/setup-db.ts` — the integration config's `globalSetup` (`test/setup-db.ts`) already starts one PG container, sets `process.env.DATABASE_URL`, and materializes the **entire** schema by running the real Drizzle migrator (db-migration-baseline WS-01). That includes the observability `traces`/`trace_spans` tables and `span_type`/`span_status` enums (in `0000_baseline`), `agents.tools` (WS-19's migration), and the `run_status` `cancelled`/`timed_out` values (WS-24's migration). Suites/harness simply read `DATABASE_URL` and build repos via `createDbClient(process.env.DATABASE_URL)`. This workstream introduces **no** DB-bootstrap changes.

## Design Notes

- **Determinism**: the fake provider is scripted per test — e.g. "emit a tool_call for `lookupOrder` with `{orderId:'1'}`, then on the next turn emit tokens `Order shipped` and finish." This makes multi-turn tool flows reproducible without real models.
- **Real HTTP boundary**: use the real `startToolRunner` directly (not `createAgentApp().listen()`, which returns `void`), so WS-22's scoped auth, SSRF policy (loopback allowed in test policy), idempotency, and bounds are genuinely exercised.
- **SSRF test**: point an agent's `toolRunnerUrl` at a disallowed target (e.g. `http://169.254.169.254/...` or a private IP) and assert the run fails with a disallowed-target error and the run reaches a terminal `failed` state — without any request leaving to the metadata endpoint.
- **Replay-safe retry**: the point is to prove the runner de-dups on `idempotencyKey`, so the first attempt **must reach execution and cache its result** and only then fail *in transport*. Do NOT fail before execution (that would just make the retry the first real execution and prove nothing). Put a thin **fault-injecting proxy** in front of the real runner: on attempt 1 it forwards the request to the runner (which executes, increments the `counter`, and caches the result under the key), then **replaces the runner's 2xx with a 5xx / drops the connection** so the executor sees a retriable transport failure; on attempt 2 (same `idempotencyKey`) it forwards to the runner, which returns the **cached** result without re-executing, and the proxy passes it through. Assert `counter === 1` and the final result is correct.
- **Parity**: assert REST and WS produce one run row, one user message, one assistant message, and equivalent terminal status for identical input (SC-12).

## Implementation Steps

1. **Fake provider (`fake-provider.ts`)**: Implement a `createFakeProvider(script)` returning a `ModelProvider` whose `generate` yields the scripted chunks, honoring `request.signal` (abort mid-stream when signaled) and recording the `request.tools` it received (so tests can assert SC-03). Provide helpers to script: pure-text turns, tool-call turns, and slow turns (to trigger timeouts).

2. **Runtime harness (no DB-bootstrap work)**: The schema is already fully provisioned by `test/setup-db.ts` running the real migrator (baseline `0000` + WS-19 + WS-24), including the observability `traces`/`trace_spans` tables and `span_type`/`span_status` enums — so this workstream does **not** touch `test/setup-db.ts`. **Add `test/support/runtime-harness.ts`** — read `process.env.DATABASE_URL` (set by the globalSetup), build the db client + repos via `createDbClient` (including `createTraceRepo`), compose the real engine, `ToolExecutorResolver`, `RunExecutionService`, `Tracer` (wired per WS-24), `buildApp`, and gateway, generate an asymmetric keypair for runner tokens, and set the SSRF policy to `{ requireHttps: false, allowLoopback: true }` for local runners. Return handles (`{ repos, restApp, gateway, runExecutionService, keys, teardown }`). Do NOT start another Testcontainers instance and do NOT rely on `packages/api/src/__tests__/helpers.ts` (mocked repos).

3. **Fake runner helper (`test/support/fake-runner.ts`)**: Because WS-22's `startToolRunner` requires `expectedAudience` **at startup** and the audience must equal the final `toolRunnerUrl`, the port must be known **before** starting the runner (do not use `port: 0` and read it back — the audience could not then be supplied up-front). **First reserve a concrete free port** (e.g. open a `node:net` server on port 0, read `address().port`, close it, and reuse that port — or a small get-port helper), compute `toolRunnerUrl = http://127.0.0.1:${port}`, then call `startToolRunner({ port, registry, publicKey, expectedAudience: toolRunnerUrl, expectedWorkspaceId, toolTimeoutMs })` directly (not `createAgentApp().listen()`), where `expectedWorkspaceId` is the workspace the test agent is registered under (so `claims.workspaceId` matches). Expose scripted tools: `echo` (returns input), `slow` (delays > deadline), `boom` (throws), and a `counter` tool that increments a shared counter (to detect double execution). Return `{ url: toolRunnerUrl, server, counter, teardown }`. Register the agent via `ControlPlaneClient.registerAgent({ ..., tools, toolRunnerUrl })` so its `aud` matches the runner's `expectedAudience`.

4. **Registration-to-response suite (`test/integration/registration-to-response.integration.test.ts`)**:
   - No-tool run: register a tool-less agent (fake model that only emits tokens+finish); start a run; assert `completed`, one assistant message.
   - Single remote-tool run (SC-06): register an agent with an `echo` tool + real runner; fake model emits a tool_call then a final text turn; assert the tool executed remotely, `ToolCall` persisted with `tc_` id, final assistant message present, run `completed`.
   - Multi-tool-turn run: fake model emits tool_calls across two turns; assert both executed, iteration accounting correct, run `completed`.

5. **Executor routing suite (`test/integration/executor-routing.integration.test.ts`)** (SC-07 e2e): two agents pointing at two different real runners; run both (interleaved); assert each agent's calls hit only its own runner (each runner counts invocations).

6. **Security suite (`test/integration/runner-security.integration.test.ts`)** (SC-08/09/10):
   - Scoped-auth reject: tamper the minted token / let it expire → runner returns 401 → run fails with a clear error.
   - SSRF rejection (SC-09): agent `toolRunnerUrl` set to a disallowed target → run terminal `failed`; no outbound request reaches the target.
   - Replay-safe retry (SC-10): use the fault-injecting proxy (see Design Notes) so attempt 1 executes on the runner (caches result) but returns a transport 5xx, and the same-key retry returns the cached result without re-executing; assert the `counter` tool incremented exactly once. (The proxy — not the tool handler — injects the failure, so the first execution genuinely reaches and populates the runner's idempotency cache before the retry.)
   - Payload bounds (SC-09): oversized tool input rejected pre-send; oversized runner output rejected on parse.

7. **Lifecycle suite (`test/integration/lifecycle.integration.test.ts`)** (SC-13/14/15):
   - Cancellation: start a run using a `slow` tool; `requestCancel`; assert run terminal `cancelled`, tool call finalized, late completion does not overwrite.
   - Timeouts: model-hang → `timed_out`; tool-hang → tool `failed` + run terminal; total-run deadline → `timed_out`.
   - Failure finalization: `boom` tool + provider error → run `failed`, tool calls + trace finalized.
   - Race safety: cancel + completion near-simultaneously → exactly one terminal state.

8. **REST e2e (`test/integration/rest-runs.integration.test.ts`)** (SC-11): `POST /v1/sessions/:id/runs` → `202`; poll `GET /v1/runs/:runId` to terminal; assert observable via `GET /runs/:runId/tool-calls` and `GET /runs/:runId/trace`; `POST /runs/:runId/cancel` idempotent. Also assert cross-workspace `GET`/`cancel` → `404` (WS-23 ownership).

9. **WS e2e (`test/integration/ws-runs.integration.test.ts`)**: open a real WS to the gateway with a valid client token; send `send_message`; assert streamed `message_started`/`token`/`tool_call_*`/`message_completed`; send `cancel` to stop an in-flight run; verify a disconnect does not cancel and replay works on reconnect.

10. **Parity + full-stack (`test/integration/rest-ws-parity.integration.test.ts`)** (SC-12): run identical content through REST and WS against the composed server; assert one run row each, identical persistence shape, and equivalent terminal status; confirm both share the session lock (concurrent run → conflict).

11. **CI (`.github/workflows/ci.yml`) — no change**: The `integration-tests` job already runs `pnpm test:integration`, and db-migration-baseline WS-01 already removed the stale `pnpm --filter @swiftagent/db migrate` step and the redundant `postgres` service (the Testcontainers globalSetup provisions and migrates the integration DB). Just confirm `tsc --noEmit`, `eslint . --quiet`, unit tests, and integration tests are all present in the pipeline (SC-17) — do not re-edit CI.

12. **Green gate (SC-17)**: Run `pnpm -w exec tsc --noEmit`, `pnpm -w exec eslint . --quiet`, `pnpm -w test` (unit), and the integration suites locally; fix any failures surfaced across WS-19..WS-24 integration.

## Tests

(This workstream *is* tests; the list below is the required coverage matrix mapped to success criteria.)

1. Successful no-tool run → `completed` (SC-16).
2. Successful single remote-tool run → tool executed remotely, final assistant message, `completed` (SC-06, SC-16).
3. Multiple tool turns → all executed, correct iteration accounting (SC-16).
4. Executor routing: no cross-routing between two agents/runners (SC-07).
5. Scoped-auth reject (SC-08).
6. SSRF rejection (SC-09).
7. Payload/deadline bounds enforced (SC-09).
8. Replay-safe retry executes tool once (SC-10).
9. REST `202` + poll-to-terminal + observability endpoints (SC-11).
10. Streaming WS run + cancel message (SC-16).
11. Disconnect ≠ cancel + replay (SC-16).
12. REST↔WS parity: one run, identical persistence (SC-12).
13. Cancellation terminal `cancelled`, race-safe (SC-13).
14. Model/tool/total timeouts → `timed_out` (SC-14).
15. Failure finalization across run/tool-call/trace (SC-15).
16. Full monorepo type-check + lint + unit + integration green (SC-17).

## Acceptance Criteria

1. Integration tests use deterministic fake providers, the existing Testcontainers PostgreSQL globalSetup (`test/setup-db.ts`, **unmodified** — it applies the real Drizzle migrations, which provide the full schema: baseline `0000` incl. `traces`/`trace_spans` + span enums, `agents.tools` from WS-19, and the new `run_status` values from WS-24) for real persistence, and real local SDK tool-runner servers started via `startToolRunner` with a pre-reserved port, `publicKey`, and `expectedAudience` = the registered `toolRunnerUrl` (not mocks) for the HTTP boundary. All suites live under `test/integration/` with the `.integration.test.ts` suffix and are discovered only by `pnpm test:integration` (never run as unit tests).
2. The coverage matrix above is implemented: no-tool runs, remote-tool runs, multi-tool turns, executor routing, cancellation, timeouts, replay-safe retry, SSRF rejection, payload/deadline bounds, REST async runs, WS streaming runs, disconnect≠cancel, and REST↔WS parity (SC-16).
3. Each defined failure boundary (provider error, validation reject, transport failure, tool-handler error, scoped-auth failure) finalizes run/tool-call/trace records and is asserted.
4. CI runs the integration suites alongside type-check, lint, and unit tests.
5. `pnpm -w exec tsc --noEmit`, `pnpm -w exec eslint . --quiet`, unit tests, and runtime integration tests all pass (SC-17).
