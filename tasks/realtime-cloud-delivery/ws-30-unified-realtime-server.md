# WS-30: Unified Realtime Server (Port Consolidation)

## Goal

Serve the REST API and the WebSocket gateway from a **single public Fastify instance on one port (`API_PORT`, 3000)** so that `/v1/stream` is reachable through the same ALB target that already routes REST traffic. Today `apps/server/src/main.ts` boots **two** Fastify instances — the API on `API_PORT` (3000) and the gateway on `GATEWAY_PORT` (3001) — that already share one `RunExecutionService`, but the ALB only forwards 3000, so `wss://<host>/v1/stream` (living on 3001) is unreachable in the cloud. This is program decision **AD-01**.

The fix, precisely: extract the gateway's route + component wiring into a reusable helper and expose a new `registerGatewayPlugin(app, config, runtime)` export from `packages/gateway` that mounts `@fastify/websocket` and the `/v1/stream` route **onto the API's existing Fastify instance** (it does not create its own app and does not call `listen`). `apps/server/src/main.ts` then drops the second listener, calls `registerGatewayPlugin(api.app, …)` after `buildApp(...)`, and does a **single** `api.app.listen({ port: apiPort })`. `createGatewayServer` / `startGateway` remain exported and behavior-compatible (they build their own app + `listen`) so the existing gateway integration tests — which spin the gateway on its own port — keep passing. Both the standalone server and the plugin delegate to **one** shared registration helper so there is a single implementation of the `/v1/stream` handler and its component graph.

The canonical client URL becomes `wss://<host>/v1/stream?token=<jwt>`. `GATEWAY_PORT` is retained (still used by the standalone `createGatewayServer`/`startGateway` for local dev + tests) but is **no longer used by the unified server path**. **Scope: M-sized, ~5 files across four packages.** This workstream does **not** touch Terraform/ECS/ALB/Dockerfile (WS-31), `PUBLIC_WEBSOCKET_URL` SSM/guard wiring (WS-32), Redis fanout correctness or the real `redisPing` PING body (WS-33), the SDK/docs (WS-34), or deployed smoke tests (WS-35).

## Traceability

- **SC-01** — REST and WebSocket are served on a single public port (3000); `/v1/stream` is reachable and the app no longer exposes a separate gateway port. Verified by the new unified-server integration test (REST + WS on the same port) and by `main.ts` performing exactly one `listen`.
- **SC-05** — Consolidated graceful shutdown drains in-flight WebSocket connections app-side: one shutdown path closes the API app, closes all sockets with code `1001`, clears the heartbeat timers, shuts down the session bridge, and closes the DB pool. (ALB/ECS deregistration-delay timing is WS-31.)
- **SC-02** (contributes) — the server serves the canonical `/v1/stream` on the API host/port; the client-facing URL is now `wss://<host>/v1/stream`.
- **SC-12** — `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:integration` all pass; the existing gateway suite is untouched behaviorally.

## Dependencies

- **WS-06** (realtime gateway) — provides `createGatewayServer`, `ConnectionManager`, `SessionBridge`, `HeartbeatManager`, the `/v1/stream` route handler, and the Redis pub/sub stub. This workstream refactors that server into a plugin **without changing its externally observable behavior**.
- **WS-23** (unified run execution) — `RunExecutionService` satisfies `RuntimeDelegate` and is already shared between REST (`buildApp`) and the gateway in `main.ts`. This workstream preserves that single-instance sharing.
- No dependency on WS-31/32/33/34/35; those **consume** the contract defined here (notably the `redisPing` field on `GatewayComponents`, which WS-33 fills in — see Design Notes).

## Context Files (Agent MUST read before implementing)

