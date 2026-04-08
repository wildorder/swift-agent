import { ENV_KEYS } from '@swiftagent/shared';
import { buildApp, type AppContext } from '@swiftagent/api';
import { createGatewayServer, type GatewayContext } from '@swiftagent/gateway';
import { loadServerConfig, redactConfig, type ServerConfig } from './config.js';
import { buildContainer, type Container } from './container.js';
import { registerHealthCheck } from './health.js';

// ── Server context ────────────────────────────────────────────────────

export interface ServerContext {
  config: ServerConfig;
  container: Container;
  api: AppContext;
  gateway: GatewayContext;
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
    await migrate(migrationDb, { migrationsFolder: './drizzle' });
    console.log('Migrations complete.');
    await migrationPool.end();
  }

  // 4. Build API server (control plane routes)
  const apiPort = config[ENV_KEYS.API_PORT];
  const api = await buildApp({
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
  });

  // 5. Build WebSocket gateway — wired to container.engine as RuntimeDelegate
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
    container.engine, // AgentEngine satisfies RuntimeDelegate
  );

  // 6. Register combined health check on the API server
  registerHealthCheck(api.app, {
    dbClient: container.dbClient,
    connectionManager: gateway.connectionManager,
    redisEnabled,
  });

  // 7. Start listening
  await api.app.listen({ port: apiPort, host: '0.0.0.0' });
  const gatewayPort = config[ENV_KEYS.GATEWAY_PORT];
  await gateway.app.listen({ port: gatewayPort, host: '0.0.0.0' });

  // 8. Startup banner
  const summary = redactConfig(config);
  console.log('\n──────────────────────────────────────');
  console.log('  Swift Agent Server');
  console.log('──────────────────────────────────────');
  console.log(`  API Port:       ${apiPort}`);
  console.log(`  Gateway Port:   ${gatewayPort}`);
  console.log(`  Providers:      ${container.registeredProviders.join(', ') || '(none)'}`);
  console.log(`  Redis:          ${redisEnabled ? 'enabled' : 'disabled'}`);
  console.log(`  Auto Migrate:   ${config.AUTO_MIGRATE}`);
  console.log(`  Config:         ${JSON.stringify(summary)}`);
  console.log('──────────────────────────────────────\n');

  // 9. Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}. Shutting down gracefully...`);

    // a. Stop accepting new connections
    await gateway.app.close();
    await api.app.close();

    // b. Drain active WebSocket connections
    gateway.connectionManager.closeAll(1001, 'Server shutting down');

    // c. Clear heartbeat timers
    gateway.heartbeat.clear();

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

// ── Entry point (invoked when run directly via `node dist/main.js`) ──

startServer().catch((err) => {
  console.error('Fatal: failed to start server', err);
  process.exit(1);
});
