# Swift Agent — As-Built System Snapshot
<!-- Last updated: 2026-07-17 after programs: product-x, management-api, core-runtime-completion, persist-observe, realtime-cloud-delivery -->

## Packages & Key Exports

pnpm/Turborepo TypeScript monorepo with nine library packages and one
deployable server application.

### @swiftagent/shared (`packages/shared`)

Key exports: `ENV_KEYS`, `loadConfig`, `ChatEvent`/`ChatEventSchema` and entity
Zod schemas, ID generators, event constants, `SwiftAgentError`,
`createRedisClient`, and the versioned, byte-bounded **runner protocol**
(`RunnerRequestSchema`, `RunnerSuccessResponseSchema`,
`RunnerErrorResponseSchema`, `RUNNER_PROTOCOL_VERSION`, `RUNNER_MAX_*_BYTES`).
`ENV_KEYS` retains `GATEWAY_PORT` (default 3001) for the standalone gateway,
though the unified server no longer binds it.

### @swiftagent/db (`packages/db`)

Key exports: `createDbClient`; all Drizzle tables; factory repositories for
workspaces, API keys, agents, sessions, messages, runs, tool calls, traces,
users, and user-workspace memberships; a `migrate` entry point
(`dist/migrate.js`) with a drift preflight guard; and migration-tooling exports
(`queryAppliedMigrations`, `computeMigrationStatus`, `renderStatusTable`,
`checkDrift`, `introspectLiveSchema`, `projectSnapshot`, `diffSchemas`,
`planPreflight`, `loadJournal`, `loadSnapshot`). The trace repo implements the
observability `TraceSink` (`saveTraceWithSpans` atomic path, `getTraceByRunId`,
`getTraceById`, `listSpansByTraceId`).

### @swiftagent/models (`packages/models`)

Key exports: `ModelProvider`, `ProviderRegistry`, `parseModelString`,
`createOpenAIProvider`, `createAnthropicProvider`, `createGoogleProvider`, and
model stream chunk schemas. Providers translate the normalized tool contract
into provider-specific requests and normalize streamed tool calls back to the
runtime protocol, preserving provider-native call IDs.

### @swiftagent/runtime (`packages/runtime`)

Key exports: `AgentEngine`, `runAgentLoop`, `createRunExecutionService`
(unified REST/WS run owner), local and remote tool executors,
`createToolExecutor`, `createToolExecutorResolver` (per-agent executor
selection), scoped runner credentials (`mintRunnerToken`,
`importRunnerPrivateKey`), SSRF guards (`resolveAllowedOutboundTarget`,
`createPinnedDispatcher`, `isDisallowedAddress`), deadline helpers, last-N and
summary memory strategies, `SessionLock` (process-bound), and `ContextBuilder`.

### @swiftagent/gateway (`packages/gateway`)

Key exports: `registerGatewayPlugin` (mounts `@fastify/websocket` + `/v1/stream`
onto a host Fastify app and returns `GatewayComponents`), `createGatewayServer`/
`startGateway` (standalone form, own port + `/health` + signal handlers),
`ConnectionManager`, `SessionBridge`, `HeartbeatManager`, `ChannelRegistry`
(ref-counted per-session Redis subscription), client-token validation,
Redis/no-op pub-sub adapters (now with a `ping()` method), and the inbound
WebSocket protocol (`send_message`, `ping`, `cancel`). Both the standalone
server and the plugin share one `/v1/stream` implementation via internal
`buildGatewayComponents` + `registerStreamRoute`. The gateway delegates run
execution to the shared `RunExecutionService`.

### @swiftagent/api (`packages/api`)

Key exports: `buildApp` (accepts `registerRootHealth?: boolean` so a host can
own the composed `/health`), token/agent/session services, control-plane and
management API schemas (incl. `RunMetricsResponseSchema`), API-key auth, and
Cognito JWT auth. Session creation returns the canonical
`websocketUrl = \`${publicWebsocketUrl}?token=${clientToken}\``. Run creation is
asynchronous (`202`). A `LOCAL_ONLY_WEBSOCKET_URL` (`ws://localhost:3001`)
constant is the standalone/local default only — the cloud guard rejects it.

