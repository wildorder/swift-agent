import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { JWTVerifyGetKey } from 'jose';
import type {
  AgentRepo,
  ApiKeyRepo,
  SessionRepo,
  MessageRepo,
  RunRepo,
  ToolCallRepo,
  TraceRepo,
  UserRepo,
  UserWorkspaceRepo,
  WorkspaceRepo,
} from '@swiftagent/db';
import { registerRequestId } from './middleware/request-id.js';
import { registerAuth } from './middleware/auth.js';
import { managementPlugin } from './routes/management/index.js';
import { registerErrorHandler } from './middleware/error-handler.js';
import { createTokenService, type TokenService } from './services/token-service.js';
import { createAgentService, type AgentService } from './services/agent-service.js';
import { createSessionService, type SessionService } from './services/session-service.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerTraceRoutes } from './routes/traces.js';
import { registerMetricsRoutes } from './routes/metrics.js';
import type { RunExecutionService } from '@swiftagent/runtime';

/**
 * LOCAL-ONLY default for `publicWebsocketUrl`. This is the standalone-gateway
 * dev address — it is WRONG for any cloud environment (`ws:` scheme, `:3001`
 * port, no `/v1/stream` path). It exists only so local dev boots with zero
 * ceremony when `PUBLIC_WEBSOCKET_URL` is unset.
 *
 * It is UNREACHABLE in a cloud boot: `apps/server` runs its cloud startup guard
 * (`validatePublicWebsocketUrl`, WS-32) inside `loadServerConfig` BEFORE
 * `buildApp` is ever called, and that guard aborts boot when `DEPLOY_ENV` is a
 * cloud env and `PUBLIC_WEBSOCKET_URL` is missing / non-`wss:` / localhost. So
 * no cloud code path can reach this constant.
 *
 * Contract B (see WS-32): `BuildAppOptions.publicWebsocketUrl` stays optional
 * because making it required rippled into 6+ existing `buildApp` call sites;
 * the localhost default lives here in exactly one commented place instead of an
 * inline `??`.
 */
const LOCAL_ONLY_WEBSOCKET_URL = 'ws://localhost:3001';

export interface BuildAppOptions {
  /** Unified run execution service (WS-23) — shared with the gateway so REST
   *  and WebSocket runs contend on one session lock + active-run registry. */
  runExecutionService: RunExecutionService;
  repos: {
    apiKeyRepo: ApiKeyRepo;
    agentRepo: AgentRepo;
    sessionRepo: SessionRepo;
    messageRepo: MessageRepo;
    runRepo: RunRepo;
    toolCallRepo: ToolCallRepo;
    traceRepo: TraceRepo;
    userRepo: UserRepo;
    userWorkspaceRepo: UserWorkspaceRepo;
    workspaceRepo: WorkspaceRepo;
  };
  jwtSecret: string;
  publicWebsocketUrl?: string;
  cognitoIssuerUrl?: string;
  cognitoClientId?: string;
  /** Optional override for JWT key resolution — use `createLocalJWKSet` in tests. */
  cognitoGetKey?: JWTVerifyGetKey;
  logger?: boolean | object;
  /**
   * Whether to register the unprefixed root `/health` route. Default: true.
   *
   * The unified server (WS-30) mounts a richer *composed* health check at root
   * — one that also reports DB, Redis, and live gateway connection counts (see
   * `apps/server/src/health.ts`). Fastify rejects two routes on the same path
   * (`FST_ERR_DUPLICATED_ROUTE`), so the host opts out of this plain root
   * `/health` (`registerRootHealth: false`) and owns the composed one instead.
   * `/v1/health` is always registered regardless.
   */
  registerRootHealth?: boolean;
}

export interface AppContext {
  app: FastifyInstance;
  tokenService: TokenService;
  agentService: AgentService;
  sessionService: SessionService;
}

export async function buildApp(opts: BuildAppOptions): Promise<AppContext> {
  const app = Fastify({
    logger: opts.logger ?? {
      transport: {
        target: 'pino-pretty',
      },
      redact: ['req.headers.authorization'],
    },
    genReqId: () => '', // overridden by request-id middleware
  });

  // CORS
  await app.register(cors, { origin: true });

  // Error handler (must be registered before routes)
  registerErrorHandler(app);

  // Middleware
  registerRequestId(app);
  registerAuth(app, opts.repos.apiKeyRepo);

  // Services
  const tokenService = createTokenService({ secret: opts.jwtSecret });
  const agentService = createAgentService(opts.repos.agentRepo);
  const sessionService = createSessionService({
    sessionRepo: opts.repos.sessionRepo,
    messageRepo: opts.repos.messageRepo,
    runRepo: opts.repos.runRepo,
    toolCallRepo: opts.repos.toolCallRepo,
    agentService,
    runExecutionService: opts.runExecutionService,
  });

  // Root-level health check (unprefixed) for load balancers / probes. Auth is
  // skipped for `/health` via SKIP_AUTH_PATHS; `/v1/health` is also served below.
  // Opt-out for hosts that mount their own composed root `/health` (WS-30).
  if (opts.registerRootHealth ?? true) {
    registerHealthRoutes(app);
  }

  // Routes — prefix /v1
  await app.register(
    async (v1) => {
      registerHealthRoutes(v1);
      registerAgentRoutes(v1, agentService);
      registerSessionRoutes(v1, {
        sessionService,
        tokenService,
        publicWebsocketUrl: opts.publicWebsocketUrl ?? LOCAL_ONLY_WEBSOCKET_URL,
      });
      registerMessageRoutes(v1, sessionService);
      registerRunRoutes(v1, sessionService);
      registerTraceRoutes(v1, { traceRepo: opts.repos.traceRepo, sessionService });
      registerMetricsRoutes(v1, { traceRepo: opts.repos.traceRepo, sessionService });
    },
    { prefix: '/v1' },
  );

  // Management API — Cognito JWT auth (scoped to /v1/management)
  if (opts.cognitoIssuerUrl && opts.cognitoClientId) {
    await app.register(managementPlugin, {
      prefix: '/v1/management',
      issuerUrl: opts.cognitoIssuerUrl,
      audience: opts.cognitoClientId,
      getKey: opts.cognitoGetKey,
      userRepo: opts.repos.userRepo,
      userWorkspaceRepo: opts.repos.userWorkspaceRepo,
      workspaceRepo: opts.repos.workspaceRepo,
      apiKeyRepo: opts.repos.apiKeyRepo,
    });
  }

  return { app, tokenService, agentService, sessionService };
}

export async function startServer(port: number, opts: BuildAppOptions): Promise<AppContext> {
  const ctx = await buildApp(opts);
  await ctx.app.listen({ port, host: '0.0.0.0' });
  return ctx;
}
