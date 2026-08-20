# Swift Agent — As-Built System Snapshot
<!-- Last updated: 2026-07-21 after program: management-auth-hardening -->

## Packages & Key Exports

pnpm/Turborepo TypeScript monorepo (Node 22, TS strict, ESM-only) with nine
library packages, one deployable server app, and a maintained example app under
`examples/`. `@swiftagent/sdk`, `@swiftagent/react`, and `@swiftagent/shared`
are **publishable** to public npm (`registry.npmjs.org`, Apache-2.0); the rest
stay `private`.

### @swiftagent/shared (`packages/shared`)

Key exports: `ENV_KEYS`, `loadConfig`, `ChatEvent`/`ChatEventSchema` and entity
Zod schemas, ID generators, event constants, `SwiftAgentError`/
`SwiftAgentErrorCode`/`isSwiftAgentError`, `createRedisClient`, the versioned
runner protocol (`RUNNER_PROTOCOL_VERSION`, `RunnerRequestSchema`, …), and the
**control-plane/stream protocol versioning surface (WS-37)**:
`API_PROTOCOL_VERSION` (`'1'`), `SDK_MIN_SERVER_PROTOCOL`, `PROTOCOL_HEADER`
(`x-swiftagent-protocol`), the `PROTOCOL` bundle, and the pure
`assertProtocolCompatible(remote, local?)` (major-only, fails open on an absent
version). `SwiftAgentErrorCode` gained **`INCOMPATIBLE_VERSION`** (maps to 409).

### @swiftagent/db (`packages/db`)

Key exports: `createDbClient`; all Drizzle tables; factory repositories
(workspaces, API keys, agents, sessions, messages, runs, tool calls, traces,
users, user-workspaces); `migrate` entry (`dist/migrate.js`) with a drift
preflight; migration-tooling exports (`queryAppliedMigrations`,
`computeMigrationStatus`, `checkDrift`, `introspectLiveSchema`, `diffSchemas`,
`planPreflight`, …). Trace repo implements the observability `TraceSink`.

### @swiftagent/models (`packages/models`)

Key exports: `ModelProvider`, `ProviderRegistry`, `parseModelString`,
`createOpenAIProvider`, `createAnthropicProvider`, `createGoogleProvider`, model
stream chunk schemas. Providers normalize streamed tool calls to the runtime
protocol, preserving provider-native call IDs.

### @swiftagent/runtime (`packages/runtime`)

Key exports: `AgentEngine`, `runAgentLoop`, `createRunExecutionService`
(unified REST/WS run owner), local/remote tool executors, `createToolExecutor`,
`createToolExecutorResolver`, scoped runner credentials (`mintRunnerToken`,
`importRunnerPrivateKey`), SSRF guards, deadline helpers, last-N and summary
memory strategies, process-bound `SessionLock`, `ContextBuilder`.

### @swiftagent/gateway (`packages/gateway`)

Key exports: `registerGatewayPlugin` (mounts `@fastify/websocket` + `/v1/stream`
onto a host app), `createGatewayServer`/`startGateway` (standalone),
`ConnectionManager`, `SessionBridge`, `HeartbeatManager`, `ChannelRegistry`
(ref-counted per-session Redis subscription), client-token validation,
Redis/no-op pub-sub adapters. Inbound protocol: `send_message`, `ping`,
`cancel`. Delegates run execution to the shared `RunExecutionService`.

### @swiftagent/api (`packages/api`)

Key exports: `buildApp` (accepts `registerRootHealth?`), token/agent/session
services, control-plane + management schemas (incl. `RunMetricsResponseSchema`),
API-key auth, hardened Cognito JWT auth (`registerCognitoAuth`, ID-token-only —
see API Endpoints ▸ Management auth contract). Session creation returns the canonical
`websocketUrl = ${publicWebsocketUrl}?token=${clientToken}`; run creation is
async (`202`). **New (WS-37):** an additive `onSend` hook stamps
`x-swiftagent-protocol: API_PROTOCOL_VERSION` on every response (non-breaking;
consumed by the SDK for compatibility checks). No new endpoints.

### @swiftagent/observability (`packages/observability`)

