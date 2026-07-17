import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ENV_KEYS } from '@swiftagent/shared';
import { buildApp, type AppContext } from '@swiftagent/api';
import { registerGatewayPlugin, type GatewayComponents } from '@swiftagent/gateway';
import { loadServerConfig, redactConfig, type ServerConfig } from './config.js';
import { buildContainer, type Container } from './container.js';
import { registerHealthCheck } from './health.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Server context ────────────────────────────────────────────────────

export interface ServerContext {
  config: ServerConfig;
  container: Container;
  api: AppContext;
  gateway: GatewayComponents;
}

// ── Start server ──────────────────────────────────────────────────────

export async function startServer(): Promise<ServerContext> {
  // 1. Load config — fail fast on invalid config
  const config = loadServerConfig();

  // 2. Build dependency container
  const container = buildContainer(config);

  // 3. Run database migrations if AUTO_MIGRATE=true
  if (config.AUTO_MIGRATE) {
    const { drizzle } = await import('drizzle-orm/postgres-js');
    const { migrate } = await import('drizzle-orm/postgres-js/migrator');
    const postgres = (await import('postgres')).default;

    const migrationPool = postgres(config[ENV_KEYS.DATABASE_URL], { max: 1 });
    const migrationDb = drizzle(migrationPool);
    console.log('Running database migrations...');
    const migrationsFolder = resolve(__dirname, '../../../packages/db/drizzle');
    await migrate(migrationDb, { migrationsFolder });
    console.log('Migrations complete.');
    await migrationPool.end();
  }

  // 4. Build API server (control plane routes)
  const apiPort = config[ENV_KEYS.API_PORT];
  const api = await buildApp({
    runExecutionService: container.runExecutionService,
    repos: {
      apiKeyRepo: container.repos.apiKeyRepo,
      agentRepo: container.repos.agentRepo,
      sessionRepo: container.repos.sessionRepo,
      messageRepo: container.repos.messageRepo,
      runRepo: container.repos.runRepo,
      toolCallRepo: container.repos.toolCallRepo,
      traceRepo: container.repos.traceRepo,
      userRepo: container.repos.userRepo,
      userWorkspaceRepo: container.repos.userWorkspaceRepo,
      workspaceRepo: container.repos.workspaceRepo,
    },
    jwtSecret: config[ENV_KEYS.CLIENT_JWT_SECRET],
    publicWebsocketUrl: config[ENV_KEYS.PUBLIC_WEBSOCKET_URL],
    cognitoIssuerUrl: config[ENV_KEYS.COGNITO_ISSUER_URL],
    cognitoClientId: config[ENV_KEYS.COGNITO_CLIENT_ID],
    logger: { level: 'info' },
    // The server owns the root `/health` via the composed health check below
    // (reports DB + Redis + live gateway connections). Opt out of buildApp's
    // plain root `/health` so the two don't collide (FST_ERR_DUPLICATED_ROUTE).
    registerRootHealth: false,
  });

  // 5. Mount the WebSocket gateway ONTO the API app (unified realtime server,
  // WS-30 / AD-01). REST and WS are served from one Fastify instance on one
  // public port, so `/v1/stream` is reachable through the same ALB target as
  // REST. The gateway is wired to the SAME run execution service as the REST
  // API, so both entry points share one session lock + active-run registry.
  const redisUrl = config[ENV_KEYS.REDIS_URL];
  const redisEnabled = !!redisUrl;
  const gateway = await registerGatewayPlugin(
    api.app,
    {
      jwtSecret: config[ENV_KEYS.CLIENT_JWT_SECRET],
      redisUrl: redisEnabled ? redisUrl : undefined,
      redisEnabled,
      // no port / no logger — the API app owns both
    },
    container.runExecutionService, // RunExecutionService satisfies RuntimeDelegate
  );

  // 6. Register combined health check on the API server
  registerHealthCheck(api.app, {
    dbClient: container.dbClient,
    connectionManager: gateway.connectionManager,
    redisEnabled,
    redisPing: gateway.redisPing,
  });

  // 7. Start listening — a SINGLE public listener serving REST + WS (SC-01).
  await api.app.listen({ port: apiPort, host: '0.0.0.0' });

  // 8. Startup banner. GATEWAY_PORT is intentionally not shown as a listening
  // port — the unified server binds only API_PORT. GATEWAY_PORT remains valid
  // for the standalone gateway (local dev / tests) but is inert here.
  const summary = redactConfig(config);
  console.log('\n──────────────────────────────────────');
  console.log('  Swift Agent Server');
  console.log('──────────────────────────────────────');
  console.log(`  Port:           ${apiPort} (REST + WebSocket)`);
  console.log(`  Providers:      ${container.registeredProviders.join(', ') || '(none)'}`);
  console.log(`  Redis:          ${redisEnabled ? 'enabled' : 'disabled'}`);
  console.log(`  Auto Migrate:   ${config.AUTO_MIGRATE}`);
  console.log(`  Config:         ${JSON.stringify(summary)}`);
  console.log('──────────────────────────────────────\n');

  // 9. Graceful shutdown — a SINGLE consolidated path (SC-05). The gateway
  // plugin registers no signal handlers, so there is no duplicate handler set.
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}. Shutting down gracefully...`);

    // a. Drain active WebSocket connections with a graceful 1001 FIRST. This
    // must precede `api.app.close()`: closing the HTTP server tears sockets down
    // at the transport level, so clients would otherwise observe a codeless 1005
    // instead of the intended 1001 "going away".
    gateway.connectionManager.closeAll(1001, 'Server shutting down');

    // b. Clear heartbeat timers
    gateway.heartbeat.clear();

    // c. Stop accepting new connections
    await api.app.close();

    // d. Shutdown session bridge (Redis cleanup)
    await gateway.sessionBridge.shutdown();

    // e. Close database pool
    await container.dbClient.close();

    console.log('Shutdown complete.');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  return { config, container, api, gateway };
}

// ── Entry point ──
// Only bootstrap when this module is the process entry (`node dist/main.js`).
// Guarding this prevents a plain `import` (e.g. `index.ts` re-exporting
// `startServer` for programmatic use, or tests) from booting the whole server
// and attempting real DB/Redis connections.
const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  startServer().catch((err) => {
    console.error('Fatal: failed to start server', err);
    process.exit(1);
  });
}
