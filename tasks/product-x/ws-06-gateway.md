# WS-06: Realtime WebSocket Gateway

## Goal

Implement the WebSocket server that handles client connections, authentication via short-lived tokens, session multiplexing, reconnection handling, and structured event streaming. The gateway binds each connection to a session after validating a JWT using `ClientTokenClaims` from `@swiftagent/shared` (WS-02), fans out `ChatEvent` streams to all tabs connected to that session, bridges inbound user messages to the agent runtime (this dependency on WS-05b is specifically for the `AgentEngine` class that the gateway uses to delegate message processing), and provides heartbeat cleanup plus a Redis pub-sub stub for future horizontal scaling.

## Dependencies

- WS-02
- WS-03
- WS-05b

## Package

`packages/gateway`

## Files Touched

- `packages/gateway/src/server.ts`
- `packages/gateway/src/connection-manager.ts`
- `packages/gateway/src/auth.ts`
- `packages/gateway/src/session-bridge.ts`
- `packages/gateway/src/events.ts`
- `packages/gateway/src/heartbeat.ts`
- `packages/gateway/src/types.ts`
- `packages/gateway/src/index.ts`

## Implementation Steps

1. **Types (`types.ts`)**: Define gateway-local types: inbound client message union `{ type: "send_message"; content: string } | { type: "ping" }`, structured error payload for outbound frames, `GatewayConfig` (heartbeat timeout default `30000` ms, Redis URL optional, runtime delegate hooks). Re-export or import `ChatEvent` from `@swiftagent/shared` (discriminated union: `message_started`, `token`, `tool_call_started`, `tool_call_completed`, `message_completed`, `run_failed`).

2. **Auth (`auth.ts`)**: Implement `validateClientToken(token: string, jwtSecret: Uint8Array | CryptoKey): Promise<ClientTokenClaims>` using `jose` (`jwtVerify`), matching issuer/audience with control plane. Import `ClientTokenClaims` and `ClientTokenClaimsSchema` from `@swiftagent/shared` (WS-02) — validate decoded payload against the Zod schema to ensure claim shape matches the contract shared with `TokenService` (WS-07). Return validated `ClientTokenClaims`. Export `AuthError` with codes: `TOKEN_EXPIRED`, `TOKEN_MALFORMED`, `TOKEN_INVALID`, `INSUFFICIENT_PERMISSIONS`.

3. **ConnectionManager (`connection-manager.ts`)**: Class `ConnectionManager` with internal `Map<sessionId, Set<WebSocket>>` (or weak refs as appropriate). Methods: `add(sessionId: string, ws: WebSocket): void`, `remove(sessionId: string, ws: WebSocket): void`, `broadcast(sessionId: string, event: ChatEvent): void` (serialize JSON per connection, swallow send errors and remove dead sockets), `getConnections(sessionId: string): ReadonlySet<WebSocket>`, `isConnected(sessionId: string): boolean`, `connectionCount(): number` for metrics. Ensure thread-safe patterns for Node single-thread; document that multiple connections per session are first-class.

4. **Events (`events.ts`)**: Helpers `serializeChatEvent(event: ChatEvent): string`, `parseInboundMessage(raw: string): InboundMessage` (Zod parse; on failure throw typed parse error). `toErrorEvent(code: string, message: string): { type: "error"; code: string; message: string }` aligned with shared protocol if defined.

5. **Session bridge (`session-bridge.ts`)**: Import `AgentEngine` from `@swiftagent/runtime` (WS-05b) and adapt it as the `RuntimeDelegate`. The bridge calls `engine.run(sessionId, userMessage)` which returns `AsyncGenerator<ChatEvent>`. The bridge consumes this generator and broadcasts events to connected clients. Implement `SessionBridge` that: (a) accepts validated inbound `send_message`, validates non-empty `content`, calls runtime delegate — if `engine.run()` throws `RUN_IN_PROGRESS` (from `SessionLock` in WS-05b), catch and broadcast a structured error event `{ type: "error", code: "RUN_IN_PROGRESS", message }` to the sending socket only (not all session connections); (b) subscribes to emitted `ChatEvent`s and calls `connectionManager.broadcast(sessionId, event)`; (c) maintains optional `lastEventsBuffer` per active `runId` for replay (ring buffer or capped array) for reconnection MVP. Export `createSessionBridge(deps: { connectionManager; runtime; redis?: RedisPubSubStub })`.