### @swiftagent/observability (`packages/observability`)

Key exports: `Tracer`, `Span`, `RunTraceContext`, `createTracedLogger`,
`deriveRunMetrics` (latency/token/count roll-ups over a span set),
`boundSpanRecord` (+ `MAX_SPAN_ERROR_MESSAGE_CHARS`, `MAX_SPAN_METADATA_BYTES`),
and trace record/sink types. `Tracer.startRunTrace` opens a root span and
produces `startModelCall` / `startToolCall` child spans; `finish` commits the
trace + spans atomically via the sink, bounding oversized error/metadata
payloads first.

### @swiftagent/sdk (`packages/sdk`)

Key exports: `createAgentApp`, `defineAgent`, `tool`, `startToolRunner`, and
`ControlPlaneClient`. Tool schemas are registered (handlers never serialized);
the runner verifies scoped runner tokens and enforces the runner protocol; the
client parses the `202` async-run response.

### @swiftagent/react (`packages/react`)

Key exports: `createChatSession`, `useAgentChat`, `useConnection`,
`chatReducer`, and chat/client types. `createChatSession` consumes the
API-provided `websocketUrl` verbatim (canonical `wss://<host>/v1/stream?token=`),
appends a `token` to a bare base only via `URL`/`URLSearchParams` (no double-`?`,
no redundant `sessionId`), and **throws** when `websocketUrl` is missing (the
wrong `wss://api.swiftagent.dev/ws` default was removed).

### @swiftagent/server (`apps/server`)

Key exports: `startServer`, `buildContainer`, `loadServerConfig`,
`validatePublicWebsocketUrl`, `redactConfig`, and combined health checks.
`buildContainer` wires repositories, providers, the tracer, the per-agent
executor resolver, and the unified run execution service. Startup builds **one**
Fastify app: `buildApp(..., { registerRootHealth: false })`, then
`registerGatewayPlugin(api.app, …)`, then a composed `/health` (DB + Redis PING +
live gateway connections), then a **single** `listen` on `API_PORT` (3000)
serving REST + WebSocket. Graceful shutdown is one consolidated path (drain
sockets `1001` → clear heartbeats → close app → shutdown session bridge → close
DB). `validatePublicWebsocketUrl` fails startup fast in cloud envs (`DEPLOY_ENV`
∈ dev/staging/prod) when the URL is missing, non-`wss:`, or localhost.

## Data Model

- `workspaces`: `workspace_id` text PK, `name`, `created_at`, `updated_at`.
- `api_keys`: `api_key_id` text PK, `workspace_id` FK, `key_hash`, `name`,
  timestamps including nullable `revoked_at`.
- `agents`: `agent_id` text PK, `workspace_id` FK, `name`, `model_config`
  JSONB, `system_prompt`, `memory_config` JSONB, **`tools` JSONB (NOT NULL,
  default `'[]'`)**, nullable `tool_runner_url`, timestamps; unique
  workspace/name.
- `sessions`: `session_id` text PK, `agent_id` FK, nullable `user_id`,
  `status` enum, `metadata` JSONB, timestamps.
- `messages`: `message_id` text PK, `session_id` FK, nullable `run_id` FK,
  `role` enum, `content`, `created_at`.
- `runs`: `run_id` text PK, `session_id` FK, `status` enum, `model`,
  nullable `token_usage` JSONB, timestamps.
- `tool_calls`: `call_id` text PK (`tc_` Swift Agent identity), `run_id` FK,
  `tool_name`, `input` JSONB, nullable `output` JSONB, `status` enum,
  timestamps. Provider-native call IDs are carried in message content for
  round-tripping, not stored as the primary key.
- `traces`: `trace_id` text PK, unique `run_id` FK, `root_span_id`,
  start/completion timestamps, nullable total duration.
- `trace_spans`: `span_id` text PK, `trace_id` FK, nullable parent, type/name,
  timing, metadata, status, and nullable error.
