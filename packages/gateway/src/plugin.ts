import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { validateClientToken, AuthError } from './auth.js';
import { ConnectionManager } from './connection-manager.js';
import { SessionBridge, createNoopRedisPubSub, createRedisPubSub } from './session-bridge.js';
import type { RedisPubSubStub } from './session-bridge.js';
import { ChannelRegistry } from './channel-registry.js';
import { HeartbeatManager } from './heartbeat.js';
import { parseInboundMessage, toErrorEvent, ParseError } from './events.js';
import type { GatewayPluginConfig, GatewayComponents, RuntimeDelegate } from './types.js';
import { DEFAULT_HEARTBEAT_TIMEOUT_MS } from './types.js';

// ── Shared component graph ─────────────────────────────────────────────

/**
 * Everything the `/v1/stream` route handler closes over. Built once by
 * `buildGatewayComponents` and shared by both the standalone gateway server
 * (`createGatewayServer`) and the plugin form (`registerGatewayPlugin`) so the
 * handler has a single implementation.
 */
export interface StreamRouteDeps {
  jwtSecret: Uint8Array;
  connectionManager: ConnectionManager;
  heartbeat: HeartbeatManager;
  sessionBridge: SessionBridge;
  /** Ref-counted per-session subscription manager (acquire on connect / release on close). */
  channels: ChannelRegistry;
  /** Whether Redis pub/sub is live (enabled AND a URL was supplied). */
  redisActive: boolean;
}

/**
 * Result of `buildGatewayComponents`: the host-facing `components` (returned by
 * `registerGatewayPlugin`) plus the internals `registerStreamRoute` needs.
 */
export interface BuiltGateway {
  components: GatewayComponents;
  deps: StreamRouteDeps;
}

/**
 * Construct the gateway component graph — `ConnectionManager`, `HeartbeatManager`,
 * the Redis pub/sub (real when `redisEnabled && redisUrl`, else a no-op),
 * `SessionBridge`, the encoded JWT secret, and the `redisPing` liveness closure.
 * Shared by the standalone server and the plugin so both wire identical components.
 */
export async function buildGatewayComponents(
  config: GatewayPluginConfig,
  runtime: RuntimeDelegate,
): Promise<BuiltGateway> {
  const jwtSecret = new TextEncoder().encode(config.jwtSecret);
  const heartbeatTimeoutMs = config.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;

  const connectionManager = new ConnectionManager();
  const heartbeat = new HeartbeatManager(heartbeatTimeoutMs);

  const redisActive = !!(config.redisEnabled && config.redisUrl);

  let redis: RedisPubSubStub;
  if (config.redisEnabled && config.redisUrl) {
    redis = await createRedisPubSub(config.redisUrl);
  } else {
    redis = createNoopRedisPubSub();
  }

  // Single fanout point + ref-counted per-session subscription registry, shared
  // by the SessionBridge (publish) and the stream route (acquire/release).
  const channels = new ChannelRegistry({ redis, connectionManager });

  const sessionBridge = new SessionBridge({
    connectionManager,
    runtime,
    redis,
    channels,
    maxReplayBufferSize: config.maxReplayBufferSize,
  });

  // Real Redis liveness for the health check: delegates to the pub/sub `ping`
  // (a PING on the existing `pub` connection, `false` on error/timeout). The
  // no-op returns `true` when Redis is disabled — but `/health` only consults
  // this when `redisEnabled`, so the no-op is never a misleading "ok". The
  // `GatewayComponents.redisPing` field shape (WS-30) is unchanged.
  const redisPing = (): Promise<boolean> => redis.ping();

  return {
    components: { connectionManager, sessionBridge, heartbeat, redisPing },
    deps: { jwtSecret, connectionManager, heartbeat, sessionBridge, channels, redisActive },
  };
}

// ── Shared route registration ──────────────────────────────────────────

/**
 * Register `@fastify/websocket` and the `/v1/stream` route onto `app`. The
 * single implementation of the stream handler — both `createGatewayServer` and
 * `registerGatewayPlugin` call this. Registers under the `/v1` prefix; the host
 * app may already own other `/v1` routes (they compose, since paths differ).
 */