Key exports: `Tracer`, `Span`, `RunTraceContext`, `createTracedLogger`,
`deriveRunMetrics`, `boundSpanRecord`, trace record/sink types.
`Tracer.startRunTrace` opens a root span with `startModelCall`/`startToolCall`
children; `finish` commits trace + spans atomically, bounding oversized payloads.

### @swiftagent/sdk (`packages/sdk`) — public surface finalized (WS-36)

**Root (`@swiftagent/sdk`) — stable surface:** `createAgentApp`, `AgentApp`
(type), `defineAgent`, `tool`, and public types (`ToolContext`,
`ToolDefinition`, `AgentDefinition`, `CreateAgentAppConfig`,
`CreateSessionOptions`, `CreateSessionResult`, `CreateRunOptions`, `AcceptedRun`,
record types). `AgentApp` ships the fluent surface: `agent()`,
`sessions.create/get`, `sessions.messages.list`, `runs.create/get/cancel`,
`listen()`, `close()`. `createSession` now surfaces the server's
`serverProtocolVersion` (from the response header); `registerAgent` asserts
protocol compatibility. Setup/runtime failures are typed `SwiftAgentError`
(missing/invalid API key, missing runner-token env, duplicate tool, HTTP status
→ code mapping).

**`@swiftagent/sdk/internal` — declared UNSTABLE subpath:** `ControlPlaneClient`,
`startToolRunner`, `toolToJsonSchema`, `SdkHttpError`, `ToolRunnerRequestSchema`,
`SdkAgentConfigSchema`, and runner/tool wire types. Not semver-covered.

### @swiftagent/react (`packages/react`) — public surface locked (WS-36)

**Root (`@swiftagent/react`) — exactly:** `createChatSession`, `useAgentChat`,
plus public types (`ChatEvent`, `ChatMessage`, `ChatSessionClient`,
`ConnectionStatus`, `CreateChatSessionOptions`, `ReconnectOptions`,
`ToolCallInfo`, `UseAgentChatArgs`, `UseAgentChatResult`). `useConnection` and
its types are now **internal** (removed from the barrel; still used by
`useAgentChat`). The client asserts protocol compatibility **before opening the
socket** using `serverProtocolVersion` from session creation, surfacing a typed
`INCOMPATIBLE_VERSION` error via `lastError`; other connection/auth failures also
surface as typed, readable `lastError` values.

### @swiftagent/server (`apps/server`)

Key exports: `startServer`, `buildContainer`, `loadServerConfig`,
`validatePublicWebsocketUrl`, `redactConfig`, combined health checks. Builds one
Fastify app (`buildApp(..., { registerRootHealth: false })` +
`registerGatewayPlugin` + composed `/health`), single `listen` on `API_PORT`
(3000) serving REST + WebSocket. Consolidated graceful shutdown drains sockets.

### examples/quickstart (`examples/quickstart`) — maintained (WS-39)

`backend/` (Node/`tsx`): `createAgentApp` → `defineAgent` with a Zod-schema
`tool` → `app.agent` → `app.listen()`; `.env.example` documents
`SWIFT_AGENT_API_KEY` + runner-token env. `frontend/` (Vite + React 19): fetches
a session then renders `useAgentChat({ sessionId, token, websocketUrl })`,
threading the API-returned `websocketUrl` verbatim. Consumes only public APIs
(enforced by a `no-restricted-imports` lint guard); typechecked/built in CI.

## Data Model

Unchanged by sdk-dev-ux. Tables: `workspaces`, `api_keys`, `agents`
(incl. `tools` JSONB NOT NULL, nullable `tool_runner_url`), `sessions`,
`messages`, `runs` (nullable `token_usage` JSONB), `tool_calls` (`tc_` PK),
`traces` (unique `run_id`), `trace_spans`, `users` (unique `cognito_sub`),
`user_workspaces` (composite PK). Enums: session status (`active`,`closed`), run
status (`running`,`completed`,`failed`,`cancelled`,`timed_out`), message role,
tool-call status, span type/status. Migrations: Drizzle baseline `0000` + `0001`
(`agents.tools`) + `0002` (run_status). No schema/migration change this program.

## API Endpoints