- `users`: `user_id` text PK, unique `cognito_sub`, `email`, timestamps.
- `user_workspaces`: composite user/workspace PK, both FKs, `role`,
  `created_at`.

Enums: session status (`active`, `closed`), **run status (`running`,
`completed`, `failed`, `cancelled`, `timed_out`)**, message role, tool-call
status, span type, and span status.

**Migrations & tooling:** A greenfield Drizzle baseline exists — `0000_baseline`
(full schema from empty) plus incremental `0001` (`agents.tools`) and `0002`
(`run_status` adds `cancelled`/`timed_out`), with a populated `_journal.json`.
`db:generate` runs `tsc && drizzle-kit generate`. Migration operations are
drift-aware:

- `db:status` — ordinal-zips the journal against the
  `drizzle.__drizzle_migrations` bookkeeping table and prints APPLIED/PENDING.
- `db:check` — introspects the live schema, normalizes it and the latest
  committed snapshot into one canonical model, and diffs structurally.
- `migrate` runs `db:check`'s logic as a **preflight** and aborts on drift;
  `MIGRATE_SKIP_DRIFT_CHECK=1` overrides with a loud warning.

Integration tests provision the schema via the real migrator (Testcontainers).
Rollback is forward-fix + snapshot/restore per the migrations runbook (no
down-migrations). Realtime-cloud-delivery added **no** schema/migration change.

## API Endpoints

### Control plane (`/v1/*`, API key bearer authentication)

- `GET /v1/health`: liveness.
- `POST /v1/agents`: register or update an agent (persists tool definitions).
- `GET /v1/agents` / `GET /v1/agents/:agentId`: list/filter/get agents.
- `POST /v1/sessions`: create a session, short-lived client token, and the
  canonical `websocketUrl`.
- `GET|PATCH /v1/sessions/:sessionId`: get or update a session.
- `GET /v1/sessions/:sessionId/messages`: paginated history.
- `POST /v1/sessions/:sessionId/runs`: persist a user message, create + start
  an async process-bound run, return **`202`**; a concurrent active run yields
  `409`.
- `GET /v1/runs/:runId`: get current/terminal run status.
- `POST /v1/runs/:runId/cancel`: idempotent cancellation, returns `202`.
- `GET /v1/runs/:runId/tool-calls`: list tool calls.
- `GET /v1/runs/:runId/trace`: get trace with nested spans (`404` if none).
- `GET /v1/runs/:runId/metrics`: token/latency/span-count roll-ups computed on
  read (`404` if no trace).
- `GET /v1/traces/:traceId/spans`: list trace spans.
- `GET /health`: composed server health (DB + Redis PING + gateway connections).

