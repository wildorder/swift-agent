# Swift Agent — Program Plan (Realtime Cloud Delivery)

## Program Overview

**Product:** Swift Agent — a hosted real-time agent runtime that lets developers embed streaming, tool-calling, multi-model AI agents into any application.

**Program scope:** Make the locally working realtime runtime accessible, reliable, and verifiable through the deployed AWS environments. The runtime, gateway, Redis pub/sub, and AWS infrastructure already exist (see as-built), but the WebSocket gateway has **no public route**: the container runs two Fastify servers (REST on `3000`, gateway on `3001`), while the ALB target group, ECS task definition, and ECS security group expose **only `3000`**. This program resolves that gap by **unifying REST and WebSocket onto port `3000`**, establishes one canonical WebSocket URL contract, wires that URL through Terraform/SSM/ECS with fail-fast validation, hardens deploy-time connection draining, corrects Redis fanout and health, aligns the React SDK and site docs to the canonical endpoint, and adds a deployed realtime smoke test that blocks releases. Horizontal multi-instance scaling is explicitly deferred; the MVP pins a **single gateway task** and documents the process-local limits.

---

## Strategic Goals

1. **Publicly reachable realtime** — Serve REST and WebSocket on one public port so `/v1/stream` is routable through the existing ALB with no new target group or listener rule.
2. **One canonical URL contract** — A single `wss://<host>/v1/stream?token=<jwt>` shape produced by session creation and consumed identically by the SDK, docs, and quickstart.
3. **Correct per-environment configuration** — `PUBLIC_WEBSOCKET_URL` provisioned through Terraform/SSM into ECS with correct dev/staging/prod values, and startup validation that makes a localhost fallback in cloud impossible.
4. **Deployment-safe connections** — Consolidated shutdown that drains in-flight WebSockets within the ECS stop window, with ALB idle-timeout/stickiness/deregistration tuned for long-lived sockets.
5. **Verifiable in the cloud** — A deployed WebSocket smoke test (session → connect → auth → stream) that blocks the deploy on failure, plus resolved staging/production Docker build inconsistencies.

---

## Architecture Changes

The runtime loop, provider abstraction, gateway protocol, Redis pub/sub adapters, and the AWS Terraform stacks (networking, RDS, ElastiCache, ECR, SSM, Cognito, IAM, ALB, ECS) already exist. This program changes how the gateway is **exposed, configured, drained, and verified** — it does not change the runtime loop, the stream event protocol, or the trace schema.

### 1. Unified Realtime Server (Port Consolidation)

Today `startServer` starts two Fastify instances that already share one `RunExecutionService`: the REST API on `API_PORT` (3000) and the gateway on `GATEWAY_PORT` (3001). The gateway's WebSocket route (`GET /v1/stream`) is refactored into a **plugin mounted on the API Fastify app**, so REST and WebSocket are served by one server on port `3000`. The second listener and the `GATEWAY_PORT` concept are retired (retained only, if at all, as a local-dev convenience). Startup and graceful shutdown collapse to a single lifecycle, and the composed `/health` check covers the gateway. **Canonical URL becomes `wss://<host>/v1/stream`** — the path the ALB already forwards to `3000`.

### 2. Realtime Infra: Single-Port Routing, Idle/Drain Tuning

Because everything now serves on `3000`, the ALB needs **no** new target group or listener rule. Infra work is alignment and tuning: remove the stale `3001` from the Dockerfile `EXPOSE` and the ECS task definition, keep the ECS security group at `3000`-only, confirm the ALB idle timeout (already `3600s`) and cookie stickiness, set a deregistration delay and an ECS `stopTimeout` sized to drain long-lived sockets on deploy, and pin the ECS service **desired count = 1** (single-task MVP).

### 3. Environment URL Configuration & Startup Validation

