import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { validateClientToken, AuthError } from './auth.js';
import { ConnectionManager } from './connection-manager.js';
import { SessionBridge, createNoopRedisPubSub, createRedisPubSub } from './session-bridge.js';
import type { RedisPubSubStub } from './session-bridge.js';
import { HeartbeatManager } from './heartbeat.js';
import { parseInboundMessage, toErrorEvent, ParseError } from './events.js';
import type { GatewayConfig, RuntimeDelegate } from './types.js';
import { DEFAULT_HEARTBEAT_TIMEOUT_MS, DEFAULT_GATEWAY_PORT } from './types.js';

// ── Gateway server context ─────────────────────────────────────────────

export interface GatewayContext {
  app: FastifyInstance;
  connectionManager: ConnectionManager;
  sessionBridge: SessionBridge;
  heartbeat: HeartbeatManager;
}

// ── Build the gateway ──────────────────────────────────────────────────

export async function createGatewayServer(
  config: GatewayConfig,
  runtime: RuntimeDelegate,
): Promise<GatewayContext> {
  const jwtSecret = new TextEncoder().encode(config.jwtSecret);
  const heartbeatTimeoutMs = config.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;

  // Create components
  const connectionManager = new ConnectionManager();
  const heartbeat = new HeartbeatManager(heartbeatTimeoutMs);

  // Redis pub/sub
  let redis: RedisPubSubStub;
  if (config.redisEnabled && config.redisUrl) {
    redis = await createRedisPubSub(config.redisUrl);
  } else {
    redis = createNoopRedisPubSub();
  }

  const sessionBridge = new SessionBridge({
    connectionManager,
    runtime,
    redis,
    maxReplayBufferSize: config.maxReplayBufferSize,
  });

  // Create Fastify app
  const app = Fastify({
    logger: config.logger ?? {
      transport: {
        target: 'pino-pretty',
      },
    },
  });

  // Register WebSocket plugin
  await app.register(websocket);

  // Health check endpoint
  app.get('/health', async () => ({ status: 'ok' }));

  // WebSocket endpoint: /v1/stream
  app.register(async (instance) => {
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

          // Subscribe to Redis channel for horizontal scaling
          if (config.redisEnabled && config.redisUrl) {
            await redis.subscribe(`session:${sessionId}`, (_channel, message) => {
              connectionManager.sendTo(sessionId, socket, message);
            });
          }

          // Handle inbound messages
          socket.on('message', (raw: Buffer | string) => {
            const data = typeof raw === 'string' ? raw : raw.toString('utf-8');

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
          });

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
            if (config.redisEnabled) {
              void redis.unsubscribe(`session:${sessionId}`);
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
  }, { prefix: '/v1' });

  // Graceful shutdown
  const shutdown = async () => {
    app.log.info('Graceful shutdown initiated');

    // Stop accepting new connections
    await app.close();

    // Close all WebSocket connections
    connectionManager.closeAll(1001, 'Server shutting down');

    // Clear heartbeat timers
    heartbeat.clear();

    // Shutdown session bridge (Redis cleanup)
    await sessionBridge.shutdown();
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  return { app, connectionManager, sessionBridge, heartbeat };
}

// ── Start server ───────────────────────────────────────────────────────

export async function startGateway(
  config: GatewayConfig,
  runtime: RuntimeDelegate,
): Promise<GatewayContext> {
  const ctx = await createGatewayServer(config, runtime);
  const port = config.port ?? DEFAULT_GATEWAY_PORT;
  await ctx.app.listen({ port, host: '0.0.0.0' });
  return ctx;
}