6. **Redis stub (`session-bridge.ts` or `redis-bridge.ts` if split)**: For MVP, implement `RedisPubSubStub` with same interface as real ioredis pub-sub: `publish(sessionChannel: string, payload: string): Promise<void>`, `subscribe(pattern, handler)`. Real `ioredis` client behind env flag `GATEWAY_REDIS_ENABLED`; when disabled, no-op publish/subscribe but keep call sites so horizontal scaling is a config flip.

7. **Heartbeat (`heartbeat.ts`)**: Per-socket timers: on `pong` reset deadline; if no `pong` within interval (half of heartbeat timeout) send `ping`; if still stale after full timeout, `ws.terminate()`. Configurable `heartbeatIntervalMs` and `heartbeatTimeoutMs` (default total 30s idle → disconnect). Integrate with ws `ping`/`pong` frames.

8. **Server (`server.ts`)**: Fastify app with `@fastify/websocket` registering route `GET /ws` (or `/v1/stream`). On connection: read token from query `?token=` or `Sec-WebSocket-Protocol` (document chosen approach); run `validateClientToken`; on failure send close code + optional JSON error frame before close. On success: `connectionManager.add(sessionId, socket)`, attach heartbeat, wire `message` handler to `parseInboundMessage` → `sessionBridge.handleInbound`. On `ping` inbound message type, respond with `pong` JSON. Subscribe to Redis channel `session:{sessionId}` when horizontal scaling enabled and forward to `broadcast`. Register `onClose` / `onError` to `remove` and clear timers.

9. **Reconnection replay**: When client connects, if `SessionBridge` has buffered events for current `runId` for that `sessionId`, send them in order before live stream (document ordering guarantees). If no active run, skip replay.

10. **Graceful shutdown**: Listen `SIGTERM`/`SIGINT`; call `fastify.close()`, iterate `ConnectionManager` to close all sockets with code 1001, await Redis unsubscribe, drain with timeout.

11. **Public API (`index.ts`)**: Export `createGatewayServer(config)`, types, and factories for testing.

## Tests

1. **ConnectionManager**: `add`/`remove` maintains correct sets; `broadcast` delivers to all sockets in session; removing one socket leaves others; `isConnected` false when empty.
2. **Auth**: Valid token verifies and returns claims; expired token fails with `TOKEN_EXPIRED`; malformed JWT fails with `TOKEN_MALFORMED`; wrong signature fails with `TOKEN_INVALID`.
3. **Inbound parsing**: Valid JSON accepted; invalid shape rejected; Zod error mapped to structured error.
4. **Broadcasting**: Multiple mocked WebSockets on same session all receive identical serialized `ChatEvent` frames.
5. **Heartbeat**: Mock timers or short timeouts; socket terminated when no pong within limit; healthy socket stays open.
6. **Graceful shutdown**: After `close()`, no new connections accepted; existing sockets closed.
7. **Integration** (Vitest + undici/ws test client): Connect with valid token → send `{ type: "send_message", content: "hi" }` → mock runtime yields token events → client receives JSON `ChatEvent` sequence.

## Acceptance Criteria

1. Clients can connect via WebSocket with a valid short-lived JWT; connection is rejected with clear errors for invalid or expired tokens.
2. Authenticated connections are bound to exactly one `sessionId` derived from the token; multiple connections per `sessionId` are supported.
3. Inbound `send_message` and `ping` are parsed and handled; malformed payloads yield structured error events without crashing the server.
4. Outbound frames are JSON-encoded `ChatEvent` objects matching the shared discriminated union.
5. Stale connections are detected via heartbeat and disconnected within the configured timeout (default 30s).
6. All active connections for a session receive the same broadcast events in order for that session.
7. SIGTERM triggers graceful drain: connections closed, server stops accepting new ones.
8. Redis integration exists as a stub or feature-flagged implementation so multiple gateway instances can share session channels when enabled.