Run, tool-call, trace, and cancel routes enforce workspace ownership (`404`
for a foreign workspace's run — no existence leak).

### Management (`/v1/management/*`, Cognito JWT authentication)

- `GET /me`: return or JIT-provision the current user.
- `POST|GET /workspaces`: create a workspace or list memberships.
- `GET /workspaces/:id`: get a member workspace.
- `POST|GET /workspaces/:id/keys`: create a one-time raw API key or list metadata.
- `DELETE /workspaces/:id/keys/:keyId`: soft-revoke a key.

Management routes register only when Cognito issuer and client ID are present.

### WebSocket gateway (unified onto the public API port, 3000)

- `GET /v1/stream?token=<client-jwt>`: authenticated bidirectional stream, now
  served by the **same** Fastify instance/port as REST and reachable through the
  existing ALB target. Canonical client URL: `wss://<host>/v1/stream?token=<jwt>`.
  The gateway reads only `?token=` and derives `sessionId` from JWT claims.
- The standalone `createGatewayServer` still serves its own `/health` for local
  dev / tests, but the deployed unified server uses the composed `/health` above.

## Protocols / Events

- Outbound `ChatEvent`: `message_started`, `token`, `tool_call_started`,
  `tool_call_completed`, `message_completed`, and `run_failed`. `run_failed`
  carries a `code`/`message` (and `cause`); cancellation/timeout reuse it with
  `CANCELLED` / `TIMED_OUT` codes.
- Inbound messages: `send_message`, `ping` (→ `pong`), and explicit `cancel`.
  A socket disconnect does **not** cancel a server-owned run.
- Runner protocol: versioned request/response envelope with bounded payloads.
- Client tokens are HS256 JWTs; runner tokens are short-lived RS256 JWTs scoped
  per invocation to `aud`/workspace/agent/run/call.
- **Redis fanout (single-task MVP):** local `ConnectionManager.broadcast` is
  authoritative for locally-connected sockets. `session:{sessionId}` pub/sub is
  managed by a **ref-counted `ChannelRegistry`** — one subscription per session
  per instance (subscribe on first socket, unsubscribe on last), and its
  forward path delivers only *peer-instance* events, so an instance never
  re-delivers its own publishes (no double-delivery). Cross-instance delivery is
  dormant/Phase 2. `/health` reports Redis via a real `PING` (`ok`/`error`/
  `disabled`; 503 when enabled-but-unreachable).
- Model identifiers use `provider/model-id`; runtime API keys use `ak_` secrets
  with SHA-256 hashes; management identity uses Cognito RS256 JWTs via JWKS.

## Runtime Loop

`runAgentLoop` is the async generator that owns a run: it persists the user
message + run (unless an upstream `RunExecutionService` prepared them), streams
tokens, passes registered tool schemas to the provider each turn, allowlists +
JSON-schema-validates each tool call before execution, executes via the
per-agent-resolved executor, and finalizes tool calls, the trace, and the
terminal run state on every exit path. Model, per-tool, and total-run deadlines
propagate through a merged `AbortSignal`; terminal transitions are conditional
(`WHERE status='running'`) so the first cause wins. Model spans carry
`promptTokens`/`completionTokens` metadata; failed best-effort trace writes are
logged with run/trace ids rather than swallowed.

## Infrastructure

- `docker-compose.yml`: PostgreSQL 16, Redis 7, and the server for local use.
- `apps/server/Dockerfile`: multi-stage Node 22 image now exposing **only port
  3000** (the stale 3001 was removed); env differentiation is 100% runtime.
- `.github/workflows/ci.yml`: build/lint, unit tests, then integration tests
  (Testcontainers Postgres) plus a schema **drift guard** step.
- **Deploy workflows** (`deploy-dev`/`deploy-staging`/`deploy-prod`): GitHub
  OIDC → ECR → Terraform → migrate. Docker build+push is now **normalized** —
  every env runs `docker build -f apps/server/Dockerfile …` against the single
  canonical `ECR_REPOSITORY: swiftagent/server` (staging/prod added the
  "Ensure ECR repository exists" step). Each env runs the `/health` curl smoke
  **and** a new **`Realtime smoke test`** step (`pnpm smoke:realtime`) after
  service stability; a realtime failure **blocks the deploy** (for prod, before
  the release-tag step).
- **Realtime smoke** (`test/smoke/realtime-smoke.ts`, run via `pnpm
  smoke:realtime`): reads `SMOKE_BASE_URL`/`SMOKE_API_KEY`/`SMOKE_AGENT_NAME`,
  does `POST /v1/sessions` → WS connect to the returned `websocketUrl` →
  `send_message` → asserts `message_started`→`token`→`message_completed` (via
  `ChatEventSchema`), bounded by timeouts + ≤3 retries, exiting non-zero with
  captured diagnostics. Reuses `test/support/ws-client.ts`.
- **Terraform** stacks compose networking, RDS, ElastiCache, ECR, SSM secrets,
  Cognito, IAM, ALB, ECS, and optional Route 53/ACM DNS. Realtime additions:
  `PUBLIC_WEBSOCKET_URL` SSM **String** param (per-env `wss://…/v1/stream`,
  derived from DNS/ALB) injected into ECS; a `DEPLOY_ENV` plain env always set
  to the environment name; ECS container `stopTimeout` (var, default 30) and
  target-group `deregistration_delay` (var, default 30) sized for socket drain;
  ALB `idle_timeout = 3600` + `lb_cookie` stickiness preserved; ECS
  `desired_count = 1` and `enable_autoscaling = false` pinned in **all** envs
  (single-task MVP, AD-02).
- `docs/runbooks/migrations.md`: rollback/reconciliation. `docs/runbooks/
  realtime-operations.md`: single-task posture, process-local replay buffer,
  process-bound session lock, in-flight-run abandonment on restart,
  reconnect-replay semantics, Redis health, and the Phase 2 boundary.
- `infra-plan.yml` plans all envs; `publish-sdks.yml` publishes SDKs.

## Known Limitations / Tech Debt

- **Single-task realtime MVP (AD-02).** `desired_count = 1`; the replay buffer is
  process-local (lost on restart), the session lock is process-bound, in-flight
  runs are abandoned on restart, and the Redis fanout path is wired but delivers
  nothing cross-instance. Horizontal scale (cross-instance streaming, shared
  lock, durable replay) is Phase 2.
- **`LOCAL_ONLY_WEBSOCKET_URL` still lives in `@swiftagent/api`** (Contract B):
  a single commented `ws://localhost:3001` default, unreachable in cloud because
  the `apps/server` startup guard rejects localhost/non-`wss:` first.
- **No reverse (down) migrations** — rollback is forward-fix + snapshot/restore.
- **Deployed-drift reconciliation is operator-driven**; drift check is
  structural-only.
- `SummaryMemoryStrategy` is still a pass-through stub (logs a warning).
- Management routes silently disappear when Cognito configuration is absent.
- JIT user race handling does not implement the planned DB conflict clause.
- Dev deployment retains temporary Terraform state-reconciliation steps.
- Management integration tests use local JWKS rather than a live Cognito pool.
- Realtime smoke depends on a per-env `SMOKE_API_KEY` secret and a seeded
  streaming agent (`smoke-echo`) being provisioned in each environment.
- Execution is process-bound: in-flight runs are abandoned on restart (durable
  recovery is the Phase 2 durable execution layer).
- `AGENTS.md` is absent; conventions live only in `CLAUDE.md`.

## Programs Completed

- `product-x` — 2026-07-15: Built the runtime monorepo, dual-port REST and
  WebSocket service, provider abstraction, SDKs, persistence, CI, Docker, and
  AWS ECS infrastructure.
- `management-api` — 2026-07-15: Added Cognito identity, user/workspace
  membership, API key lifecycle management, seven management endpoints, and
  Cognito Terraform resources.
- `core-runtime-completion` — 2026-07-16: Completed the registration→model→
  remote-tool→response path. Persisted agent tool contracts, provider
  tool-calling with `tc_`/provider-native ID separation, per-agent executor
  resolution, secure remote SDK runner execution, a unified REST/WebSocket run
  execution service with `202` async runs, cancellation/timeout/failure
  hardening, tracer wiring, the Drizzle baseline, and runtime integration tests.
- `persist-observe` — 2026-07-16: Made DB evolution and observability
  production-safe. Added `db:status`/`db:check` + structural drift detection, a
  `migrate` drift preflight, a CI drift guard, normalized deployed migrate
  paths, a migrations runbook; surfaced run metrics; hardened trace persistence;
  and added migration + observability integration suites.
- `realtime-cloud-delivery` — 2026-07-17: Made the realtime runtime publicly
  reachable and verifiable. Unified REST + WebSocket onto a single port (3000)
  via `registerGatewayPlugin` (gateway mounted on the API app; consolidated
  startup + graceful socket-draining shutdown); established the canonical
  `wss://<host>/v1/stream?token=<jwt>` contract; provisioned `PUBLIC_WEBSOCKET_URL`
  through SSM/ECS with fail-fast cloud startup validation (`DEPLOY_ENV` guard);
  tuned ALB/ECS drain (`stopTimeout`/`deregistration_delay`) and pinned
  `desired_count = 1`; corrected Redis fanout with a ref-counted `ChannelRegistry`
  and wired a real Redis `PING` into `/health`; aligned the React SDK + docs to
  the canonical URL (safe `URL` construction, dropped redundant `sessionId`);
  normalized the staging/prod Docker build path; and added a deploy-blocking
  realtime WebSocket smoke test plus an operations runbook.