Unchanged surface; all `/v1/*` responses now carry an `x-swiftagent-protocol`
header (additive).

- **Control plane (`/v1/*`, API-key bearer):** `GET /v1/health`;
  `POST|GET /v1/agents`, `GET /v1/agents/:id`; `POST /v1/sessions`,
  `GET|PATCH /v1/sessions/:id`, `GET /v1/sessions/:id/messages`,
  `POST /v1/sessions/:id/runs` (`202`; `409` on concurrent run);
  `GET /v1/runs/:id`, `POST /v1/runs/:id/cancel` (`202`),
  `GET /v1/runs/:id/tool-calls`, `GET /v1/runs/:id/trace`,
  `GET /v1/runs/:id/metrics`, `GET /v1/traces/:id/spans`; composed `GET /health`.
  Ownership-scoped (`404` for foreign workspace).
- **Management (`/v1/management/*`, Cognito JWT):** `GET /me`;
  `POST|GET /workspaces`, `GET /workspaces/:id`; `POST|GET /workspaces/:id/keys`,
  `DELETE /workspaces/:id/keys/:keyId`. Registered only when Cognito is configured.
  Endpoint surface unchanged by management-auth-hardening.
- **Management auth contract (management-auth-hardening):** the plugin-level
  `onRequest` hook accepts a **Cognito ID token only** (`session.idToken`).
  Required claims: `token_use === 'id'`, `aud` = app client id (string or array),
  `iss` = pool issuer, `sub`, `email`. Ordering is load-bearing: `jose`
  `jwtVerify` checks signature + `iss` + `exp`/`nbf` **without** `audience`, then
  the hook asserts `token_use` first and enforces `aud` **manually** — so a real
  Cognito **access token** (no `aud`, no `email`, `token_use: "access"`) is
  rejected `401` with an accurate *token-type* error, not a generic audience/email
  failure. All auth failures (missing header / missing token / wrong token type /
  bad audience / missing `sub`|`email` / invalid-or-expired) keep code
  `UNAUTHORIZED` → `401`, varying only the message so they stay distinguishable
  without changing the status contract. Authorization (workspace membership) is
  separate and surfaces `403` (`FORBIDDEN`) via `resolveOrCreateUser` — an
  authenticated principal never degrades to `401`.
- **WebSocket:** `GET /v1/stream?token=<jwt>` on the unified port (3000);
  gateway reads only `?token=` and derives `sessionId` from JWT claims.

## Protocols / Events

- Outbound `ChatEvent`: `message_started`, `token`, `tool_call_started`,
  `tool_call_completed`, `message_completed`, `run_failed` (carries
  `code`/`message`/`cause`; cancellation/timeout reuse `CANCELLED`/`TIMED_OUT`).
- Inbound: `send_message`, `ping`→`pong`, `cancel`. Socket disconnect does not
  cancel a server-owned run.
- **Protocol versioning (WS-37):** two distinct constants —
  `RUNNER_PROTOCOL_VERSION` (tool-runner wire envelope) and
  `API_PROTOCOL_VERSION` (control-plane + `ChatEvent` stream). Server advertises
  the latter via the `x-swiftagent-protocol` header; SDK asserts at registration
  and the client asserts before connect (major-only; fails open on legacy).
- Client tokens are HS256 JWTs; runner tokens short-lived RS256/EdDSA, scoped per
  invocation. Model IDs `provider/model-id`; runtime keys `ak_` (SHA-256 hash).
- Redis fanout single-task MVP (ref-counted `ChannelRegistry`, peer-only forward).

## Runtime Loop

`runAgentLoop` (async generator) owns a run: persists the user message + run,
streams tokens, passes registered tool schemas each turn, allowlists +
JSON-schema-validates each tool call, executes via the per-agent-resolved
executor, and finalizes tool calls/trace/terminal run state on every exit path.
Merged `AbortSignal` for model/per-tool/total-run deadlines; terminal
transitions conditional (`WHERE status='running'`). Unchanged by sdk-dev-ux.

## Versioning & Publishing (WS-37/WS-38, public posture WS-44)

