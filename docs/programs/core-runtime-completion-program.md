# Swift Agent — Program Plan (Core Runtime Completion)

## Program Overview

**Product:** Swift Agent — a hosted real-time agent runtime that lets developers embed streaming, tool-calling, multi-model AI agents into any application.

**Program scope:** Complete the existing synchronous execution path so SDK-registered agents can expose tools to model providers, execute tool calls through the correct customer-hosted runner, and finish runs consistently through WebSocket or REST entry points.

---

## Strategic Goals

1. **Complete registration-to-response execution** — Make SDK tool declarations survive registration, reach model providers, execute remotely, and return results to the model loop.
2. **One authoritative run lifecycle** — Give REST and WebSocket entry points the same execution service, persistence behavior, and terminal states.
3. **Safe remote execution** — Bound and authenticate calls to customer-hosted runners without exposing internal network targets or duplicating side effects.
4. **Predictable failure behavior** — Propagate cancellation and deadlines through model and tool boundaries while preserving consistent database and event state.
5. **End-to-end confidence** — Test the complete deployed-runtime shape with deterministic providers and real SDK runner servers.

---

## Architecture Changes

The current system already contains provider adapters, a core loop, local and remote tool executors, an SDK runner, run persistence, REST routes, and a WebSocket gateway. This program connects and hardens those components; it does not replace the existing runtime architecture.

### 1. Persisted Tool Contracts

Agent records gain normalized tool definitions containing the tool name, description, and JSON input schema. SDK execution handlers remain in customer infrastructure and are never serialized.

Agent registration becomes authoritative and idempotent for model configuration, tool definitions, and runner configuration. Existing agents without persisted tools remain valid and default to an empty tool list.

### 2. Provider Tool Plumbing

Every applicable model request receives the persisted tool definitions. Provider adapters continue translating the normalized contract into provider-specific request formats and normalize streamed calls back into the runtime protocol.

Before execution, the runtime verifies that the requested tool belongs to the registered agent and validates its input against the persisted schema. Provider-native call identifiers are retained for provider conversation round-tripping while Swift Agent uses its own `tc_` identifier for persistence.

### 3. Per-Agent Executor Resolution

The server-wide empty `LocalToolExecutor` is replaced with executor resolution based on the active agent:

- An agent with SDK runner configuration uses `RemoteToolExecutor`.
- Explicit platform-internal or test tools may use `LocalToolExecutor`.
- Missing or invalid execution configuration fails before invocation.
- Executor selection is scoped to the active agent so one agent cannot route calls to another agent's runner.

### 4. Remote SDK Runner Path

The existing remote executor and SDK runner become the production customer-tool path. Requests include stable invocation identity and the session, run, call, user, and metadata context required by handlers.

The boundary gains:

- Short-lived, narrowly scoped runner credentials rather than reuse of the workspace API key
- HTTPS and outbound-target validation to mitigate SSRF
- Request and response schema validation
- Bounded input, output, and error payloads
- Idempotency keys for transport retries
- Abort and deadline propagation
- Stable transport, validation, timeout, and handler error mapping

Automatic retries are allowed only when invocation identity makes replay safe. A timeout does not imply that customer-side work was rolled back.

### 5. Unified Run Execution

A single application service owns user-message persistence, run creation, execution, terminal transitions, and final assistant-message persistence. Both REST and WebSocket entry points invoke this service.

REST semantics:

- `POST /v1/sessions/:sessionId/runs` persists the user message, creates and starts the run, and returns `202 Accepted`.
- `GET /v1/runs/:runId` exposes current and terminal status.
- `POST /v1/runs/:runId/cancel` requests cancellation and is idempotent.
- Completed output is retrieved through existing run, message, tool-call, and trace endpoints.
- REST execution does not require an active WebSocket connection.

Execution remains process-bound. Recovery after a service restart belongs to the Phase 2 durable execution layer.

### 6. Lifecycle Hardening

The run state model distinguishes:

- `running`
- `completed`
- `failed`
- `cancelled`
- `timed_out`

Cancellation and timeout propagate through an `AbortSignal` to providers and executors. Terminal transitions are conditional and idempotent so late provider or runner responses cannot overwrite terminal state. Tool-call and trace state is finalized before a run emits or returns its terminal result.

WebSocket clients gain an explicit cancellation message. Disconnect behavior is defined independently from cancellation: a disconnected client does not automatically cancel a server-owned run unless the protocol explicitly requests it.

### 7. MCP Compatibility Boundary

MCP is not introduced in this program. The executor and normalized tool-contract boundaries must remain protocol-neutral so a future `McpToolExecutor` can add MCP discovery and invocation without replacing Swift Agent's sessions, run lifecycle, model loop, persistence, streaming, or observability.

The custom SDK runner remains the primary execution path for customer-defined TypeScript tools.

---

## Technology Choices

No new technology — uses the existing TypeScript, Fastify, Drizzle, Zod, Vitest, Testcontainers, model-provider, runtime, SDK, and observability packages.

---

## Workstreams

| ID | Workstream | Dependencies | Estimated Effort |
|----|-----------|--------------|-----------------|
| WS-19 | Persisted Tool Definition Contract | db-migration-baseline WS-01, product-x WS-02, WS-03, WS-07, WS-08 | M |
| WS-20 | Provider Tool-Calling Completion | WS-19, product-x WS-04b, WS-05b | M |
| WS-21 | Per-Agent Executor Resolution | WS-19, product-x WS-05a, WS-11 | S |
| WS-22 | Secure Remote SDK Runner Integration | WS-20, WS-21, product-x WS-08 | M |
| WS-23 | Unified Run Execution and REST Semantics | WS-20, WS-22, product-x WS-06, WS-07 | M |
| WS-24 | Cancellation, Timeout, and Failure Hardening | WS-23, db-migration-baseline WS-01, product-x WS-10 | M |
| WS-25 | Full Runtime Integration Tests | WS-24 | M |

**Size key:** S = 1-2 days, M = 3-5 days, L = 5-10 days

> **Prerequisite — Drizzle greenfield baseline (db-migration-baseline WS-01).** Before this program builds, the DB migration baseline is complete: a full greenfield `0000_baseline.sql` (+ snapshot + one-entry journal) materializes the entire current schema from empty, `packages/db` exposes `db:generate` (`tsc && drizzle-kit generate`) and `migrate` scripts, `test/setup-db.ts` provisions the integration schema by running the **real migrator**, and CI's stale migrate step / redundant `postgres` service are removed. Consequently, every schema change in this program (WS-19's `agents.tools`, WS-24's `run_status` values) is a **generated incremental migration** layered on the baseline — never hand-written `IF NOT EXISTS` DDL, and never a hand-edited test-schema block. Targets fresh databases; already-provisioned environments are reconciled out-of-band.

### Workstream Details

**WS-19 — Persisted Tool Definition Contract**

Add the normalized tool-definition schema and the agent-tools persistence migration (a `db:generate`-produced incremental migration layered on the greenfield baseline; the test bootstrap picks it up automatically via the migrator). Include tools in SDK registration, control-plane validation, repository create/update/read operations, and API responses. Preserve JSON Schema without serializing handlers. Add backward-compatible defaults and contract tests. Touches `packages/shared`, `packages/db`, `packages/api`, and `packages/sdk`.

**WS-20 — Provider Tool-Calling Completion**

Pass registered tools into model requests and enforce the registered-tool allowlist before execution. Normalize provider-native call identifiers and argument validation while retaining the identifiers each provider requires for tool-result round trips. Correct model-round iteration accounting and emit tool-start events when calls become actionable. Touches `packages/models` and `packages/runtime`.

**WS-21 — Per-Agent Executor Resolution**