- `c:\dev\swift-agent\CLAUDE.md` — conventions: Node 22, TS strict, ESM (`"type": "module"`, `.js` import specifiers), Fastify 5, `@fastify/websocket` ^11, factory functions, `ENV_KEYS` single source of truth in `@swiftagent/shared`.
- `c:\dev\swift-agent\apps\server\src\main.ts` — the current two-listener startup + duplicate shutdown; the file this workstream refactors. Pasted verbatim below.
- `c:\dev\swift-agent\apps\server\src\health.ts` — `registerHealthCheck(app, deps)`; `HealthDeps` already carries an **optional `redisPing`** field. Pasted below.
- `c:\dev\swift-agent\apps\server\src\config.ts` — `ServerConfig`, `loadServerConfig`, `redactConfig`; the banner prints both `API Port` and `Gateway Port` today. Pasted below.
- `c:\dev\swift-agent\packages\gateway\src\server.ts` — `createGatewayServer` / `startGateway`, `GatewayContext`, the `/v1/stream` route handler, the internal `SIGTERM`/`SIGINT` handlers, and the standalone `/health`. The extraction target. Pasted below.
- `c:\dev\swift-agent\packages\gateway\src\types.ts` — `GatewayConfig`, `RuntimeDelegate`, defaults (`DEFAULT_HEARTBEAT_TIMEOUT_MS`, `DEFAULT_GATEWAY_PORT`, `DEFAULT_MAX_REPLAY_BUFFER_SIZE`). Pasted below.
- `c:\dev\swift-agent\packages\gateway\src\session-bridge.ts` — `SessionBridge`, `createNoopRedisPubSub`/`createRedisPubSub`, `RedisPubSubStub`. Read to understand what the shared helper must construct and how Redis is wired (the `redisPing` field WS-33 fills lives adjacent to `RedisPubSubStub`).
- `c:\dev\swift-agent\packages\gateway\src\index.ts` — current public exports; the new `registerGatewayPlugin` + `GatewayComponents` + `GatewayPluginConfig` must be added here.
- `c:\dev\swift-agent\packages\api\src\server.ts` — `buildApp`/`BuildAppOptions`/`AppContext`; the plugin is registered onto `api.app` after `buildApp` returns. Note `buildApp` already mounts a `/v1` prefix and a root `/health`. Pasted below.
- `c:\dev\swift-agent\packages\shared\src\config.ts` — `ENV_KEYS` (`API_PORT` default 3000, `GATEWAY_PORT` default 3001) and the Zod schema. `GATEWAY_PORT` is **kept**. Pasted below.
- `c:\dev\swift-agent\packages\gateway\src\__tests__\integration.test.ts` — the existing gateway integration suite that boots via `createGatewayServer` on port 0 and asserts `GET /health` → `{ status: 'ok' }`, auth close codes, ping/pong, and the ChatEvent sequence. **These must keep passing** — the standalone path and its `/health` shape are frozen. Pasted (key parts) below.

## Package

`packages/gateway`, `packages/api`, `apps/server`, `packages/shared`.

## Files Touched

- `packages/gateway/src/plugin.ts` **(NEW)** — the shared registration helper + the `registerGatewayPlugin` plugin-form export. Contains: `buildGatewayComponents(config)` (constructs `ConnectionManager`, `HeartbeatManager`, Redis pub/sub, `SessionBridge`, and the `redisPing` closure), `registerStreamRoute(app, deps)` (registers `@fastify/websocket` + the `/v1/stream` route under prefix `/v1`), and `registerGatewayPlugin(app, config, runtime): Promise<GatewayComponents>`. **The `/v1/stream` handler body moves here verbatim** from `server.ts` (no behavior change).
- `packages/gateway/src/server.ts` **(MODIFY)** — `createGatewayServer` now builds its own Fastify app, then delegates route/component wiring to the **same** `buildGatewayComponents` + `registerStreamRoute` helpers `registerGatewayPlugin` uses. `GatewayContext` is unchanged. The internal `SIGTERM`/`SIGINT` handlers stay **only** in `createGatewayServer` (standalone); the plugin form registers **no** process signal handlers. `startGateway` unchanged. The standalone `/health` → `{ status: 'ok' }` stays (frozen by the existing suite).
- `packages/gateway/src/types.ts` **(MODIFY)** — add `GatewayPluginConfig` (the plugin-form config: `jwtSecret`, `redisUrl?`, `redisEnabled?`, `heartbeatTimeoutMs?`, `maxReplayBufferSize?` — **no `port`, no `logger`**, since the host app owns both) and `GatewayComponents` (the returned component graph incl. `redisPing`).
- `packages/gateway/src/index.ts` **(MODIFY)** — export `registerGatewayPlugin`, and the types `GatewayPluginConfig`, `GatewayComponents`.
- `apps/server/src/main.ts` **(MODIFY)** — remove the second Fastify build + `listen`; call `registerGatewayPlugin(api.app, {...}, container.runExecutionService)` after `buildApp`; register the health check with the returned components (incl. `redisPing`); single `api.app.listen`; one consolidated shutdown path; drop the gateway-port banner line (or mark local-only). `ServerContext.gateway` becomes `GatewayComponents` instead of `GatewayContext`.
- `apps/server/src/config.ts` **(MODIFY)** — `redactConfig` drops the separate `GATEWAY_PORT` line from the unified banner (or annotates it `(local-only)`); `API_PORT` stays. `ServerConfig`/`loadServerConfig` unchanged (`GATEWAY_PORT` remains in `ENV_KEYS` and parses fine).
- `apps/server/src/__tests__/unified-server.test.ts` **(NEW)** — integration test booting the unified server and asserting REST + WS on the **same** port, consolidated shutdown, and no duplicate signal handlers (see Tests).
- `apps/server/src/__tests__/main.test.ts` **(MODIFY)** — the existing `startServer` suite mocks `@swiftagent/gateway`'s `createGatewayServer` and asserts `listen` is called **twice** ("calls listen on both API and gateway servers"). After this refactor the unified path calls `registerGatewayPlugin` (not `createGatewayServer`) and does **exactly one** `listen`. Update the mock to stub `registerGatewayPlugin` (returning a `GatewayComponents`-shaped object: `connectionManager`, `sessionBridge`, `heartbeat`, `redisPing`), and change the assertion from `toHaveBeenCalledTimes(2)` to `toHaveBeenCalledTimes(1)`. This is a required update — leaving it fails SC-12.
- `apps/server/src/__tests__/config.test.ts` **(MODIFY)** — the `redactConfig` test asserts `summary.GATEWAY_PORT === '3001'`. Since step 6 drops (or annotates `(local-only)`) the `GATEWAY_PORT` banner entry, update this expectation to match the chosen redaction (either remove the assertion or assert the `(local-only)` marker). `loadServerConfig` assertions on `config.GATEWAY_PORT` stay unchanged (the key is retained in `ENV_KEYS`). Required update — leaving it fails SC-12.
- `packages/shared/src/config.ts` **(VERIFY, do not modify)** — confirm `GATEWAY_PORT` stays in `ENV_KEYS`/schema (default 3001). No change; the standalone gateway still reads it.

