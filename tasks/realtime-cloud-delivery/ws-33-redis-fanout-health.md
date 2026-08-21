# WS-33: Redis Fanout Correctness & Health

## Goal

Make the gateway's Redis pub/sub fanout **provably correct on a single subscribing instance** and make `/health` **tell the truth about Redis**, then **document the single-task MVP limits** so operators understand the posture the runtime actually ships with.

Three cohesive deliverables:

1. **Fanout correctness.** Trace the delivery path end to end: the runtime emits a `ChatEvent` → `SessionBridge.handleSendMessage` broadcasts it to LOCAL connections via `connectionManager.broadcast(sessionId, event)` **and** publishes it to the Redis channel `session:${sessionId}` → a connecting socket in `server.ts` `subscribe`s to that same channel and, on receiving a message, forwards it via `connectionManager.sendTo(sessionId, socket, message)`. On a single instance these two paths **overlap**: the originating instance both broadcasts locally *and* (because its own sockets are subscribed to `session:${sessionId}`) receives its own publish back over Redis and forwards it again — every socket on that instance receives each event **twice**. This is a real double-delivery bug. WS-33 fixes it so each locally-connected socket receives each event **exactly once**, with **zero missed** deliveries, and pins down the exact intended semantics in a doc comment.

2. **Redis health wiring.** `HealthDeps.redisPing?: () => Promise<boolean>` already exists and is honored by `registerHealthCheck`, but `apps/server/src/main.ts` calls `registerHealthCheck` **without** a `redisPing`, so whenever a Redis URL is set `/health` blindly reports `checks.redis: 'ok'` even if Redis is down. WS-33 implements a **real** `redisPing` (an actual Redis `PING`) on the gateway plugin's returned `GatewayComponents.redisPing` (WS-30 stubs it) and passes it into `registerHealthCheck`, so `/health` reports `checks.redis: 'ok' | 'error' | 'disabled'` truthfully and returns **503** when Redis is enabled but unreachable.

3. **Documented MVP limits.** A new operations runbook `docs/runbooks/realtime-operations.md` documents the locked single-task posture (desired_count = 1), the **process-local** replay buffer (lost on instance restart), the **process-bound** session lock (`SessionLock`), in-flight-run behavior on deploy/restart (runs are process-bound and abandoned on restart per the Phase 2 durable-execution boundary), and reconnect-replay semantics (buffered events replayed on reconnect only while the run is active **and** only on the same instance), cross-referencing that horizontal scale is Phase 2.

This workstream changes **no** stream event protocol, **no** runtime loop, and **no** DB schema. It is purely fanout correctness + a health probe + docs.

## Traceability

- **SC-06** — Redis fanout delivers run events to locally-connected sockets on the subscribing instance (exactly once, no double-delivery, no misses), and `/health` reports Redis reachability via a real `PING`.
- **SC-07** — The single-task posture, the process-local replay-buffer and process-bound session-lock limits, and the in-flight-run / reconnect-replay behavior are documented in an operations runbook that cross-references the Phase 2 horizontal-scale boundary.
- **SC-12** — `pnpm exec tsc --noEmit`, `pnpm exec eslint . --quiet`, and the new unit + integration tests pass.

## Dependencies

- **WS-30 — Unified Realtime Server (Port Consolidation).** Provides `registerGatewayPlugin(app, config, runtime): Promise<GatewayComponents>` where `GatewayComponents = { connectionManager, sessionBridge, heartbeat, redisPing }`. WS-30 stubs `redisPing` (returns `true` when Redis is disabled); **WS-33 implements the real `redisPing` (an actual Redis PING) and wires it into `/health`**. WS-33 **does not** change the `registerGatewayPlugin` signature or the `GatewayComponents` shape — it only fills in the real behavior behind the existing `redisPing` field and the unified health-wiring point WS-30 established.

## Context Files (Agent MUST read before implementing)

