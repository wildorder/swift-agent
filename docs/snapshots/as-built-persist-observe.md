# Swift Agent — As-Built System Snapshot
<!-- Last updated: 2026-07-16 after programs: product-x, management-api, core-runtime-completion, persist-observe -->

## Packages & Key Exports

pnpm/Turborepo TypeScript monorepo with nine library packages and one
deployable server application.

### @swiftagent/shared (`packages/shared`)

Key exports: `ENV_KEYS`, `loadConfig`, `ChatEvent` and entity Zod schemas, ID
generators, event constants, `SwiftAgentError`, `createRedisClient`, and the
versioned, byte-bounded **runner protocol** (`RunnerRequestSchema`,
`RunnerSuccessResponseSchema`, `RunnerErrorResponseSchema`,
`RUNNER_PROTOCOL_VERSION`, `RUNNER_MAX_*_BYTES`).

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
summary memory strategies, `SessionLock`, and `ContextBuilder`.

### @swiftagent/gateway (`packages/gateway`)

Key exports: `createGatewayServer`, `ConnectionManager`, `SessionBridge`,
`HeartbeatManager`, client-token validation, Redis/no-op pub-sub adapters, and
the inbound WebSocket protocol (`send_message`, `ping`, and explicit `cancel`).
The gateway delegates run execution to the shared `RunExecutionService`.

### @swiftagent/api (`packages/api`)

Key exports: `buildApp`, token/agent/session services, control-plane and
management API schemas (including `RunMetricsResponseSchema`), API-key auth, and
Cognito JWT auth. Agent registration persists tool definitions; run creation is
asynchronous (`202`) and delegates to the run execution service;
`registerMetricsRoutes` serves the run-metrics endpoint.

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
`chatReducer`, and chat/client types.

### @swiftagent/server (`apps/server`)

Key exports: `startServer`, `buildContainer`, `loadServerConfig`, and combined
health checks. `buildContainer` wires repositories, providers, the tracer (into
the runtime loop), the per-agent executor resolver (minting scoped runner
tokens), and the unified run execution service. Startup composes the REST API
on port 3000, the WebSocket gateway on port 3001, optional migrations/Redis,
and graceful shutdown.

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
`db:generate` runs `tsc && drizzle-kit generate` (schema generated from compiled
`dist/schema/*.js`; see `drizzle.config.ts`). Migration operations are now
drift-aware:

- `db:status` (`dist/cli/status.js`) — ordinal-zips the journal against the
  `drizzle.__drizzle_migrations` bookkeeping table and prints APPLIED/PENDING.
- `db:check` (`dist/cli/check.js`) — introspects the live schema via
  `information_schema`/`pg_catalog`, normalizes it and the latest committed
  snapshot into one canonical model, and diffs structurally. Exit `0` clean,
  `1` drift, `2` tool error.
- `migrate` runs `db:check`'s logic as a **preflight** against the last-applied
  snapshot and aborts (applying nothing) on drift; `MIGRATE_SKIP_DRIFT_CHECK=1`
  overrides with a loud warning.

Integration tests provision the schema via the real migrator (Testcontainers),
so the checked-in history bootstraps a fresh database. Rollback is forward-fix +
snapshot/restore per the migrations runbook (no down-migrations).

## API Endpoints

### Control plane (`/v1/*`, API key bearer authentication)

- `GET /v1/health`: liveness.
- `POST /v1/agents`: register or update an agent (persists tool definitions).
- `GET /v1/agents` / `GET /v1/agents/:agentId`: list/filter/get agents.
- `POST /v1/sessions`: create a session and short-lived client token.
- `GET|PATCH /v1/sessions/:sessionId`: get or update a session.
- `GET /v1/sessions/:sessionId/messages`: paginated history.
- `POST /v1/sessions/:sessionId/runs`: persist a user message, create + start
  an async process-bound run, return **`202`**; a concurrent active run on the
  session yields `409`.
- `GET /v1/runs/:runId`: get current/terminal run status.
- `POST /v1/runs/:runId/cancel`: idempotent cancellation request, returns
  `202` (including after the run is terminal).
- `GET /v1/runs/:runId/tool-calls`: list tool calls.
- `GET /v1/runs/:runId/trace`: get trace with nested spans (`404` if none).
- `GET /v1/runs/:runId/metrics`: token/latency/span-count roll-ups computed
  on read from the run's persisted spans (`404` if no trace).
- `GET /v1/traces/:traceId/spans`: list trace spans.
- `GET /health`: composed server health.