## Existing Interfaces to Consume

**Current two-listener startup + duplicate shutdown** (`apps/server/src/main.ts`) — the file this workstream refactors:

```ts
export interface ServerContext {
  config: ServerConfig;
  container: Container;
  api: AppContext;
  gateway: GatewayContext; // ← becomes GatewayComponents after this WS
}

export async function startServer(): Promise<ServerContext> {
  const config = loadServerConfig();
  const container = buildContainer(config);

  if (config.AUTO_MIGRATE) { /* … runs drizzle migrate … */ }

  // 4. Build API server (control plane routes)
  const apiPort = config[ENV_KEYS.API_PORT];
  const api = await buildApp({
    runExecutionService: container.runExecutionService,
    repos: { /* … */ },
    jwtSecret: config[ENV_KEYS.CLIENT_JWT_SECRET],
    publicWebsocketUrl: config[ENV_KEYS.PUBLIC_WEBSOCKET_URL],
    cognitoIssuerUrl: config[ENV_KEYS.COGNITO_ISSUER_URL],
    cognitoClientId: config[ENV_KEYS.COGNITO_CLIENT_ID],
    logger: { level: 'info' },
  });

  // 5. Build WebSocket gateway — wired to the SAME run execution service.
  const redisUrl = config[ENV_KEYS.REDIS_URL];
  const redisEnabled = !!redisUrl;
  const gateway = await createGatewayServer(
    {
      jwtSecret: config[ENV_KEYS.CLIENT_JWT_SECRET],
      port: config[ENV_KEYS.GATEWAY_PORT],
      redisUrl: redisEnabled ? redisUrl : undefined,
      redisEnabled,
      logger: { level: 'info' },
    },
    container.runExecutionService,
  );

  // 6. Register combined health check on the API server
  registerHealthCheck(api.app, {
    dbClient: container.dbClient,
    connectionManager: gateway.connectionManager,
    redisEnabled,
  });

  // 7. Start listening  ← TWO listens today (the bug)
  await api.app.listen({ port: apiPort, host: '0.0.0.0' });
  const gatewayPort = config[ENV_KEYS.GATEWAY_PORT];
  await gateway.app.listen({ port: gatewayPort, host: '0.0.0.0' });

  // 8. Startup banner  ← prints both API Port and Gateway Port
  // …

  // 9. Graceful shutdown handlers  ← closes BOTH apps
  const shutdown = async (signal: string) => {
    await gateway.app.close();
    await api.app.close();
    gateway.connectionManager.closeAll(1001, 'Server shutting down');
    gateway.heartbeat.clear();
    await gateway.sessionBridge.shutdown();
    await container.dbClient.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  return { config, container, api, gateway };
}
```

> **Note the double-registration risk:** the gateway server *also* registers its own `SIGTERM`/`SIGINT` handlers internally (see `server.ts` below). Today, using `createGatewayServer` inside `main.ts` means **two** sets of handlers fire on shutdown. Consolidating onto the plugin form (which registers none) removes that duplication.

**Standalone gateway server today** (`packages/gateway/src/server.ts`) — `GatewayContext`, the `/v1/stream` handler, the internal signal handlers, and the standalone `/health`:

```ts
export interface GatewayContext {
  app: FastifyInstance;
  connectionManager: ConnectionManager;
  sessionBridge: SessionBridge;
  heartbeat: HeartbeatManager;
}

export async function createGatewayServer(
  config: GatewayConfig,
  runtime: RuntimeDelegate,
): Promise<GatewayContext> {
  const jwtSecret = new TextEncoder().encode(config.jwtSecret);
  const heartbeatTimeoutMs = config.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;

  const connectionManager = new ConnectionManager();
  const heartbeat = new HeartbeatManager(heartbeatTimeoutMs);

  let redis: RedisPubSubStub;
  if (config.redisEnabled && config.redisUrl) {
    redis = await createRedisPubSub(config.redisUrl);
  } else {
    redis = createNoopRedisPubSub();
  }

  const sessionBridge = new SessionBridge({
    connectionManager, runtime, redis,
    maxReplayBufferSize: config.maxReplayBufferSize,
  });

  const app = Fastify({ logger: config.logger ?? { transport: { target: 'pino-pretty' } } });
  await app.register(websocket);
  app.get('/health', async () => ({ status: 'ok' }));   // ← frozen by existing suite

  // WebSocket endpoint: /v1/stream  ← THIS handler moves to plugin.ts verbatim
  app.register(async (instance) => {
    instance.get('/stream', { websocket: true }, (socket: WebSocket, req) => {
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
      const token = url.searchParams.get('token');
      if (!token) {
        socket.send(JSON.stringify(toErrorEvent('AUTH_REQUIRED', 'Missing token query parameter')));
        socket.close(4001, 'Missing token');
        return;
      }
      void (async () => {
        try {
          const claims = await validateClientToken(token, jwtSecret);
          const { sessionId } = claims;
          connectionManager.add(sessionId, socket);
          heartbeat.attach(socket);
          sessionBridge.replayEvents(sessionId, socket);
          if (config.redisEnabled && config.redisUrl) {
            await redis.subscribe(`session:${sessionId}`, (_channel, message) => {
              connectionManager.sendTo(sessionId, socket, message);
            });
          }
          socket.on('message', (raw: Buffer | string) => { /* ping / send_message / cancel — unchanged */ });
          socket.on('close', () => {
            connectionManager.remove(sessionId, socket);
            heartbeat.detach(socket);
            if (config.redisEnabled) void redis.unsubscribe(`session:${sessionId}`);
          });
          socket.on('error', () => { connectionManager.remove(sessionId, socket); heartbeat.detach(socket); });
        } catch (err) {
          // AuthError → close code 4001/4002/4003 + error frame — unchanged
        }
      })();
    });
  }, { prefix: '/v1' });

  // ── Internal graceful shutdown — REGISTERED ONLY IN THE STANDALONE FORM ──
  const shutdown = async () => {
    await app.close();
    connectionManager.closeAll(1001, 'Server shutting down');
    heartbeat.clear();
    await sessionBridge.shutdown();
  };
  process.on('SIGTERM', () => void shutdown());   // ← plugin form must NOT do this
  process.on('SIGINT', () => void shutdown());

  return { app, connectionManager, sessionBridge, heartbeat };
}

export async function startGateway(
  config: GatewayConfig,
  runtime: RuntimeDelegate,
): Promise<GatewayContext> {
  const ctx = await createGatewayServer(config, runtime);
  const port = config.port ?? DEFAULT_GATEWAY_PORT;
  await ctx.app.listen({ port, host: '0.0.0.0' });
  return ctx;
}
```

**`GatewayConfig` + `RuntimeDelegate` + defaults** (`packages/gateway/src/types.ts`):

```ts
export interface GatewayConfig {
  /** Port to listen on. Default: 3001 */
  port?: number;
  /** JWT secret for client token validation */
  jwtSecret: string;
  /** Heartbeat timeout in ms. Default: 30000 */
  heartbeatTimeoutMs?: number;
  /** Redis URL for pub/sub. Optional — when absent, pub/sub is a no-op */
  redisUrl?: string;
  /** Whether Redis pub/sub is enabled. Default: false */
  redisEnabled?: boolean;
  /** Fastify logger config */
  logger?: boolean | object;
  /** Max buffered events per run for reconnection replay. Default: 200 */
  maxReplayBufferSize?: number;
}

export interface RuntimeDelegate {
  start(
    input: { sessionId: string; content: string },
    opts?: { onEvent?: (event: ChatEvent) => void; signal?: AbortSignal },
  ): Promise<{ runId: string }>;
  requestCancel(runId: string): Promise<{ requested: boolean }>;
}

export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;
export const DEFAULT_GATEWAY_PORT = 3001;
export const DEFAULT_MAX_REPLAY_BUFFER_SIZE = 200;
```

**Redis pub/sub stub** (`packages/gateway/src/session-bridge.ts`) — what the shared helper constructs and what the `redisPing` closure wraps:

```ts
export interface RedisPubSubStub {
  publish(channel: string, payload: string): Promise<void>;
  subscribe(channel: string, handler: RedisMessageHandler): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  disconnect(): Promise<void>;
}
export function createNoopRedisPubSub(): RedisPubSubStub { /* all no-ops */ }
export async function createRedisPubSub(redisUrl: string): Promise<RedisPubSubStub> { /* ioredis-backed */ }
```

**`HealthDeps`** (`apps/server/src/health.ts`) — already carries the optional `redisPing`; `registerGatewayPlugin` returns a matching `redisPing` so `main.ts` can pass it straight through:

```ts
interface HealthDeps {
  dbClient: DbClient;
  connectionManager: ConnectionManager | null;
  redisEnabled: boolean;
  redisPing?: () => Promise<boolean>;
}
export function registerHealthCheck(app: FastifyInstance, deps: HealthDeps): void { /* /health */ }
```

**`buildApp` / `BuildAppOptions` / `AppContext`** (`packages/api/src/server.ts`) — the plugin mounts onto `AppContext.app`; note `buildApp` already registers a root `/health` and a `/v1` prefix, so the gateway plugin's `/v1/stream` composes under the same instance without collision:

```ts
export interface AppContext {
  app: FastifyInstance;
  tokenService: TokenService;
  agentService: AgentService;
  sessionService: SessionService;
}
export async function buildApp(opts: BuildAppOptions): Promise<AppContext> { /* … /v1 routes, /health … */ }
```

**`ENV_KEYS` (excerpt)** (`packages/shared/src/config.ts`) — `GATEWAY_PORT` is kept:

```ts
[ENV_KEYS.API_PORT]: z.coerce.number().int().positive().default(3000),
[ENV_KEYS.GATEWAY_PORT]: z.coerce.number().int().positive().default(3001),
```

**Existing gateway integration expectations** (`packages/gateway/src/__tests__/integration.test.ts`) — the standalone path is frozen; the refactor must not change any of:

```ts
ctx = await createGatewayServer(config, mockRuntime);
const address = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
// GET /health → 200 { status: 'ok' }
// ws /v1/stream?token=…  → connects; ping→pong; send_message → 4-event ChatEvent sequence
// missing token → 4001 AUTH_REQUIRED ; expired → 4001 TOKEN_EXPIRED ; wrong secret → 4003 TOKEN_INVALID
// close → connectionManager.isConnected(sessionId) === false
```

## Design Notes

- **One implementation, two entry points.** The route handler and the component graph (`ConnectionManager` + `HeartbeatManager` + Redis pub/sub + `SessionBridge`) are extracted into `plugin.ts` as `buildGatewayComponents(config)` and `registerStreamRoute(app, deps)`. Both `createGatewayServer` (standalone: builds its own `Fastify()`, registers `/health`, registers signal handlers) and `registerGatewayPlugin` (plugin: registers onto the passed app, no `/health`, no signal handlers) call the **same** two helpers. This is the "single implementation" requirement — do not fork the `/v1/stream` handler. If any behavior diverges between the two forms, that is a bug.

- **The plugin does not own the server lifecycle.** `registerGatewayPlugin(app, config, runtime)` must **not**: create a Fastify app, call `app.listen`, register `SIGTERM`/`SIGINT`, or read `config.port`/`config.logger`. It registers `@fastify/websocket` and the `/v1/stream` route (prefix `/v1`) onto the host (API) app and returns the components for the host to drive shutdown and health. Process-signal handling belongs to `apps/server/src/main.ts` (which owns the whole process) — the standalone `createGatewayServer` keeps its own handlers only for local/dev/test use where it is the process.

- **`@fastify/websocket` registration is idempotent-sensitive — register once.** The API app does **not** register `@fastify/websocket` today; the plugin registers it. If a future change makes `buildApp` register it too, `app.register(websocket)` twice throws (`FST_ERR_PLUGIN_ALREADY_PRESENT`). Register it inside the plugin only. Because both the plugin and the API's own `/v1` routes use a `{ prefix: '/v1' }` encapsulated child, they compose without collision (Fastify allows multiple `register` calls sharing a prefix; the route paths — `/v1/stream` vs `/v1/agents` etc. — are distinct).

- **The `GatewayComponents.redisPing` field is a contract for WS-33.** WS-33 owns the *real* Redis PING implementation and the fanout-correctness work. WS-30 must **define the field now** so WS-33 does not have to change this contract. In WS-30, `redisPing` is a closure that returns `Promise<true>` when Redis is disabled (no-op) and, when enabled, calls a best-effort ping on the pub/sub client (a trivial `async () => true` placeholder is acceptable here **iff** the field exists and is wired into the health check; WS-33 replaces the body with a genuine `PING`). Expose it on `GatewayComponents` and pass it into `registerHealthCheck` — `HealthDeps.redisPing` already exists, so `main.ts` wiring is a one-liner.

- **`GatewayComponents` vs `GatewayContext`.** `GatewayContext` (returned by `createGatewayServer`) includes `app` because the standalone owns its server. `GatewayComponents` (returned by `registerGatewayPlugin`) omits `app` (the host owns it) and adds `redisPing`. Shape: `{ connectionManager: ConnectionManager; sessionBridge: SessionBridge; heartbeat: HeartbeatManager; redisPing: () => Promise<boolean> }`. `ServerContext.gateway` in `main.ts` changes type from `GatewayContext` to `GatewayComponents`; update the import and the return.

- **`GATEWAY_PORT` stays, but is inert on the unified path.** Do not remove it from `ENV_KEYS` or the Zod schema — `createGatewayServer`/`startGateway` still default `port` to it for local dev and the existing tests read the default. The unified server simply never reads `GATEWAY_PORT`. The startup banner should drop the "Gateway Port" line (or render it as `(local-only)`) to avoid implying a second listening port exists. Terraform/ALB no longer needing port 3001 is **WS-31's** concern — only note it here; do not edit infra.