Introduce an agent-aware executor resolver and remove unconditional local-executor selection from server composition. Keep local execution explicit for internal and test use. Verify that concurrent agents with different runners cannot cross-route calls. Adds an interim runner-auth env key. Touches `packages/runtime`, `packages/shared`, and `apps/server`.

**WS-22 — Secure Remote SDK Runner Integration**

Complete the hosted runtime-to-SDK runner path. Align the request context contract, introduce scoped runner authentication, outbound URL protections, idempotent invocation identity, bounded payloads, response validation, deadline/abort support, and stable error mapping. Touches `packages/shared`, `packages/runtime`, `packages/sdk`, and `apps/server`.

**WS-23 — Unified Run Execution and REST Semantics**

Create one execution service used by REST and WebSocket entry points. Implement asynchronous REST run creation, polling, idempotent cancellation requests, workspace-ownership enforcement on run/tool-call/trace/cancel routes (adding a `getTraceById` repo lookup), and consistent message/run/tool-call persistence without duplicate run records. Keep execution process-bound and document restart behavior. Touches `packages/api`, `packages/runtime`, `packages/gateway`, `packages/sdk` (client parses the new 202 response), `packages/db` (trace lookup), and `apps/server`.

**WS-24 — Cancellation, Timeout, and Failure Hardening**

Extend run statuses (adding `cancelled`/`timed_out` via a `db:generate`-produced incremental enum migration on the baseline), propagate abort signals, enforce model/tool/total-run deadlines, make terminal transitions race-safe, and finalize tool-call and trace records on every exit path. Add WebSocket cancellation while ensuring ordinary disconnects do not silently redefine server-owned run semantics. Touches `packages/shared`, `packages/db`, `packages/runtime`, `packages/gateway`, and `packages/observability`.

**WS-25 — Full Runtime Integration Tests**

Exercise registration, persisted tools, provider tool calls, remote runner execution, multi-turn continuation, REST runs, WebSocket runs, cancellation, timeout, SSRF rejection, replay-safe retries, and failures using deterministic fake providers, Testcontainers PostgreSQL, and real local SDK runner servers. Adds suites under the root `test/integration/` tree (with `.integration.test.ts` suffix) plus shared helpers in `test/support/`, and declares the required workspace `devDependencies` at the root. The Testcontainers schema is provided entirely by the migrator (via the baseline plus WS-19/WS-24 migrations), so this workstream does **not** modify `test/setup-db.ts`; CI already runs the integration suite (no CI change needed). (All new integration suites live at the repo root — the only location the integration config discovers — not inside package folders.)

---

## Dependency Graph

```text
product-x foundation
         │
         ▼
WS-19 Persisted Tool Contract
  ├──→ WS-20 Provider Tool Calling ──┬─────────────┐
  └──→ WS-21 Executor Resolution ────┴──→ WS-22 Remote Runner ─┐
       (WS-22 needs WS-20's tc_ id and WS-21's resolver)       │
                                                               ▼
                                                   WS-23 Unified Run Execution
                                     │
                                     ▼
                         WS-24 Lifecycle Hardening
                                     │
                                     ▼
                         WS-25 Integration Tests
```

WS-20 can proceed in parallel with WS-21 after WS-19, but WS-22 requires **both** WS-20 (for the `tc_` call id used as the idempotency key / context `callId`) and WS-21 (the executor resolver).

---

## Critical Path

**WS-19 → WS-21 → WS-22 → WS-23 → WS-24 → WS-25**

Minimum timeline: approximately 17-27 working days. WS-20 runs in parallel with the executor track and must complete before WS-23.

---

## Scope (In)

- Persisted SDK tool names, descriptions, and JSON input schemas
- Backward-compatible agent schema migration
- Provider-specific tool-definition translation
- Registered-tool allowlisting and argument validation
- Provider call-ID and internal `tc_` ID separation
- Agent-specific executor selection
- Deployed remote SDK tool execution
- Scoped runner authentication
- Runner SSRF protections and bounded payloads
- Replay-safe remote invocation semantics
- Shared REST/WebSocket execution service
- Asynchronous REST run creation and polling
- Idempotent run cancellation
- Model, tool, and total-run deadlines
- Explicit cancelled and timed-out states
- Atomic terminal-state persistence
- Complete tool-call, trace, and assistant-message finalization
- Full registration-to-response integration coverage