`PUBLIC_WEBSOCKET_URL` is currently referenced by the app but **never created in Terraform** and silently defaults to `ws://localhost:3001`. This program creates the SSM parameter in the secrets module, wires it into the ECS task for dev/staging/prod with correct `wss://` hostnames, removes the silent localhost fallback, and adds **fail-fast startup validation** that rejects a missing or localhost `PUBLIC_WEBSOCKET_URL` when running in a cloud environment.

### 4. Connection Lifecycle & Deployment Safety

With a single server, shutdown consolidates: stop accepting connections, drain WebSockets via `connectionManager.closeAll(1001, …)` and heartbeat/session-bridge teardown, all bounded by the ECS stop window and ALB deregistration delay so an in-flight deploy closes sockets cleanly rather than dropping them. In-flight-run behavior and reconnect-replay limits are documented (execution is process-bound; the replay buffer is process-local).

### 5. Redis Fanout Correctness & Health

Redis pub/sub over `session:{sessionId}` channels already fans out, but delivery to locally-connected sockets on the subscribing instance is verified/corrected, and the **unused `redisPing` callback is wired into `/health`** so Redis reachability is reported. The single-task posture, process-local replay buffer, and process-bound session lock are documented as MVP limits, with horizontal scale reserved for Phase 2.

### 6. Client & Documentation Alignment

The React/vanilla client defaults to the wrong path (`wss://api.swiftagent.dev/ws`) and hand-appends `?sessionId=…&token=…` — a **redundant `sessionId`** the gateway ignores (it reads `sessionId` from the JWT) and a **double-`?` risk** when the base URL already carries a query. The SDK is aligned to consume the API-provided canonical `websocketUrl`, use safe URL construction (`URL`/`searchParams`), and drop the redundant parameter. Site docs and the quickstart are corrected to the canonical `wss://<host>/v1/stream` and validated against deployed dev.

### 7. Deployment Verification: Realtime Smoke Tests

Deploy workflows currently smoke only `GET /health` on `3000`. This program resolves staging/production Docker build inconsistencies and adds a **deployed WebSocket smoke test** exercising session create → connect → auth → event stream, wired so a realtime-smoke failure **blocks the deploy** in dev, staging, and production.

---

## Technology Choices

No new technology — uses the existing Node/TypeScript, Fastify 5 + `@fastify/websocket`, Terraform (ALB/ECS/SSM), ElastiCache Redis / ioredis, Zod, Vitest, and the existing GitHub Actions OIDC deploy pipeline. **No new AWS services** — the single-port decision reuses the existing ALB target group, listener, and security group.

---

## Workstreams

| ID | Workstream | Dependencies | Estimated Effort |
|----|-----------|--------------|-----------------|
| WS-30 | Unified Realtime Server (Port Consolidation) | as-built dual-port baseline | M |
| WS-31 | Realtime Infra: Single-Port Routing & Drain Tuning | WS-30 | M |
| WS-32 | Environment URL Configuration & Startup Validation | WS-31 | M |
| WS-33 | Redis Fanout Correctness & Health | WS-30 | M |
| WS-34 | Client & Documentation Alignment | WS-30, WS-32 | M |
| WS-35 | Deployment Verification: Realtime Smoke Tests | WS-30, WS-31, WS-32 | M |

**Size key:** S = 1-2 days, M = 3-5 days, L = 5-10 days

### Workstream Details

**WS-30 — Unified Realtime Server (Port Consolidation)**
Refactor the gateway WebSocket route into a Fastify plugin and mount it on the API app so REST + WebSocket serve on port `3000`; retire the second listener and `GATEWAY_PORT`; consolidate startup and graceful shutdown into one lifecycle that drains WebSockets on `SIGTERM`; extend the composed `/health` to cover the gateway. Establishes the canonical `/v1/stream` path on the API host. Touches `packages/gateway`, `packages/api`, `apps/server`, `packages/shared`.