- **Health check must still report gateway connections.** The composed `/health` on the API app (via `registerHealthCheck`) already reads `deps.connectionManager?.connectionCount()`. Pass `gw.connectionManager` (from `registerGatewayPlugin`) and `gw.redisPing`. Do not add a second `/health` — `buildApp` already registers root `/health` + `/v1/health`; the gateway plugin must **not** register its own `/health` (that would collide on the shared app). Only the standalone `createGatewayServer` keeps `app.get('/health', …)`.

- **Redis fanout correctness is out of scope.** The subscribe/publish call sites move verbatim with the handler. Do not "fix" the per-socket subscribe pattern here — WS-33 owns fanout correctness and the single-task limits doc (AD-02). Likewise do not add multi-instance machinery: AD-02 locks the MVP to a **single** gateway task.

- **ESM discipline (CLAUDE.md §10).** After adding `registerGatewayPlugin`, grep for direct references, type-level references, string literals, dynamic imports, re-exports/barrel entries (`index.ts`), and tests/mocks of both `createGatewayServer` and any moved symbol. New files use `.js` import specifiers.

## Implementation Steps

1. **Add types (`packages/gateway/src/types.ts`, MODIFY).** Add:
   ```ts
   /** Config for the plugin form: the host app owns port + logger, so neither appears here. */
   export interface GatewayPluginConfig {
     jwtSecret: string;
     redisUrl?: string;
     redisEnabled?: boolean;
     heartbeatTimeoutMs?: number;
     maxReplayBufferSize?: number;
   }

   /** Components returned by registerGatewayPlugin — the host app drives their lifecycle. */
   export interface GatewayComponents {
     connectionManager: ConnectionManager;
     sessionBridge: SessionBridge;
     heartbeat: HeartbeatManager;
     /** Best-effort Redis liveness for the health check. Returns true when Redis
      *  is disabled. WS-33 replaces the body with a real PING; the field shape is
      *  frozen here so WS-33 does not change this contract. */
     redisPing: () => Promise<boolean>;
   }
   ```
   Import `ConnectionManager`, `SessionBridge`, `HeartbeatManager` as types (avoid a runtime import cycle — use `import type`).

2. **Create the shared helper + plugin (`packages/gateway/src/plugin.ts`, NEW).** Three functions:
   - `buildGatewayComponents(config, runtime): Promise<{ components; redis; jwtSecret; redisActive }>` — constructs `connectionManager`, `heartbeat`, the Redis pub/sub (`createRedisPubSub` when `redisEnabled && redisUrl`, else `createNoopRedisPubSub`), the `sessionBridge`, the encoded `jwtSecret`, and the `redisPing` closure (`async () => true` when Redis inactive; a best-effort ping when active — WS-33 hardens). Returns the `GatewayComponents` plus the internals `registerStreamRoute` needs.
   - `registerStreamRoute(app, deps): Promise<void>` — `await app.register(websocket)` then `app.register(async (instance) => { instance.get('/stream', { websocket: true }, handler) }, { prefix: '/v1' })`. **Move the `/v1/stream` handler body here verbatim** from `server.ts` (token extraction, auth, `connectionManager.add`, `heartbeat.attach`, `sessionBridge.replayEvents`, Redis subscribe, `message`/`close`/`error` handlers, the AuthError close-code mapping). It closes over `deps` (jwtSecret, connectionManager, heartbeat, sessionBridge, redis, redisActive).
   - `registerGatewayPlugin(app: FastifyInstance, config: GatewayPluginConfig, runtime: RuntimeDelegate): Promise<GatewayComponents>` — calls `buildGatewayComponents`, calls `registerStreamRoute`, returns the `GatewayComponents`. **No `Fastify()`, no `listen`, no `/health`, no signal handlers.**

3. **Refactor `createGatewayServer` (`packages/gateway/src/server.ts`, MODIFY).** Replace the inlined component construction + route registration with calls to `buildGatewayComponents` + `registerStreamRoute` (the same helpers step 2 defines). Keep: `Fastify({ logger: config.logger ?? … })`, `app.get('/health', …)` returning `{ status: 'ok' }`, the internal `SIGTERM`/`SIGINT` `shutdown()`, and the `GatewayContext` return `{ app, connectionManager, sessionBridge, heartbeat }`. Adapt the `GatewayConfig` → helper inputs (map `port`/`logger` away — those stay in `createGatewayServer`). `startGateway` is unchanged. **Verify the existing integration suite still passes unmodified.**

4. **Export the new API (`packages/gateway/src/index.ts`, MODIFY).** Add:
   ```ts
   export { registerGatewayPlugin } from './plugin.js';
   export type { GatewayPluginConfig, GatewayComponents } from './types.js';
   ```
   Keep all current exports (`createGatewayServer`, `startGateway`, `GatewayContext`, etc.).