## Scope (Out)

- MCP client or server implementation
- Durable execution across process restarts
- Queued or scheduled workflows
- Automatic model fallback
- General tool retry policies beyond replay-safe transport handling
- Parallel tool-call execution
- Hosted customer secrets management
- Usage metering or billing
- Summary-memory implementation
- New model providers
- Public gateway load-balancer routing

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Provider tool formats and call identifiers diverge | High | Maintain one normalized schema while preserving provider-native call IDs; add adapter contract tests |
| Cancellation races with model or tool completion | High | Use shared abort ownership and conditional terminal-state updates |
| Customer runner becomes unavailable mid-run | High | Bound deadlines, persist failed tool calls, and produce deterministic terminal state |
| Runner URL targets internal infrastructure | High | Require HTTPS in deployed environments and block loopback, link-local, private, and metadata targets after DNS resolution |
| Transport retry duplicates a mutating tool | High | Use stable invocation idempotency keys and do not retry without replay protection |
| Runner credential grants unrelated workspace access | High | Use short-lived credentials scoped to the run, agent, tool, and expiration |
| REST execution is lost on service restart | Medium | Document process-bound semantics and reserve recovery for the durable execution program |
| Existing registrations lack tool definitions | Medium | Default missing tools to an empty list and use a backward-compatible migration |
| Duplicate REST requests create duplicate runs | Medium | Define and test request idempotency behavior |
| Dynamic MCP adoption later changes discovery semantics | Low | Keep normalized tool contracts and executor routing protocol-neutral; implement MCP as a future adapter |

---

## Success Criteria

- **SC-01:** SDK registration persists the normalized name, description, and input schema for every declared tool without persisting execution handlers.
- **SC-02:** Existing agents without persisted tools remain readable and behave as agents with an empty tool list.
- **SC-03:** OpenAI, Anthropic, and Google provider requests receive the registered tool definitions on every applicable model turn.
- **SC-04:** A model-emitted tool call is rejected before execution when its name is not registered or its input does not satisfy the persisted schema.
- **SC-05:** Provider-native call identifiers round-trip correctly while every persisted tool call uses a Swift Agent `tc_` identifier.
- **SC-06:** A registered tool call is persisted, executed by the active agent's remote SDK runner, returned to the model, and followed by a final assistant response.
- **SC-07:** Two agents with different runner configurations use their respective executors without cross-routing.
- **SC-08:** Runner requests use short-lived scoped authentication and reject unauthorized, expired, or scope-mismatched calls.
- **SC-09:** Deployed remote execution rejects disallowed outbound targets and enforces request, response, and deadline limits.
- **SC-10:** A retried remote invocation cannot execute the same logical tool call more than once when transport replay protection is enabled.
- **SC-11:** REST run creation returns `202`, executes without a WebSocket client, and remains observable through run, message, tool-call, and trace endpoints.
- **SC-12:** REST and WebSocket entry points create one run and exhibit the same persistence and terminal-state behavior.
- **SC-13:** Repeated cancellation requests are safe, and a cancelled run cannot later transition to completed, failed, or timed out.
- **SC-14:** Model, tool, and total-run deadlines abort supported work and persist `timed_out` state.
- **SC-15:** Provider, validation, transport, and tool-handler failures finalize run, tool-call, and trace records consistently.
- **SC-16:** Integration tests cover successful no-tool runs, successful remote-tool runs, multiple tool turns, cancellation, timeout, replay, SSRF rejection, and each defined failure boundary.
- **SC-17:** Monorepo type-checking, linting, unit tests, and runtime integration tests pass.