**WS-31 — Realtime Infra: Single-Port Routing & Drain Tuning**
Align infrastructure to the single-port model: remove stale `3001` from `apps/server/Dockerfile` and the ECS task definition, keep the ECS security group at `3000`-only, confirm ALB idle timeout (`3600s`) and cookie stickiness, set an ALB deregistration delay and ECS `stopTimeout` sized for socket drain, and pin the ECS service desired count = 1. Touches `infra/modules/ecs`, `infra/modules/loadbalancer`, `infra/envs/{dev,staging,prod}`, `apps/server/Dockerfile`.

**WS-32 — Environment URL Configuration & Startup Validation**
Create the `PUBLIC_WEBSOCKET_URL` SSM parameter in the secrets module, wire it into the ECS task for dev/staging/prod with correct `wss://` hostnames, remove the silent `ws://localhost:3001` default, and add fail-fast startup validation rejecting a missing/localhost value in cloud environments. Touches `infra/modules/secrets`, `infra/envs/{dev,staging,prod}`, `packages/api`, `apps/server`, `packages/shared`.

**WS-33 — Redis Fanout Correctness & Health**
Verify/correct Redis pub/sub delivery to locally-connected sockets on the subscribing instance; wire the unused `redisPing` callback into the composed `/health`; add a fanout unit/integration test; document the single-task posture, process-local replay buffer, process-bound session lock, and in-flight-run/reconnect-replay behavior. Touches `packages/gateway`, `apps/server`, `docs/`.

**WS-34 — Client & Documentation Alignment**
Align the React/vanilla SDK to consume the API-provided canonical `websocketUrl`; replace string concatenation with safe `URL`/`searchParams` construction, drop the redundant `sessionId` query param, and fix the wrong default path; correct site docs and the quickstart to the canonical `wss://<host>/v1/stream` and validate against deployed dev. Touches `packages/react`, `packages/api` (URL formatting), `docs/`/site content.

**WS-35 — Deployment Verification: Realtime Smoke Tests**
Resolve staging/production Docker build inconsistencies; add a deployed WebSocket smoke test exercising session create → connect → auth → event stream; wire it into the dev/staging/prod deploy workflows so a realtime-smoke failure blocks the deploy. Touches `.github/workflows`, `apps/server/Dockerfile`, `test/` (smoke), deploy scripts.

---

## Dependency Graph

```text
as-built dual-port baseline (REST 3000 + gateway 3001, shared RunExecutionService)
        │
        ▼
WS-30 Unified Realtime Server (single port 3000)
        │
        ├───────────────┬───────────────────────────┐
        ▼               ▼                           ▼
WS-31 Infra         WS-33 Redis Fanout          (feeds WS-34)
Single-Port/Drain   & Health
        │
        ▼
WS-32 Env URL Config & Startup Validation
        │
        ├───────────────┐
        ▼               ▼
WS-34 Client &      WS-35 Deployment
Docs Alignment      Verification (smoke gate)
```

WS-33 runs in parallel off WS-30. WS-31 → WS-32 are sequenced because both edit the same Terraform env compositions. WS-34 and WS-35 both depend on the finalized canonical URL config (WS-32); WS-35 additionally needs the single-port infra (WS-31).

---

## Critical Path

**WS-30 → WS-31 → WS-32 → WS-35.**

Minimum timeline: approximately 12–18 working days. WS-33 parallels the WS-31/WS-32 infra chain off WS-30; WS-34 runs alongside WS-35 once WS-32 lands.

---

## Scope (In)

- Unify REST + WebSocket onto a single public port (`3000`); retire the separate gateway listener/port
- Canonical `wss://<host>/v1/stream?token=<jwt>` URL contract end to end
- `PUBLIC_WEBSOCKET_URL` provisioned via Terraform/SSM and injected into ECS for dev/staging/prod
- Fail-fast startup validation preventing a localhost WebSocket URL in cloud
- Consolidated graceful shutdown that drains in-flight WebSockets within the ECS stop window
- ALB idle-timeout/stickiness/deregistration and ECS `stopTimeout` tuned for long-lived sockets
- Redis fanout correctness to locally-connected sockets + `/health` Redis PING
- Single-task MVP posture with documented process-local limits
- React/vanilla SDK aligned to the canonical URL; redundant `sessionId` param and double-`?` bug fixed
- Site docs/quickstart corrected and validated against deployed dev
- Deployed WebSocket smoke test that blocks the deploy on failure
- Resolved staging/production Docker build inconsistencies