5. **Refactor `apps/server/src/main.ts` (MODIFY).**
   - Change the import: `import { createGatewayServer, type GatewayContext }` → add `registerGatewayPlugin, type GatewayComponents`. (Keep `createGatewayServer` imported only if still used elsewhere; it is not used by the unified path — remove it if unused to satisfy lint, per CLAUDE.md "Step 0".)
   - `ServerContext.gateway: GatewayComponents` (was `GatewayContext`).
   - After `buildApp(...)`, replace the `createGatewayServer(...)` call with:
     ```ts
     const redisUrl = config[ENV_KEYS.REDIS_URL];
     const redisEnabled = !!redisUrl;
     const gw = await registerGatewayPlugin(
       api.app,
       {
         jwtSecret: config[ENV_KEYS.CLIENT_JWT_SECRET],
         redisUrl: redisEnabled ? redisUrl : undefined,
         redisEnabled,
         // no port / no logger — the API app owns both
       },
       container.runExecutionService,
     );
     ```
   - Health check: `registerHealthCheck(api.app, { dbClient: container.dbClient, connectionManager: gw.connectionManager, redisEnabled, redisPing: gw.redisPing });`
   - **Single listen:** `await api.app.listen({ port: apiPort, host: '0.0.0.0' });` — delete the second `gateway.app.listen`.
   - Banner: drop the `Gateway Port:` line (or mark `(local-only)`); keep `API Port:`.
   - **One shutdown path** (drop the duplicate — the plugin registers none):
     ```ts
     const shutdown = async (signal: string) => {
       await api.app.close();
       gw.connectionManager.closeAll(1001, 'Server shutting down');
       gw.heartbeat.clear();
       await gw.sessionBridge.shutdown();
       await container.dbClient.close();
       process.exit(0);
     };
     process.on('SIGTERM', () => void shutdown('SIGTERM'));
     process.on('SIGINT', () => void shutdown('SIGINT'));
     ```
   - Return `{ config, container, api, gateway: gw }`.