export async function registerStreamRoute(
  app: FastifyInstance,
  deps: StreamRouteDeps,
): Promise<void> {
  const { jwtSecret, connectionManager, heartbeat, sessionBridge, channels, redisActive } = deps;

  await app.register(websocket);

  // WebSocket endpoint: /v1/stream
  app.register(
    async (instance) => {
      instance.get('/stream', { websocket: true }, (socket: WebSocket, req) => {
        // Extract token from query string
        const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
        const token = url.searchParams.get('token');

        if (!token) {
          const error = toErrorEvent('AUTH_REQUIRED', 'Missing token query parameter');
          socket.send(JSON.stringify(error));
          socket.close(4001, 'Missing token');
          return;
        }

        // Attach the message listener SYNCHRONOUSLY, before the async auth
        // below yields. A client that sends immediately after `open` (fast
        // localhost links: tests, CI, local dev) would otherwise race the
        // await-points in the auth block and have its first frames silently
        // dropped — the handler used to be installed only after token
        // validation and the Redis subscribe completed. Frames arriving in
        // that window are buffered and flushed once auth succeeds; on auth
        // failure the socket closes and the buffer is discarded unread.
        const preAuthBuffer: string[] = [];
        let inboundHandler: ((data: string) => void) | null = null;
        socket.on('message', (raw: Buffer | string) => {
          const data = typeof raw === 'string' ? raw : raw.toString('utf-8');
          if (inboundHandler) {
            inboundHandler(data);
          } else {
            preAuthBuffer.push(data);
          }
        });

        // Authenticate asynchronously
        void (async () => {
          try {
            const claims = await validateClientToken(token, jwtSecret);
            const { sessionId } = claims;

            // Register connection
            connectionManager.add(sessionId, socket);
            heartbeat.attach(socket);

            // Replay buffered events from active run (reconnection support)
            sessionBridge.replayEvents(sessionId, socket);

            // Acquire the session's Redis subscription for horizontal scaling.
            // Ref-counted per session: the FIRST socket for the session
            // subscribes once; later sockets only bump the refcount. The
            // subscription forwards only PEER-instance events to local sockets
            // (Phase 2) — this instance's own publishes are already delivered by
            // the authoritative local broadcast, so they are never re-delivered
            // here (no double-delivery). See ChannelRegistry.
            if (redisActive) {
              await channels.acquire(sessionId);
            }

            // Handle inbound messages (installed into the synchronous
            // listener above; buffered pre-auth frames are flushed below).
            const handleInbound = (data: string): void => {
              try {
                const msg = parseInboundMessage(data);

                if (msg.type === 'ping') {
                  socket.send(JSON.stringify({ type: 'pong' }));
                  return;
                }

                if (msg.type === 'send_message') {
                  // Fire-and-forget — errors are broadcast as events
                  void sessionBridge.handleSendMessage(sessionId, msg.content, socket);
                  return;
                }

                if (msg.type === 'cancel') {
                  // Explicit cancellation of the session's active run (WS-24).
                  // Fire-and-forget: the terminal event is streamed through the
                  // active run, not returned here. Idempotent + safe when idle.
                  void sessionBridge.handleCancel(sessionId);
                  return;
                }
              } catch (err) {
                if (err instanceof ParseError) {
                  const errorEvent = toErrorEvent(err.code, err.message);
                  connectionManager.sendError(sessionId, socket, errorEvent);
                } else {
                  const errorEvent = toErrorEvent('INTERNAL_ERROR', 'Unexpected error processing message');
                  connectionManager.sendError(sessionId, socket, errorEvent);
                }
              }
            };
            inboundHandler = handleInbound;
            for (const data of preAuthBuffer.splice(0)) {
              handleInbound(data);
            }

            // Handle close.
            //
            // DISCONNECT POLICY (WS-24): a socket close removes the connection but
            // MUST NOT cancel the run. Runs are server-owned and process-bound;
            // they survive client disconnects, and a reconnecting client replays
            // buffered events (see `replayEvents`). Only an explicit `cancel`
            // message (or the REST cancel endpoint) cancels a run.
            socket.on('close', () => {
              connectionManager.remove(sessionId, socket);
              heartbeat.detach(socket);
              // Release this socket's hold on the session subscription. The
              // channel is unsubscribed only when the LAST socket for the
              // session closes (ref-counted) — a mid-session disconnect never
              // tears the channel down for still-connected siblings.
              if (redisActive) {
                void channels.release(sessionId);
              }
            });

            // Handle errors
            socket.on('error', () => {
              connectionManager.remove(sessionId, socket);
              heartbeat.detach(socket);
            });
          } catch (err) {
            // Auth failed
            let code = 'AUTH_FAILED';
            let message = 'Authentication failed';
            let closeCode = 4003;

            if (err instanceof AuthError) {
              code = err.code;
              message = err.message;
              if (err.code === 'TOKEN_EXPIRED') closeCode = 4001;
              if (err.code === 'TOKEN_MALFORMED') closeCode = 4002;
            }

            const error = toErrorEvent(code, message);
            socket.send(JSON.stringify(error));
            socket.close(closeCode, message);
          }
        })();
      });
    },
    { prefix: '/v1' },
  );
}

// ── Plugin form ────────────────────────────────────────────────────────

/**
 * Register the gateway onto an existing (host) Fastify app. Mounts
 * `@fastify/websocket` and the `/v1/stream` route onto `app` and returns the
 * component graph for the host to drive shutdown + health.
 *
 * Unlike `createGatewayServer`, this does NOT: create a Fastify app, call
 * `listen`, register `/health`, or register any `SIGTERM`/`SIGINT` handler —
 * the host owns the server lifecycle and process signals.
 */
export async function registerGatewayPlugin(
  app: FastifyInstance,
  config: GatewayPluginConfig,
  runtime: RuntimeDelegate,
): Promise<GatewayComponents> {
  const { components, deps } = await buildGatewayComponents(config, runtime);
  await registerStreamRoute(app, deps);
  return components;
}