Run, tool-call, trace, and cancel routes enforce workspace ownership (`404`
for a foreign workspace's run — no existence leak).

### Management (`/v1/management/*`, Cognito JWT authentication)

- `GET /me`: return or JIT-provision the current user.
- `POST|GET /workspaces`: create a workspace or list memberships.
- `GET /workspaces/:id`: get a member workspace.
- `POST|GET /workspaces/:id/keys`: create a one-time raw API key or list key
  metadata.
- `DELETE /workspaces/:id/keys/:keyId`: soft-revoke a key.

Management routes register only when Cognito issuer and client ID are present.

### WebSocket gateway

- `GET /v1/stream?token=<client-jwt>`: authenticated bidirectional stream.
- `GET /health`: gateway liveness.

## Protocols / Events

- Outbound `ChatEvent`: `message_started`, `token`, `tool_call_started`,
  `tool_call_completed`, `message_completed`, and `run_failed`. `run_failed`
  carries a `code`/`message` (and `cause`); cancellation and timeout reuse it
  with `CANCELLED` / `TIMED_OUT` codes rather than adding union members.
- Inbound messages: `send_message`, `ping` (→ `pong`), and explicit `cancel`.
  A socket disconnect does **not** cancel a server-owned run — only `cancel`
  or the REST cancel route does.
- Runner protocol: versioned request/response envelope with bounded input,
  output, and error payloads and validated schemas.
- Client tokens are HS256 JWTs (session, agent, permissions). Runner tokens are
  short-lived asymmetric (RS256) JWTs scoped per invocation to
  `aud`/workspace/agent/run/call, signed with a private key held only by the
  hosted runtime and verified by the SDK runner with the public key.
- Optional Redis pub/sub uses `session:{sessionId}` channels for fanout.
- Model identifiers use `provider/model-id`; runtime API keys use `ak_`
  secrets with SHA-256 hashes; management identity uses Cognito RS256 JWTs
  resolved through JWKS.

## Runtime Loop

`runAgentLoop` is the async generator that owns a run: it persists the user
message + run (unless an upstream `RunExecutionService` prepared them), streams
tokens, passes registered tool schemas to the provider on every turn,
allowlists + JSON-schema-validates each tool call before execution, executes
via the per-agent-resolved executor, and finalizes tool calls, the trace, and
the terminal run state on every exit path. Model, per-tool, and total-run
deadlines propagate through a merged `AbortSignal`; terminal transitions are
conditional (`WHERE status='running'`) so the first cause wins and late
provider/runner responses cannot overwrite terminal state. Model spans carry
`promptTokens`/`completionTokens` metadata (sourced from the provider finish
usage) so span-derived metrics are truthful, and a failed best-effort trace
write is surfaced via `deps.logger` with run/trace ids rather than swallowed.

## Infrastructure

- `docker-compose.yml`: PostgreSQL 16, Redis 7, and the server for local use.
- `apps/server/Dockerfile`: multi-stage Node 22 image exposing ports 3000/3001.
- `.github/workflows/ci.yml`: build/lint, unit tests, then integration tests.
  Integration provisions PostgreSQL per-suite via Testcontainers; the job also
  declares a shell-reachable `postgres` service for a **schema drift guard**
  step that applies committed migrations then runs `db:check`, failing the
  build on any drift (a schema change not captured as a generated migration).
- Runner config env keys: `RUNNER_TOKEN_PRIVATE_KEY`, `RUNNER_TOKEN_PUBLIC_KEY`,
  `RUNNER_AUDIENCE`, `RUNNER_WORKSPACE_ID`, `RUNNER_REQUIRE_HTTPS`,
  `TOOL_RUNNER_PUBLIC_URL`.
- Environment deploy workflows use GitHub OIDC, ECR, Terraform, and smoke tests
  for dev, staging, and production. All three run migrations via the same ECS
  task command override (`node packages/db/dist/migrate.js`, now normalized
  across envs), so the deployed path inherits the drift preflight.
- `docs/runbooks/migrations.md`: forward-fix rollback, snapshot/restore, and
  operator-driven deployed-drift reconciliation (using `MIGRATE_SKIP_DRIFT_CHECK`).
- Terraform stacks compose networking, RDS, ElastiCache, ECR, SSM secrets,
  Cognito, IAM, ALB, ECS, and optional Route 53/ACM DNS.
- `infra-plan.yml` plans all environments on infra changes; `publish-sdks.yml`
  publishes `@swiftagent/sdk` and `@swiftagent/react` from GitHub releases.

## Known Limitations / Tech Debt

- **No reverse (down) migrations** — by design, rollback is forward-fix +
  snapshot/restore per the runbook; there is no automated `down` command.
- **Deployed-drift reconciliation is operator-driven** — drift is now detected
  (CI guard + `migrate` preflight), but bringing a diverged deployed schema back
  onto the baseline is a manual runbook procedure, not automated.
- **Drift check is structural-only** — it compares tables/columns/types/enums/
  indexes/FKs/PKs, not data or fine-grained default representations.
- `SummaryMemoryStrategy` is still a pass-through stub (logs a warning).
- Production ALB/ECS routing exposes only API port 3000; the gateway on 3001
  has no public load-balanced route.
- Management routes silently disappear when Cognito configuration is absent.
- JIT user race handling does not implement the planned DB conflict clause.
- React client URL construction can append parameters to a WebSocket URL that
  already has a token query.
- Dev deployment retains temporary Terraform state-reconciliation steps.
- Management integration tests use local JWKS rather than a live Cognito pool.
- Execution is process-bound: in-flight runs are abandoned on restart
  (durable recovery is reserved for the Phase 2 durable execution layer).
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
  resolution, secure remote SDK runner execution (scoped tokens, SSRF guards,
  bounded payloads, replay-safe invocation), a unified REST/WebSocket run
  execution service with `202` async runs, cancellation/timeout/failure
  hardening with `cancelled`/`timed_out` states, tracer wiring into the loop,
  the greenfield Drizzle migration baseline, and full runtime integration tests.
- `persist-observe` — 2026-07-16: Made DB evolution and observability
  production-safe. Added `db:status`/`db:check` migration status + structural
  drift detection, a `migrate` drift preflight, a CI drift guard, normalized
  deployed migrate paths, and a migrations rollback/reconciliation runbook;
  surfaced run metrics via `GET /v1/runs/:runId/metrics`; hardened trace
  persistence (token metadata on model spans, logged finalize, bounded span
  payloads); and added migration + observability integration suites.