- **Changesets** is the version source of truth: root `@changesets/cli` devDep,
  `.changeset/config.json` (`access: public`, `baseBranch: main`), scripts
  `changeset` / `version-packages`. A pending changeset for the SDK surface
  exists; packages are still at `0.0.1` until the first release runs.
- **`docs/policies/versioning.md`** documents semver, deprecation/removal, and
  the SDK↔server compatibility policy + support matrix.
- Publishable packages (`sdk`, `react`, `shared`) declare
  `publishConfig` (`registry: registry.npmjs.org`, `access: public`),
  `files` allowlist (dist + README + LICENSE + NOTICE, tests excluded),
  `repository`/`license` (`Apache-2.0`, backed by the root `LICENSE`/`NOTICE`
  with byte-identical per-package copies)/`author`, and `exports` maps
  (`.` + `./internal` for sdk). No `private` field. `.npmrc` carries only
  behavioral flags (no scope-registry routing; the default public registry
  applies). `workspace:*` resolves to concrete versions at publish;
  `scripts/verify-pack.mjs` is the pack/dry-run verification gate.
- **`publish-sdks.yml`** (manual `workflow_dispatch` ONLY — the release
  trigger, see `RELEASING.md`): Changesets `version` + `publish` to public npm
  on `latest` (`contents: write`; auth via the owner-provisioned `NPM_TOKEN`
  secret).
- **`publish-sdks-prerelease.yml`** (manual `workflow_dispatch` ONLY): snapshot
  `0.0.0-pr-<sha>` published under the `pr` dist-tag (no git writes). The
  former per-PR auto-snapshot is retired; per-PR install proof returns with
  WS-45's local registry.
- Contribution terms: `CONTRIBUTING.md` + `DCO` (Developer Certificate of
  Origin 1.1, `Signed-off-by` required on every commit, enforced by
  `scripts/check-dco.mjs` via `.github/workflows/dco.yml`); contributors
  retain copyright.

## Documentation

Root `README.md`, per-package `README.md` (sdk/react/shared), `docs/quickstart.md`
(narrative, example-sourced), and `docs/policies/versioning.md`. `docs/vision.md`
+ `swift-agent.md` realigned to the shipped API: Zod `inputSchema` (not JSON
Schema), the full fluent `AgentApp` surface, `sessions.create({ agentName })`,
and `useAgentChat` threading `websocketUrl`. as-built snapshots remain canonical.

## Infrastructure

- `docker-compose.yml`: Postgres 16, Redis 7, server. `apps/server/Dockerfile`:
  multi-stage Node 22, exposes only port 3000.
- **CI (`.github/workflows/ci.yml`):** build/lint, unit tests, integration tests
  (Testcontainers Postgres) + drift guard, plus the **acceptance gate**
  (`pnpm test:acceptance`, Docker; no registry credential needed).
- Deploy workflows (`deploy-dev`/`staging`/`prod`): GitHub OIDC → ECR →
  Terraform → migrate; `/health` + realtime WS smoke (`pnpm smoke:realtime`,
  deploy-blocking). Terraform composes networking, RDS, ElastiCache, ECR, SSM
  (incl. `PUBLIC_WEBSOCKET_URL`), Cognito, IAM, ALB, ECS; `desired_count = 1`,
  autoscaling off (single-task MVP).
- **Acceptance suite (`test/acceptance/`, `pnpm test:acceptance`):** Testcontainers
  Postgres via `setup-db.ts`, Redis off (single-node harness), deterministic fake
  provider + echo runner. `install-published.ts` / `install-registry.acceptance.test.ts`
  install `@swiftagent/*` from a parameterizable registry
  (`SWIFTAGENT_INSTALL_REGISTRY`, default public npm) into a throwaway
  consumer, opt-in via `SWIFTAGENT_RUN_INSTALL_PROOF=1` (loud-skips until a
  published version exists); `quickstart.acceptance.test.ts` drives register →
  session → connect → stream and asserts
  `message_started → token → tool_call_* → message_completed` via `ChatEventSchema`.
  Config `test/vitest.acceptance.config.ts` (serial, 120s timeouts).
- Export-snapshot guard tests (`packages/{sdk,react}/src/__tests__/public-api.test.ts`)
  fail CI on accidental public-surface changes.

## Known Limitations / Tech Debt