## Scope (Out)

- Horizontal multi-instance realtime scaling (cross-instance replay/lock semantics) — Phase 2
- A separate `rt.*` realtime hostname or CloudFront fronting
- A second ALB target group / listener rule (obviated by the single-port decision)
- Durable/persisted replay buffer and shared session lock across instances
- Changes to the runtime loop, providers, executor resolution, or stream event protocol
- New trace/span schema or metrics work (covered by persist-observe)
- Down/reverse migrations
- Usage metering / billing / autoscaling policies

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Merging the gateway into the API Fastify app regresses WS auth, heartbeat, or replay behavior | High | Move the route as a plugin without changing its handler; keep gateway unit/integration tests green; add a same-port integration test |
| WebSocket upgrade misbehaves over the ALB's single HTTP target group | High | Idle timeout already `3600s`; validate upgrade end-to-end in the deployed smoke test before gating |
| Deploy drops in-flight sockets during rollout | Medium | Size ECS `stopTimeout` and ALB deregistration delay to the drain window; close with code `1001` and document in-flight-run limits |
| Localhost-guard blocks legitimate local/dev runs | Medium | Scope the guard to cloud environments only; keep a clear local default and explicit env signal |
| Redis fanout correction changes delivery semantics for existing single-instance path | Medium | Cover with a fanout test; preserve local broadcast-first behavior; single-task posture bounds blast radius |
| Realtime smoke test flakes and blocks deploys | Medium | Bounded retries/timeout on the smoke check; health-gate the connection; fail loud with captured diagnostics |
| Per-environment `wss://` hostnames misconfigured across three env compositions | Medium | Single SSM parameter per env, asserted by the startup validation and the deployed smoke test |

---

## Success Criteria

- **SC-01:** REST and WebSocket are served on a single public port (`3000`); `/v1/stream` is reachable through the existing ALB with no separate gateway port exposed in the container, task definition, or security group.
- **SC-02:** Session creation returns, and the SDK consumes, one canonical WebSocket URL of the form `wss://<host>/v1/stream?token=<jwt>`.
- **SC-03:** `PUBLIC_WEBSOCKET_URL` is provisioned via Terraform/SSM and injected into ECS with correct per-environment (dev/staging/prod) `wss://` values.
- **SC-04:** Startup fails fast when `PUBLIC_WEBSOCKET_URL` is missing or localhost in a cloud environment — the silent `ws://localhost:3001` fallback is removed.
- **SC-05:** Graceful shutdown drains in-flight WebSocket connections within the configured ECS stop window, and ALB idle-timeout/stickiness/deregistration are tuned for long-lived sockets.
- **SC-06:** Redis fanout delivers run events to locally-connected sockets on the subscribing instance, and `/health` reports Redis reachability via PING.
- **SC-07:** The single-task posture, process-local replay-buffer and session-lock limits, and in-flight-run/reconnect-replay behavior are documented.
- **SC-08:** The React/vanilla SDK consumes the API-provided canonical URL using safe URL construction; the redundant `sessionId` query parameter and the double-`?` construction bug are removed.
- **SC-09:** Site docs and the quickstart document the canonical `/v1/stream` endpoint and are validated against deployed dev.
- **SC-10:** A deployed WebSocket smoke test exercises session create → connect → auth → event stream, and its failure blocks the deploy in dev, staging, and production.
- **SC-11:** Staging/production Docker build inconsistencies are resolved so all environments build and deploy from an identical image path.
- **SC-12:** Monorepo type-checking, linting, unit tests, and integration tests pass.
