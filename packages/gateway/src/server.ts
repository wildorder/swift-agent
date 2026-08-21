import Fastify, { type FastifyInstance } from 'fastify';
import type { ConnectionManager } from './connection-manager.js';
import type { SessionBridge } from './session-bridge.js';
import type { HeartbeatManager } from './heartbeat.js';
import { buildGatewayComponents, registerStreamRoute } from './plugin.js';
import type { GatewayConfig, RuntimeDelegate } from './types.js';
import { DEFAULT_GATEWAY_PORT } from './types.js';

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
  // Build the shared component graph + route deps. `GatewayConfig` is a
  // superset of `GatewayPluginConfig` (adds `port`/`logger`, which the helper
  // ignores — the standalone server owns those below).
  const { components, deps } = await buildGatewayComponents(config, runtime);
  const { connectionManager, sessionBridge, heartbeat } = components;

  // Create Fastify app (standalone owns its own server + logger)
  const app = Fastify({
    logger: config.logger ?? {
      transport: {
        target: 'pino-pretty',
      },
    },
  });

  // Health check endpoint (frozen by the existing integration suite)
  app.get('/health', async () => ({ status: 'ok' }));

  // WebSocket endpoint: /v1/stream — same handler the plugin form registers.
  await registerStreamRoute(app, deps);

  // Graceful shutdown — REGISTERED ONLY IN THE STANDALONE FORM. The plugin form
  // (registerGatewayPlugin) registers no signal handlers; the host process owns
  // shutdown there.
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