- **Packages unreleased (release armed, not fired):** still `0.0.1`; no version
  exists on `registry.npmjs.org` yet. The public-npm release pipeline is one
  documented manual `workflow_dispatch` away (see `RELEASING.md`); the owner
  must first provision the npm org + `NPM_TOKEN` secret.
- **Connect-time compat is client-side** via the session-create header; the
  WebSocket stream carries no version field, so a true stream-handshake version
  check is a follow-up.
- **Single-task realtime MVP (AD-02, realtime program):** process-local replay
  buffer, process-bound session lock, in-flight runs abandoned on restart, Redis
  fanout dormant cross-instance. Horizontal scale is Phase 2.
- `SummaryMemoryStrategy` is still a pass-through stub.
- No reverse (down) migrations; drift reconciliation is operator-driven.
- Management routes disappear silently when Cognito config is absent; JIT user
  race lacks the planned DB conflict clause.
- **Resolved (management-auth-hardening):** token-type validation is no longer
  implicit — the Cognito hook now explicitly asserts `token_use === 'id'` and
  rejects access tokens with an accurate token-type `401`. Verified by a
  contract-matrix suite (`management-protection.test.ts`) driving the real
  middleware through `buildApp` via a local-JWKS harness
  (`__tests__/management-helpers.ts`, also the shared key-storing mock repo).
- Root `test/` tree is excluded from `pnpm typecheck`/`lint` — acceptance and
  integration suites are validated by running them (need Docker).
- Pre-existing baseline failures (not regressions): `@swiftagent/server` vitest
  exit-1 and 3 `@swiftagent/api` failures.
- `AGENTS.md` absent; conventions live in `CLAUDE.md`.

## Programs Completed

- `product-x` — 2026-07-15: Runtime monorepo, dual-port REST + WebSocket service,
  provider abstraction, SDKs, persistence, CI, Docker, AWS ECS infra.
- `management-api` — 2026-07-15: Cognito identity, user/workspace membership, API
  key lifecycle, seven management endpoints, Cognito Terraform.
- `core-runtime-completion` — 2026-07-16: Completed registration→model→remote-
  tool→response path; provider tool-calling; per-agent executor; unified
  REST/WS run service with `202`; Drizzle baseline.
- `persist-observe` — 2026-07-16: `db:status`/`db:check` drift detection, migrate
  preflight, CI drift guard, run metrics, hardened trace persistence.
- `realtime-cloud-delivery` — 2026-07-17: Unified REST + WebSocket on port 3000,
  canonical `wss://<host>/v1/stream?token=` contract, `PUBLIC_WEBSOCKET_URL` via
  SSM/ECS with fail-fast validation, drain tuning, ref-counted Redis fanout +
  health, React SDK/doc alignment, deploy-blocking realtime smoke.
- `sdk-dev-ux` — 2026-07-20: Finalized `@swiftagent/sdk`/`@swiftagent/react`
  public surfaces (locked `exports`, `/internal` subpath, `useConnection`
  internalized, export-snapshot guards); protocol versioning + compatibility
  policy (`API_PROTOCOL_VERSION`, `assertProtocolCompatible`, register/connect
  assertions, `x-swiftagent-protocol` header); Changesets + registry
  publishing (to the then-private GitHub-hosted registry; retargeted to public
  npm by WS-44) with PR snapshot prereleases and a pack verification gate; a
  maintained `examples/quickstart` app; README/quickstart/vision doc alignment;
  typed `SwiftAgentError` setup/runtime messages; and a Testcontainers quickstart
  acceptance suite that installs the published packages.
- `management-auth-hardening` — 2026-07-21: Made the Management API's Cognito
  token contract explicit and enforced (ID-token-only; `token_use === 'id'`
  asserted before manual `aud` enforcement so access tokens get an accurate
  token-type `401`); split auth failures into a distinguishable taxonomy under a
  stable `UNAUTHORIZED`/`401`; added a `buildApp`-level route-protection matrix
  (401 unauth / 200 valid ID / 401 access token / 403 cross-workspace) with a
  shared local-JWKS test helper. Server-side half of the cross-repo Console &
  Identity Readiness effort; no endpoint, package, or data-model changes.