6. **Update the banner/redaction (`apps/server/src/config.ts`, MODIFY).** In `redactConfig`, drop the `GATEWAY_PORT` entry or change it to `GATEWAY_PORT: '(local-only)'`; keep `API_PORT`. Leave `ServerConfig`/`loadServerConfig` unchanged (`GATEWAY_PORT` still parses; it's just not surfaced as a listening port in the unified banner).

7. **Verify `GATEWAY_PORT` retention (`packages/shared/src/config.ts`, VERIFY — no edit).** Confirm `GATEWAY_PORT` remains in `ENV_KEYS` and the Zod schema (default 3001). Do not remove it — the standalone gateway + tests depend on it.

8. **Author the unified-server integration test (`apps/server/src/__tests__/unified-server.test.ts`, NEW).** See Tests §2–4. Boot via `buildApp(...)` + `registerGatewayPlugin(api.app, …)` (with a mock `RuntimeDelegate`, mirroring the gateway suite's mock, and an HS256-signed token), `listen({ port: 0 })`, then assert REST + WS on the same address, consolidated shutdown, and single-registration semantics.

9. **Forced verification (CLAUDE.md §4).** Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm test:integration`. Fix every error. Grep (CLAUDE.md §10) for all references to `createGatewayServer`, `GatewayContext`, and the moved handler symbols across the monorepo to confirm nothing else broke. Report results explicitly.

## Tests

1. **Existing gateway suite is untouched (regression).** `packages/gateway/src/__tests__/integration.test.ts` (and the unit suites `auth`, `connection-manager`, `events`, `heartbeat`, `session-bridge`, `cancel-protocol`) pass **unmodified**: `createGatewayServer` still builds its own app, serves `GET /health` → `{ status: 'ok' }`, accepts `/v1/stream?token=…`, maps auth failures to close codes 4001/4002/4003, answers ping→pong, and streams the 4-event ChatEvent sequence. This proves the extraction preserved standalone behavior.

2. **Unified server serves REST + WS on ONE port (SC-01, new).** In `unified-server.test.ts`: build `api = await buildApp({ … mock repos + mock runExecutionService …, jwtSecret })`; `const gw = await registerGatewayPlugin(api.app, { jwtSecret, redisEnabled: false }, mockRuntime)`; `registerHealthCheck(api.app, { dbClient: mockDb, connectionManager: gw.connectionManager, redisEnabled: false, redisPing: gw.redisPing })`; `const address = await api.app.listen({ port: 0, host: '127.0.0.1' })`. Then assert **both** on the **same** `address`:
   - REST: `fetch(`${address}/health`)` → 200, body `checks.gateway.connections` present (the composed health shape from `health.ts`).
   - WS: connect `new WebSocket(`${address.replace('http','ws')}/v1/stream?token=${validHs256Token}`)`, `waitForOpen`, send `{ type: 'send_message', content: 'hi' }`, collect the mock runtime's ChatEvent sequence. Assert the socket opened and events arrived on the same host:port as the REST call. Capture the port from `address` and assert only **one** port was bound (no `GATEWAY_PORT` listener).

3. **Consolidated graceful shutdown drains sockets with 1001 (SC-05, new).** Open one authed `/v1/stream` socket against the unified app; register a `close` listener capturing the code; invoke the same shutdown sequence `main.ts` uses (`await api.app.close(); gw.connectionManager.closeAll(1001, …); gw.heartbeat.clear(); await gw.sessionBridge.shutdown();`). Assert the client socket closes with code **1001**, and that a second `WebSocket` connect attempt to `/v1/stream` after `app.close()` fails/does not open (server stopped accepting). Assert no second port was ever opened.

4. **Plugin form registers NO process signal handlers (unit, new).** Before calling `registerGatewayPlugin`, snapshot `process.listenerCount('SIGTERM')` and `process.listenerCount('SIGINT')`; call `registerGatewayPlugin(api.app, …)`; assert both counts are **unchanged** (the plugin added zero). Contrast (optionally, in an isolated test that cleans up its listeners with `process.removeListener`): `createGatewayServer(...)` **does** add one `SIGTERM` and one `SIGINT` handler — proving the split. This guards against the double-handler bug the old `main.ts` had.

5. **Health check reports gateway connection count (new).** With the unified app listening and one authed socket connected, `fetch(`${address}/health`)` and assert `body.checks.gateway.connections === 1`; after the socket closes and a tick passes, assert it drops to `0`. Confirms `gw.connectionManager` is wired into `registerHealthCheck` and `redisPing` (disabled → `redis: 'disabled'`) does not error.

6. **`registerGatewayPlugin` does not create its own app or listen (unit, new).** Assert `registerGatewayPlugin` returns a `GatewayComponents` with `connectionManager`, `sessionBridge`, `heartbeat`, and a callable `redisPing` (→ resolves `true` when `redisEnabled: false`), and that it exposes **no** `app` field (type-level: `GatewayComponents` has no `app`). Assert calling it twice on two *different* Fastify apps is fine, but registering `@fastify/websocket` is scoped to the passed app (no cross-app leakage).

## Acceptance Criteria

1. `packages/gateway` exports `registerGatewayPlugin(app: FastifyInstance, config: GatewayPluginConfig, runtime: RuntimeDelegate): Promise<GatewayComponents>` from `index.ts`, where `GatewayComponents = { connectionManager: ConnectionManager; sessionBridge: SessionBridge; heartbeat: HeartbeatManager; redisPing: () => Promise<boolean> }`. The plugin registers `@fastify/websocket` and the `/v1/stream` route (prefix `/v1`) **onto the passed app**; it does **not** create a Fastify app, call `listen`, register `/health`, or register any `SIGTERM`/`SIGINT` handler.
2. `redisPing` exists on the returned `GatewayComponents` and resolves `true` when Redis is disabled (no-op); its field shape is frozen so WS-33 can swap in a real `PING` body without changing this contract. It is passed into `registerHealthCheck` in `main.ts`.
3. `createGatewayServer` and `startGateway` remain exported with **unchanged external behavior**: the standalone gateway still builds its own Fastify app, serves `GET /health` → `{ status: 'ok' }`, registers its own signal handlers, and passes the existing gateway integration + unit suites **unmodified**. The `/v1/stream` handler and component graph have a **single implementation** shared by both the standalone server and the plugin (via `buildGatewayComponents` + `registerStreamRoute` in `plugin.ts`).
4. `apps/server/src/main.ts` builds **one** Fastify app: after `buildApp(...)` it calls `registerGatewayPlugin(api.app, {...}, container.runExecutionService)`, registers the health check with the returned components, and does exactly **one** `await api.app.listen({ port: apiPort, host: '0.0.0.0' })`. There is no second `listen` and no reference to `GATEWAY_PORT` on the unified path (SC-01).
5. Graceful shutdown is a **single** path in `main.ts` that closes `api.app`, drains WebSockets via `gw.connectionManager.closeAll(1001, …)`, clears `gw.heartbeat`, shuts down `gw.sessionBridge`, and closes the DB pool — with **no** duplicate handlers (the plugin registers none). A shutdown test asserts client sockets close with code **1001** and no new connections are accepted afterward (SC-05).
6. `GATEWAY_PORT` remains defined in `@swiftagent/shared` `ENV_KEYS`/schema (default 3001) and is still used by `createGatewayServer`/`startGateway`; the unified startup banner drops (or marks `(local-only)`) the "Gateway Port" line while keeping "API Port".
7. The composed `/health` on the API app still reports `checks.gateway.connections` via `gw.connectionManager`, verified to reflect live connection count (1 with a socket open, 0 after close).
8. A new integration test boots the unified server (`buildApp` + `registerGatewayPlugin`) and asserts a REST call (`GET /health`) **and** a WebSocket connect to `/v1/stream?token=<jwt>` both succeed on the **same** listening port; a unit assertion confirms the plugin form adds **zero** `SIGTERM`/`SIGINT` listeners.
9. No infra (Terraform/ECS/ALB/Dockerfile), `PUBLIC_WEBSOCKET_URL` guard, Redis fanout/`redisPing` body, SDK/docs, or deployed smoke tests are modified here — those are WS-31/32/33/34/35. `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:integration` all pass (SC-12).