- `c:\dev\swift-agent\CLAUDE.md` — conventions (Zod schemas source of truth; factory functions; forced verification via `tsc --noEmit` + `eslint`; NO semantic search — grep for every reference when touching a name).
- `c:\dev\swift-agent\packages\gateway\src\session-bridge.ts` — **read closely.** `RedisPubSubStub` interface; `createRedisPubSub(redisUrl)` (two `ioredis` connections, one pub / one sub, a `handlers` map keyed by channel); `createNoopRedisPubSub()`; the `publish` / `subscribe` / `unsubscribe` / `disconnect` methods; `SessionBridge.handleSendMessage` (the `onEvent` sink that both `broadcast`s locally AND `void this.redis.publish('session:${sessionId}', ...)`); the per-session `replayBuffers` map and `replayEvents`.
- `c:\dev\swift-agent\packages\gateway\src\server.ts` — the connection flow: `connectionManager.add`, `heartbeat.attach`, `sessionBridge.replayEvents`, the `if (config.redisEnabled && config.redisUrl) { await redis.subscribe('session:${sessionId}', (_channel, message) => connectionManager.sendTo(sessionId, socket, message)); }` block, and the `socket.on('close', ...)` that `void redis.unsubscribe('session:${sessionId}')`. This subscribe/forward block is the second half of the double-delivery bug and the place the correctness fix lands.
- `c:\dev\swift-agent\packages\gateway\src\connection-manager.ts` — `broadcast`, `sendTo`, `sendError`, `getConnections`, `isConnected`, `connectionCount`, `closeAll`, `safeSend` (dead-socket removal). No new methods are required; the fix is in the bridge/server wiring, not here.
- `c:\dev\swift-agent\packages\gateway\src\types.ts` — `GatewayConfig` (`redisUrl?`, `redisEnabled?`), `RuntimeDelegate`, `DEFAULT_*` constants. If a channel-subscription refactor needs a new config knob, it goes here — but prefer no new config (see Design Notes).
- `c:\dev\swift-agent\apps\server\src\health.ts` — `HealthDeps.redisPing?: () => Promise<boolean>` (accepted but never wired by `main.ts`), and the `if (deps.redisEnabled && deps.redisPing) { ... }` block that sets `checks.redis: 'error'` + `status: 'degraded'` (→ 503). No change to this file's logic is required; it already honors `redisPing` — the gap is the caller.
- `c:\dev\swift-agent\apps\server\src\main.ts` — the `registerHealthCheck(api.app, { dbClient, connectionManager: gateway.connectionManager, redisEnabled })` call that omits `redisPing`. This is the single wiring point WS-33 fixes.
- `c:\dev\swift-agent\apps\server\src\container.ts` — how the gateway/runtime deps are wired. No Redis client is created here today; `createRedisClient` lives in `@swiftagent/shared`. Read to confirm there is no existing Redis client to reuse for the ping (there is not — the gateway's pub/sub owns the only Redis connections).
- `c:\dev\swift-agent\packages\shared\src\redis-client.ts` / `c:\dev\swift-agent\packages\shared\src\index.ts` — `export function createRedisClient(url: string): Redis` (thin `new Redis(url)`), re-exported from the shared barrel. The `PING` implementation should reuse an existing gateway `ioredis` connection rather than opening a third one (see Design Notes).
- `c:\dev\swift-agent\apps\server\src\__tests__\health.test.ts` — the existing health-check test harness (`registerHealthCheck` with a mock `dbClient` + injected `redisPing`); mirror it for the "redis ok / error / disabled" cases.
- `c:\dev\swift-agent\docs\runbooks\migrations.md` — the house style for an operations runbook (numbered sections, principle bullets, explicit escape hatches). Match its tone for the new `realtime-operations.md`.
- `c:\dev\swift-agent\packages\runtime\src\session-lock.ts` — the `SessionLock` referenced by the docs (process-bound, in-memory) so the "process-bound session lock" limit is described accurately.

## Package

`packages/gateway`, `apps/server`, `docs/`.

(`packages/shared` is **read** for `createRedisClient` but is not modified. No `packages/db` / schema / migration change.)

## Files Touched

- `packages/gateway/src/session-bridge.ts` **(MODIFY)** — expose a `ping(): Promise<boolean>` on `RedisPubSubStub` (real impl issues `PING`; no-op returns a documented value — see Design Notes) so the gateway can report Redis reachability without opening a third connection; refine the fanout so an event published to `session:${sessionId}` is delivered to each local socket exactly once (see Design Notes for the chosen fix).
- `packages/gateway/src/server.ts` **(MODIFY)** — remove the double-delivery: change the per-socket Redis subscribe/forward so the originating instance does not re-deliver its own locally-broadcast events; ensure `socket.on('close')` unsubscribes exactly the right channel with no leak (guard the ref-counted single subscription per session — see Design Notes).
- `packages/gateway/src/index.ts` **(MODIFY, if needed)** — re-export any new helper/type (e.g. a `createRedisPing` factory) that WS-30's `registerGatewayPlugin` consumes to populate `GatewayComponents.redisPing`. (If WS-30 already imports `createRedisPubSub` internals, no new export is needed — verify by grep.)
- `apps/server/src/main.ts` **(MODIFY)** — pass `redisPing: gateway.redisPing` (from the `GatewayComponents` / `GatewayContext` returned by the plugin) into `registerHealthCheck`.
- `apps/server/src/health.ts` **(NO LOGIC CHANGE)** — already honors `redisPing`; touch only if a doc comment clarifying the wiring is warranted. State explicitly in the PR that no behavioral change was made here.
- `docs/runbooks/realtime-operations.md` **(NEW)** — the MVP-limits operations runbook (single-task posture, replay buffer, session lock, in-flight-run behavior on restart, reconnect-replay semantics, Phase 2 cross-reference).
- `packages/gateway/src/__tests__/fanout.test.ts` **(NEW)** — fanout correctness tests (exactly-once local delivery, no double-delivery on the originating instance, unsubscribe-on-disconnect / no channel leak) using fake sockets + an in-memory Redis pub/sub double (or `ioredis-mock` / Testcontainers Redis — see Tests).
- `packages/gateway/src/__tests__/redis-ping.test.ts` **(NEW)** — `ping()` returns `true` on a healthy client and `false` on a failing `PING`.
- `apps/server/src/__tests__/health.test.ts` **(MODIFY)** — add a case asserting `checks.redis: 'ok'` + 200 when `redisPing` resolves `true`, keeping the existing `'error'`/503 and `'disabled'` cases.

## Existing Interfaces to Consume

**`RedisPubSubStub` + `createRedisPubSub` + `createNoopRedisPubSub`** (`packages/gateway/src/session-bridge.ts`) — the pub/sub contract to extend with `ping()` and the real ioredis wiring to reuse for the PING:

```typescript
export type RedisMessageHandler = (channel: string, message: string) => void;

/**
 * Redis pub/sub interface for horizontal scaling.
 * When disabled (MVP default), all methods are no-ops.
 * When enabled, uses a real ioredis client.
 */
export interface RedisPubSubStub {
  publish(channel: string, payload: string): Promise<void>;
  subscribe(channel: string, handler: RedisMessageHandler): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  disconnect(): Promise<void>;
}

export function createNoopRedisPubSub(): RedisPubSubStub {
  return {
    async publish() {},
    async subscribe() {},
    async unsubscribe() {},
    async disconnect() {},
  };
}

export async function createRedisPubSub(redisUrl: string): Promise<RedisPubSubStub> {
  const { Redis } = await import('ioredis');
  const pub = new Redis(redisUrl);
  const sub = new Redis(redisUrl);
  const handlers = new Map<string, RedisMessageHandler>();

  sub.on('message', (channel: string, message: string) => {
    const handler = handlers.get(channel);
    if (handler) handler(channel, message);
  });

  return {
    async publish(channel, payload) {
      await pub.publish(channel, payload);
    },
    async subscribe(channel, handler) {
      handlers.set(channel, handler);
      await sub.subscribe(channel);
    },
    async unsubscribe(channel) {
      handlers.delete(channel);
      await sub.unsubscribe(channel);
    },
    async disconnect() {
      handlers.clear();
      await sub.quit();
      await pub.quit();
    },
  };
}
```

**`SessionBridge.handleSendMessage` — the broadcast + publish sink** (`packages/gateway/src/session-bridge.ts`) — where local broadcast and Redis publish both happen for every event:

```typescript
await this.runtime.start(
  { sessionId, content },
  {
    onEvent: (event) => {
      emitted = true;

      // Track runId for the reconnection replay buffer.
      if ('runId' in event && event.runId) {
        let buffer = this.replayBuffers.get(sessionId);
        if (!buffer || buffer.runId !== event.runId) {
          buffer = { runId: event.runId, events: [] };
          this.replayBuffers.set(sessionId, buffer);
        }
        if (buffer.events.length < this.maxReplayBufferSize) {
          buffer.events.push(event);
        }
      }

      // Broadcast to all connections for this session.
      this.connectionManager.broadcast(sessionId, event);

      // Also publish to Redis for horizontal scaling (fire-and-forget:
      // onEvent is synchronous; the no-op default never rejects).
      void this.redis.publish(`session:${sessionId}`, JSON.stringify(event));
    },
  },
);
```

**The per-socket subscribe/forward block** (`packages/gateway/src/server.ts`) — the second half of the double-delivery bug; on the originating instance this forwards the instance's own publish back to its own sockets:

```typescript
// Subscribe to Redis channel for horizontal scaling
if (config.redisEnabled && config.redisUrl) {
  await redis.subscribe(`session:${sessionId}`, (_channel, message) => {
    connectionManager.sendTo(sessionId, socket, message);
  });
}
```

**The disconnect / unsubscribe block** (`packages/gateway/src/server.ts`) — must unsubscribe without leaking and without tearing down a channel other sockets still need:

```typescript
socket.on('close', () => {
  connectionManager.remove(sessionId, socket);
  heartbeat.detach(socket);
  if (config.redisEnabled) {
    void redis.unsubscribe(`session:${sessionId}`);
  }
});
```

> Note the existing subscription model is **per-socket** (`subscribe` is called on every connection and overwrites `handlers.get(channel)` because `handlers` is keyed by channel, not by socket). With N sockets on one instance sharing a session, the last `subscribe` wins the single `handlers` entry and forwards to only the last socket, while the first socket's `close` `unsubscribe`s the channel out from under still-open siblings. This is a second correctness defect (missed delivery + premature unsubscribe) the fix must resolve alongside the double-delivery.

**`HealthDeps` + the Redis health block** (`apps/server/src/health.ts`) — already honors `redisPing`; the gap is the caller (`main.ts`) never supplies one:

```typescript
interface HealthDeps {
  dbClient: DbClient;
  connectionManager: ConnectionManager | null;
  redisEnabled: boolean;
  redisPing?: () => Promise<boolean>;
}

// ...inside registerHealthCheck's handler:
result.checks.redis = deps.redisEnabled ? 'ok' : 'disabled';
// ...
// Check Redis if enabled
if (deps.redisEnabled && deps.redisPing) {
  try {
    const ok = await deps.redisPing();
    if (!ok) {
      result.checks.redis = 'error';
      result.status = 'degraded';
    }
  } catch {
    result.checks.redis = 'error';
    result.status = 'degraded';
  }
}
const statusCode = result.status === 'ok' ? 200 : 503;
```

**The health wiring point** (`apps/server/src/main.ts`) — the call that omits `redisPing`:

```typescript
// 6. Register combined health check on the API server
registerHealthCheck(api.app, {
  dbClient: container.dbClient,
  connectionManager: gateway.connectionManager,
  redisEnabled,
});
```

**`createRedisClient`** (`packages/shared/src/redis-client.ts`, re-exported from the shared barrel) — available if a dedicated ping connection were ever needed, but see Design Notes for why the PING should reuse the pub/sub's existing connection instead:

```typescript
import { Redis } from 'ioredis';
export function createRedisClient(url: string): Redis {
  return new Redis(url);
}
```

**`GatewayComponents` (from WS-30, consumed unchanged)** — the shape whose `redisPing` field WS-33 fills in:

```typescript
// WS-30 (dependency) — DO NOT change this signature.
export interface GatewayComponents {
  connectionManager: ConnectionManager;
  sessionBridge: SessionBridge;
  heartbeat: HeartbeatManager;
  redisPing: () => Promise<boolean>; // WS-30 stubs → true when Redis disabled;
                                     // WS-33 implements the real PING.
}
export function registerGatewayPlugin(
  app: FastifyInstance,
  config: GatewayConfig,
  runtime: RuntimeDelegate,
): Promise<GatewayComponents>;
```

## Design Notes

- **The exact intended fanout semantics (single instance, MVP).** For a session `S` with sockets `{a, b}` connected to the one instance, when the runtime emits event `E`:
  - **Local broadcast is the source of truth for locally-connected sockets.** `connectionManager.broadcast(S, E)` delivers `E` to `a` and `b` exactly once each. This path is synchronous, in-process, and always correct.
  - **Redis publish exists for the *future* multi-instance case.** `redis.publish('session:S', E)` is what a *different* instance's sockets would consume. On a single instance there is no other instance, so the publish has **no local consumer** — the local subscription must **not** re-deliver `E` to `a`/`b`.
  - **Therefore: the instance that originates an event must not forward that same event to its own sockets over Redis.** Locally-broadcast delivery and Redis-forwarded delivery are mutually exclusive per socket per event. The concrete fix is one of the two below; pick the first unless grep of WS-30's plugin shows it already centralizes subscription.

- **Chosen fix — one subscription per session per instance, forwarding only to sockets that did NOT get the local broadcast.** Because on a single instance *every* local socket already receives `E` via `broadcast`, the correct single-instance behavior is: **the local Redis subscription forwards nothing to locally-connected sockets** (they are already served). The Redis path is dormant-but-wired for Phase 2. Implement by:
  1. Moving the `session:${sessionId}` subscription off the per-socket path and onto a **per-session, ref-counted** subscription managed centrally (in `SessionBridge` or a small `ChannelRegistry`), created on the first socket for `S` and torn down (`unsubscribe`) only when the **last** socket for `S` closes. This alone fixes the "last-subscribe-wins / first-close-unsubscribes" defect.
  2. The subscription's handler forwards an incoming Redis message to session `S`'s sockets **only for events that did not originate on this instance.** For the single-task MVP, the originating instance is always *this* instance, so the handler is effectively a no-op locally; guard it so it does not double-deliver. Document that the cross-instance forward (A publishes, B forwards to B's sockets) is the Phase 2 activation of this path and is intentionally exercised only trivially here.
  - Rationale: this keeps the Redis call sites intact (horizontal scale stays a config flip, per WS-06's original intent) while making single-instance delivery exactly-once. It also fixes the missed-delivery and premature-unsubscribe defects in the current per-socket subscription in one move.

- **Alternative rejected — suppress the local `broadcast` and deliver *only* via Redis.** Routing every event through Redis even for locally-connected sockets would unify the path, but it (a) adds a network round-trip and JSON re-parse to the hot path for the common single-instance case, (b) makes delivery depend on Redis liveness even when Redis is irrelevant, and (c) reorders/loses events if the publish is fire-and-forget. Local broadcast staying authoritative for local sockets is simpler and strictly more reliable for the MVP.

- **Redis PING reuses an existing connection.** Add `ping(): Promise<boolean>` to `RedisPubSubStub`. In `createRedisPubSub`, implement it by issuing `PING` on the **existing `pub` (or `sub`) ioredis connection** and returning `true` iff the reply is `'PONG'`, `false` on any error/timeout (catch, do not throw). Do **not** open a third `createRedisClient` connection just for health — that adds a socket per instance and can report healthy while the pub/sub connections are down. For `createNoopRedisPubSub`, `ping()` returns `true` — but this is only ever consulted through `redisPing`, and `redisPing` is only passed to `/health` when `redisEnabled` is true (see next note), so the no-op ping is never the source of a misleading "ok". Guard the ping with a short timeout (e.g. `Promise.race` against a ~1s timer resolving `false`) so a hung Redis cannot hang `/health`.

- **`GatewayComponents.redisPing` semantics.** WS-30 defines `redisPing: () => Promise<boolean>` and stubs it to return `true` when Redis is disabled. WS-33 makes it delegate to the pub/sub's `ping()` when Redis is enabled. In `main.ts`, pass `redisPing: gateway.redisPing` into `registerHealthCheck`. Because `health.ts` only *calls* `redisPing` when `deps.redisEnabled` is true, and reports `'disabled'` otherwise, the disabled path never invokes the real ping — `checks.redis` is `'disabled'` exactly when Redis is off, `'ok'`/`'error'` (with 503 on error) exactly when it is on. This closes the current gap where `checks.redis` was assumed `'ok'` whenever a URL was set.

- **No new config knob.** `GatewayConfig.redisEnabled` / `redisUrl` already gate the whole Redis path. The ref-counted subscription and the ping ride on that same flag; do not add a new env var (keeps WS-32's config surface untouched).

- **`main.ts` vs the unified plugin (post-WS-30).** After WS-30 unifies onto one port, `main.ts` (or its successor bootstrap) obtains `GatewayComponents` from `registerGatewayPlugin` and wires `/health` on the same app. WS-33's `main.ts` edit is a one-liner (add `redisPing`) regardless of whether WS-30 kept `createGatewayServer` or moved to the plugin — consume the `redisPing` field off whatever WS-30 returns. If WS-30 has not landed when implementing, wire against the current `createGatewayServer` `GatewayContext` and add `redisPing` there, then reconcile at merge — but prefer sequencing after WS-30.

- **Docs placement — a NEW `docs/runbooks/realtime-operations.md`.** The MVP limits are an *operations* concern (what breaks on restart, what a single task can and cannot do), parallel to the existing `docs/runbooks/migrations.md`. A dedicated runbook keeps this separate from the developer quickstart (WS-34's territory) and from the deploy/drain tuning docs (WS-31). State in the file's header that horizontal scale is Phase 2 and cross-link the program doc.

## Implementation Steps

1. **Extend `RedisPubSubStub` with `ping()` (`packages/gateway/src/session-bridge.ts`).** Add `ping(): Promise<boolean>` to the interface. In `createNoopRedisPubSub`, add `async ping() { return true; }`. In `createRedisPubSub`, add a `ping` that races a real `PING` against a ~1s timeout:
   ```typescript
   async ping() {
     try {
       const pong = await Promise.race([
         pub.ping(),
         new Promise<string>((resolve) => setTimeout(() => resolve('TIMEOUT'), 1000)),
       ]);
       return pong === 'PONG';
     } catch {
       return false;
     }
   }
   ```
   Do not open a new connection — reuse `pub`.

2. **Centralize the session subscription (fix double-delivery + missed-delivery + premature-unsubscribe).** Replace the per-socket `subscribe`/`unsubscribe` in `server.ts` with a ref-counted, per-session subscription. Introduce a small helper (in `SessionBridge` or a new `ChannelRegistry` in the gateway package) that:
   - On the first socket for `sessionId`, calls `redis.subscribe('session:${sessionId}', handler)` and sets refcount = 1; on subsequent sockets, increments the refcount without re-subscribing.
   - On each socket close, decrements; on reaching 0, calls `redis.unsubscribe('session:${sessionId}')`.
   - The `handler` forwards an incoming Redis message to `sessionId`'s local sockets **only for cross-instance events** (Phase 2). For the single-task MVP, because the originating instance already delivered via `broadcast`, the handler must NOT re-forward this instance's own publishes — implement so that locally-originated events are not double-delivered (e.g. the handler is a no-op on the single instance, or tags/filters self-originated messages). Add a doc comment stating the intended cross-instance semantics.

3. **Wire the subscription lifecycle into `server.ts`.** In the connection handler, replace the inline `if (config.redisEnabled && config.redisUrl) { await redis.subscribe(...) }` with a call to the ref-counted registry (acquire on connect). In `socket.on('close')` and `socket.on('error')`, replace the inline `void redis.unsubscribe(...)` with the registry's release. Keep the `broadcast` path in `SessionBridge.handleSendMessage` exactly as-is — local broadcast stays authoritative.

4. **Expose the real `redisPing` (via WS-30's `GatewayComponents`).** Ensure the gateway surfaces `redisPing: () => this.redis.ping()` (delegating to the pub/sub's `ping`). If WS-30's `registerGatewayPlugin` already declares `redisPing`, implement it to call the pub/sub `ping()` (returns `true` from the no-op when disabled). If implementing before WS-30 lands, add `redisPing` to the current `GatewayContext` returned by `createGatewayServer` and reconcile at merge.

5. **Pass `redisPing` into the health check (`apps/server/src/main.ts`).** Change the `registerHealthCheck` call to include `redisPing: gateway.redisPing`:
   ```typescript
   registerHealthCheck(api.app, {
     dbClient: container.dbClient,
     connectionManager: gateway.connectionManager,
     redisEnabled,
     redisPing: gateway.redisPing,
   });
   ```
   No change to `health.ts` logic — it already consumes `redisPing`. (If a clarifying comment helps, add one, but assert in the PR that behavior is unchanged there.)

6. **Author `docs/runbooks/realtime-operations.md` (NEW).** Match `docs/runbooks/migrations.md`'s numbered-section style. Cover, at minimum:
   - **Single-task posture.** desired_count = 1 (pinned in WS-31's Terraform; documented here). Why: no cross-instance replay/lock machinery in the MVP.
   - **Process-local replay buffer.** `SessionBridge.replayBuffers` is in-memory, per-session, capped at `DEFAULT_MAX_REPLAY_BUFFER_SIZE` (200); lost on instance restart. A client reconnecting after a restart gets no replay.
   - **Process-bound session lock.** `SessionLock` (`packages/runtime/src/session-lock.ts`) is in-memory; it prevents concurrent runs on a session **within one process** only. Across instances (Phase 2) it does not hold.
   - **In-flight runs on deploy/restart.** Runs are process-bound and **abandoned on restart** (per the durable-execution Phase 2 boundary noted in `container.ts`). Graceful shutdown (WS-30/WS-31) drains sockets with code 1001 but does not resume runs.
   - **Reconnect-replay semantics.** Buffered events are replayed on reconnect **only while the run is active AND only on the same instance** (`replayEvents`). No cross-instance replay.
   - **Redis health.** `/health` reports `checks.redis: 'ok' | 'error' | 'disabled'` via a real `PING`; a 503 with `checks.redis: 'error'` means Redis is enabled but unreachable.
   - **Phase 2 cross-reference.** Horizontal multi-instance scaling (cross-instance A→B streaming, shared session lock, durable replay) is explicitly out of scope; link `docs/programs/realtime-cloud-delivery-program.md` (AD-02) and the manifest `outOfScope`.

7. **Re-export any new gateway symbols (`packages/gateway/src/index.ts`).** If step 2 introduced a `ChannelRegistry` or a `createRedisPing` helper that WS-30's plugin imports, export it from the barrel. Grep (`registerGatewayPlugin`, `GatewayComponents`, `redisPing`, `ChannelRegistry`) to confirm every reference — direct calls, type refs, re-exports, and tests — is updated (NO SEMANTIC SEARCH: check each category).

## Tests

> Fanout tests use fake `WebSocket`s (objects with `readyState === OPEN` and a spy `send`) plus an **in-memory Redis pub/sub double** implementing `RedisPubSubStub` (publish → synchronously invoke registered handlers), OR `ioredis-mock`, OR Testcontainers Redis (`@testcontainers/*`) for an integration-level proof. Prefer the in-memory double for the unit path and note that a Testcontainers Redis variant is acceptable for the integration path; a true cross-instance A→B test is Phase 2 and explicitly out of scope.

**`packages/gateway/src/__tests__/fanout.test.ts`:**

1. **Exactly-once local delivery (SC-06).** Two fake sockets `a`, `b` on session `S`. Drive one `ChatEvent` through `SessionBridge.handleSendMessage` (mock `runtime.start` yielding one event via `onEvent`). Assert each of `a.send` and `b.send` was called **exactly once** with the serialized event — proving local broadcast delivers once and the Redis subscription does not re-deliver on the originating instance (no double-send).

2. **No double-delivery through the Redis path (SC-06).** Wire the in-memory Redis double so `publish('session:S', ...)` invokes the session subscription's handler. Confirm that publishing the instance's own event does NOT cause a second `send` to `a`/`b` (the handler suppresses self-originated / single-instance re-delivery). Assert total `send` count per socket per event is 1.

3. **Ref-counted subscription — no missed delivery.** With `a` then `b` connecting to `S`, assert `redis.subscribe('session:S', ...)` is called **once** (not once per socket) and both sockets are served — proving the fix for the current "last-subscribe-wins" defect where only the last socket received Redis-forwarded messages.

4. **Unsubscribe on last disconnect only — no channel leak, no premature teardown (SC-06).** With `a` and `b` on `S`: closing `a` must **not** call `redis.unsubscribe('session:S')` (b still needs it); closing `b` (the last socket) **must** call `redis.unsubscribe('session:S')` exactly once. Assert the channel is fully released (no lingering handler entry) after the last close.

5. **Disconnect unsubscribes the correct channel (SC-06).** A socket on session `S1` closing releases `session:S1` and leaves a concurrent session `S2`'s subscription intact.

**`packages/gateway/src/__tests__/redis-ping.test.ts`:**

6. **`ping()` true on a healthy client.** A pub/sub built over a fake ioredis whose `ping()` resolves `'PONG'` → `RedisPubSubStub.ping()` resolves `true`.

7. **`ping()` false on a failing PING.** A fake ioredis whose `ping()` rejects (or resolves non-`'PONG'`) → `ping()` resolves `false` (caught, never throws). Include a timeout case: a `ping()` that never resolves is bounded by the ~1s race and resolves `false`.

**`apps/server/src/__tests__/health.test.ts` (MODIFY — extend the existing suite):**

8. **`checks.redis: 'ok'` + 200 when ping succeeds.** `registerHealthCheck` with `redisEnabled: true` and `redisPing: async () => true` → 200, `body.status === 'ok'`, `body.checks.redis === 'ok'`. (Complements the existing `'error'`/503 and `'disabled'` cases.)

9. **`checks.redis: 'error'` + 503 when ping resolves false.** `redisPing: async () => false` → 503, `checks.redis === 'error'` (distinct from the existing *throwing* ping case — proves the `!ok` branch, not only the `catch`).

10. **`checks.redis: 'disabled'` when Redis off, regardless of `redisPing`.** With `redisEnabled: false` and a `redisPing` supplied, the real ping is **never called** (spy asserts zero invocations) and `checks.redis === 'disabled'` with 200.

## Acceptance Criteria

1. On a single subscribing instance, a `ChatEvent` emitted by the runtime is delivered to every locally-connected socket for the session **exactly once** — no double-delivery caused by the instance forwarding its own Redis publish back to its own sockets, and no missed delivery (SC-06).
2. The `session:${sessionId}` subscription is **ref-counted per session per instance**: subscribed once on the first socket, unsubscribed once on the last socket's close; a mid-session disconnect never tears the channel down for still-connected siblings, and there is no channel/handler leak (SC-06).
3. The intended fanout semantics (local broadcast authoritative for local sockets; Redis path reserved for the Phase 2 cross-instance case; no self-re-delivery) are captured in a doc comment on the subscription handler (SC-06).
4. `RedisPubSubStub` exposes `ping(): Promise<boolean>` implemented as a real `PING` on an existing pub/sub connection (no third connection), returning `false` on error or timeout without throwing; the no-op returns `true` and is only ever consulted when Redis is disabled (SC-06).
5. `apps/server/src/main.ts` passes `redisPing` into `registerHealthCheck`, so `/health` reports `checks.redis: 'ok'` (200) when Redis is reachable, `'error'` (503) when enabled-but-unreachable, and `'disabled'` (200) when Redis is off — no longer assuming `'ok'` whenever a URL is set. `health.ts` logic is unchanged (SC-06).
6. `registerGatewayPlugin`'s signature and the `GatewayComponents` shape are unchanged; only the real behavior behind `GatewayComponents.redisPing` is implemented (SC-06, dependency WS-30).
7. `docs/runbooks/realtime-operations.md` documents the single-task posture (desired_count = 1), the process-local replay buffer, the process-bound `SessionLock`, in-flight-run abandonment on restart, and same-instance/active-run-only reconnect-replay semantics, cross-referencing the Phase 2 horizontal-scale boundary (SC-07).
8. `pnpm exec tsc --noEmit`, `pnpm exec eslint . --quiet`, and the new gateway fanout/ping unit tests plus the extended health tests pass; a true cross-instance A→B fanout test is documented as Phase 2 / out of scope, while the single-instance fanout path is proven (SC-12).
