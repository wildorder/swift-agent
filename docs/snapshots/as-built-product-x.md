# Swift Agent — As-Built System Snapshot
<!-- Last updated: 2026-07-15 after programs: product-x, management-api -->

## Packages & Key Exports

pnpm/Turborepo TypeScript monorepo with nine library packages and one
deployable server application.

### @swiftagent/shared (`packages/shared`)

Key exports: `ENV_KEYS`, `loadConfig`, `ChatEvent` and entity Zod schemas, ID
generators, event constants, `SwiftAgentError`, and `createRedisClient`.

### @swiftagent/db (`packages/db`)

Key exports: `createDbClient`; all Drizzle tables; and factory repositories
for workspaces, API keys, agents, sessions, messages, runs, tool calls, traces,
users, and user-workspace memberships.

### @swiftagent/models (`packages/models`)

Key exports: `ModelProvider`, `ProviderRegistry`, `parseModelString`,
`createOpenAIProvider`, `createAnthropicProvider`, `createGoogleProvider`, and
model stream chunk schemas.

### @swiftagent/runtime (`packages/runtime`)

Key exports: `AgentEngine`, `runAgentLoop`, local and remote tool executors,
`createToolExecutor`, last-N and summary memory strategies, `SessionLock`, and
`ContextBuilder`.

### @swiftagent/gateway (`packages/gateway`)

Key exports: `createGatewayServer`, `ConnectionManager`, `SessionBridge`,
`HeartbeatManager`, client-token validation, Redis/no-op pub-sub adapters, and
the inbound WebSocket protocol.

### @swiftagent/api (`packages/api`)

Key exports: `buildApp`, token/agent/session services, control-plane and
management API schemas, API-key auth, and Cognito JWT auth.

### @swiftagent/observability (`packages/observability`)

Key exports: `Tracer`, `Span`, `createTracedLogger`, `deriveRunMetrics`, and
trace record/sink types.

### @swiftagent/sdk (`packages/sdk`)

Key exports: `createAgentApp`, `defineAgent`, `tool`, `startToolRunner`, and
`ControlPlaneClient`.

### @swiftagent/react (`packages/react`)

Key exports: `createChatSession`, `useAgentChat`, `useConnection`,
`chatReducer`, and chat/client types.

### @swiftagent/server (`apps/server`)

Key exports: `startServer`, `buildContainer`, `loadServerConfig`, and combined
health checks. Startup composes repositories, providers, runtime, REST API on
port 3000, WebSocket gateway on port 3001, optional migrations/Redis, and
graceful shutdown.

## Data Model

- `workspaces`: `workspace_id` text PK, `name` text, `created_at` timestamptz,
  `updated_at` timestamptz.
- `api_keys`: `api_key_id` text PK, `workspace_id` FK, `key_hash` text,
  `name` text, timestamps including nullable `revoked_at`.
- `agents`: `agent_id` text PK, `workspace_id` FK, `name`, `model_config`
  JSONB, `system_prompt`, `memory_config` JSONB, nullable `tool_runner_url`,
  timestamps; unique workspace/name.
- `sessions`: `session_id` text PK, `agent_id` FK, nullable `user_id`,
  `status` enum, `metadata` JSONB, timestamps.
- `messages`: `message_id` text PK, `session_id` FK, nullable `run_id` FK,
  `role` enum, `content`, `created_at`.
- `runs`: `run_id` text PK, `session_id` FK, `status` enum, `model`,
  nullable `token_usage` JSONB, timestamps.
- `tool_calls`: `call_id` text PK, `run_id` FK, `tool_name`, `input` JSONB,
  nullable `output` JSONB, `status` enum, timestamps.
- `traces`: `trace_id` text PK, unique `run_id` FK, `root_span_id`,
  start/completion timestamps, nullable total duration.
- `trace_spans`: `span_id` text PK, `trace_id` FK, nullable parent, type/name,
  timing, metadata, status, and nullable error.
- `users`: `user_id` text PK, unique `cognito_sub`, `email`, timestamps.
- `user_workspaces`: composite user/workspace PK, both FKs, `role`, and
  `created_at`.

Enums: session status (`active`, `closed`), run status (`running`,
`completed`, `failed`), message role, tool-call status, span type, and span
status.

Only the users/user-workspaces incremental SQL migration exists. Integration
tests create most tables with separate inline SQL, so the checked-in migration
history does not describe a complete greenfield database.

## API Endpoints

### Control plane (`/v1/*`, API key bearer authentication)

