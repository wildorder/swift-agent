# WS-11: Service Composition

## Goal

Create the deployable service entry point (`apps/server`) that composes all packages into a single running process: database client, repositories, model provider registry, agent runtime engine, control plane API routes, WebSocket gateway, observability tracer, and health checks — wired together via a dependency container with config validation and graceful shutdown.

## Dependencies

- WS-01
- WS-02
- WS-03
- WS-04a
- WS-04b
- WS-05a
- WS-05b
- WS-06
- WS-07
- WS-08
- WS-09
- WS-10

## Package

`apps/server`

## Files Touched

- `apps/server/package.json`
- `apps/server/tsconfig.json`
- `apps/server/src/main.ts`
- `apps/server/src/config.ts`
- `apps/server/src/container.ts`
- `apps/server/src/health.ts`
- `apps/server/src/index.ts`

## Implementation Steps

1. **Config (`config.ts`)**: Import `loadConfig` from `@swiftagent/shared`. Load and validate all required environment variables at startup: `DATABASE_URL`, `REDIS_URL` (optional for MVP), `CLIENT_JWT_SECRET`, `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` (at least one model key required), `PUBLIC_WEBSOCKET_URL`, `API_PORT` (default 3000), `GATEWAY_PORT` (default 3001 or same server), `AUTO_MIGRATE` (default false). Fail fast with clear error messages listing all missing required vars — not one at a time.

2. **Dependency container (`container.ts`)**: Wire all package dependencies in one place. Instantiate in order:
   - Database client via `createDbClient(config.DATABASE_URL)` from `@swiftagent/db`
   - All repositories (WorkspaceRepo, ApiKeyRepo, AgentRepo, SessionRepo, MessageRepo, RunRepo, ToolCallRepo, TraceRepo) from `@swiftagent/db`
   - Model provider registry from `@swiftagent/models` — register OpenAI, Anthropic, Google providers with API keys from config (only register providers whose keys are present)
   - Tracer with TraceSink backed by TraceRepository from `@swiftagent/observability`
   - AgentEngine from `@swiftagent/runtime` — inject repos, model registry, tracer
   - TokenService from `@swiftagent/api` — inject JWT secret
   - AgentService, SessionService from `@swiftagent/api` — inject repos
   - Export a typed `Container` object that holds all instances
   - Document the instantiation order and why it matters (DB first, repos depend on DB, engine depends on repos + models, etc.)

3. **Main entry point (`main.ts`)**:
   - Load config (fail fast on invalid config)
   - Build container
   - Run database migrations if `AUTO_MIGRATE=true` (import migrate function from `@swiftagent/db`)
   - Create Fastify server with pino logger from config
   - Register control plane API routes from `@swiftagent/api` — pass container services and repos
   - Register WebSocket gateway from `@swiftagent/gateway` on the same Fastify instance (uses `@fastify/websocket`)
   - Wire the gateway's `RuntimeDelegate` to `container.engine` so inbound WebSocket messages trigger the agent runtime's `run()` method
   - Register health check route
   - Start listening on configured port
   - Register graceful shutdown handlers for SIGTERM and SIGINT:
     1. Stop accepting new connections
     2. Drain active WebSocket connections (close with 1001)
     3. Wait for in-flight runs to complete (with timeout)
     4. Close Redis connection if active
     5. Close database pool
     6. Exit
   - Log startup banner with port, loaded model providers, config summary (redacted secrets)

4. **Health (`health.ts`)**: Combined health check endpoint at `GET /health`. Checks:
   - Database: `SELECT 1` query against Postgres
   - Redis: `PING` if Redis is configured
   - Gateway: report active WebSocket connection count
   - Returns `{ status: "ok" | "degraded", checks: { db: "ok"|"error", redis: "ok"|"error"|"disabled", gateway: { connections: number } }, uptime: number }`
   - Returns HTTP 200 for "ok", 503 for "degraded" (any check failing)

5. **Package config (`package.json`, `tsconfig.json`)**: Dependencies on all `@swiftagent/*` packages. Build script produces `dist/main.js` as the entry point. Add `start` script: `node dist/main.js`. Add `start:dev` script with `tsx watch` for development.

6. **Index (`index.ts`)**: Export `buildContainer` and `startServer` functions for programmatic use (useful for integration tests that need to boot the server in-process).

## Tests

1. Service starts with valid config and responds to `GET /health` with `{ status: "ok" }`.
2. Service fails fast with clear error listing all missing required env vars when config is incomplete.
3. Container wires all dependencies without circular import issues; typed `Container` object has all expected properties.
4. Health endpoint returns 503 when database is unreachable.
5. Graceful shutdown closes WebSocket connections and database pool in correct order (mock or integration test).
6. `buildContainer` and `startServer` are importable for programmatic use.

## Acceptance Criteria

1. `apps/server` is a single deployable entry point that boots the API, gateway, and runtime as one process with shared database and config.
2. Config validation fails fast at startup with clear messages for all missing environment variables.
3. The dependency container wires all packages without circular dependencies; every package receives its dependencies via injection.
4. Graceful shutdown drains connections and closes resources in the correct order.
5. Health check reflects actual service status (database reachability, Redis connectivity, gateway state).
6. The server is importable programmatically via `buildContainer`/`startServer` for external integration testing.