- `GET /v1/health`: liveness.
- `POST /v1/agents`: register or update an agent.
- `GET /v1/agents`: list agents or filter by name.
- `GET /v1/agents/:agentId`: get an agent.
- `POST /v1/sessions`: create a session and short-lived client token.
- `GET|PATCH /v1/sessions/:sessionId`: get or update a session.
- `GET /v1/sessions/:sessionId/messages`: paginated history.
- `POST /v1/sessions/:sessionId/runs`: persist a user message and create run.
- `GET /v1/runs/:runId`: get run status.
- `GET /v1/runs/:runId/tool-calls`: list tool calls.
- `GET /v1/runs/:runId/trace`: get trace and spans.
- `GET /v1/traces/:traceId/spans`: list trace spans.
- `GET /health`: composed server health.

### Management (`/v1/management/*`, Cognito JWT authentication)

- `GET /me`: return or JIT-provision the current user.
- `POST|GET /workspaces`: create a workspace or list memberships.
- `GET /workspaces/:id`: get a member workspace.
- `POST|GET /workspaces/:id/keys`: create a one-time raw API key or list key
  metadata.
- `DELETE /workspaces/:id/keys/:keyId`: soft-revoke a key.

Management routes are registered only when Cognito issuer and client ID
configuration are present.

### WebSocket gateway

- `GET /v1/stream?token=<client-jwt>`: authenticated bidirectional stream.
- `GET /health`: gateway liveness.

## Protocols / Events

- Outbound `ChatEvent`: `message_started`, `token`, `tool_call_started`,
  `tool_call_completed`, `message_completed`, and `run_failed`.
- Inbound messages: `{ type: "send_message", content }` and
  `{ type: "ping" }`; ping receives `{ type: "pong" }`.
- Client tokens are HS256 JWTs containing session, agent, and permissions.
- Optional Redis pub/sub uses `session:{sessionId}` channels for fanout.
- Model identifiers use `provider/model-id`.
- Runtime API keys use `ak_` secrets and SHA-256 hashes; management identity
  uses Cognito RS256 JWTs resolved through JWKS.

## Infrastructure

- `docker-compose.yml`: PostgreSQL 16, Redis 7, and the server for local use.
- `apps/server/Dockerfile`: multi-stage Node 22 image exposing ports 3000 and
  3001.
- `.github/workflows/ci.yml`: type-check, lint, build, unit tests, and
  integration tests with PostgreSQL and Redis services.
- Environment deploy workflows use GitHub OIDC, ECR, Terraform, an ECS
  migration task, and smoke tests for dev, staging, and production.
- Terraform environment stacks compose networking, RDS, ElastiCache, ECR,
  SSM secrets, Cognito, IAM, ALB, ECS, and optional Route 53/ACM DNS.
- Cognito provisions a user pool, confidential app client, hosted domain, and
  SSM outputs used by both backend and site.
- `infra-plan.yml` plans all environments on infrastructure changes.
- `publish-sdks.yml` publishes `@swiftagent/sdk` and `@swiftagent/react` from
  GitHub releases.

## Known Limitations / Tech Debt

- Drizzle migration history is incomplete and cannot bootstrap a fresh
  database; its journal is empty.
- CI invokes a database `migrate` package script that does not exist.
- The tracer is instantiated but not passed into the runtime loop, so runtime
  execution does not populate trace tables.
- Server composition always selects `LocalToolExecutor`; agent
  `toolRunnerUrl` and the remote executor are not used.
- Model requests pass `tools: undefined`, leaving provider-driven tool calls
  incomplete.
- `SummaryMemoryStrategy` is a pass-through stub.
- Production ALB/ECS routing exposes only API port 3000; the gateway on 3001
  has no public load-balanced route.
- Management routes silently disappear when Cognito configuration is absent.
- JIT user race handling does not implement the planned database conflict
  clause.
- React client URL construction can append parameters to a WebSocket URL that
  already has a token query.
- Dev deployment retains temporary Terraform state-reconciliation steps.
- Management integration tests use local JWKS rather than a live Cognito pool.
- `AGENTS.md` is absent; conventions live only in `CLAUDE.md`.

## Programs Completed

- `product-x` — 2026-07-15: Built the runtime monorepo, dual-port REST and
  WebSocket service, provider abstraction, SDKs, persistence, CI, Docker, and
  AWS ECS infrastructure.
- `management-api` — 2026-07-15: Added Cognito identity, user/workspace
  membership, API key lifecycle management, seven management endpoints, and
  Cognito Terraform resources.
