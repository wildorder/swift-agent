import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type {
  AgentRepo,
  ApiKeyRepo,
  SessionRepo,
  MessageRepo,
  RunRepo,
  ToolCallRepo,
  TraceRepo,
} from '@swiftagent/db';
import { registerRequestId } from './middleware/request-id.js';
import { registerAuth } from './middleware/auth.js';
import { registerCognitoAuth } from './middleware/cognito-auth.js';
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

export interface BuildAppOptions {
  repos: {
    apiKeyRepo: ApiKeyRepo;
    agentRepo: AgentRepo;
    sessionRepo: SessionRepo;
    messageRepo: MessageRepo;
    runRepo: RunRepo;
    toolCallRepo: ToolCallRepo;
    traceRepo: TraceRepo;
  };
  jwtSecret: string;
  publicWebsocketUrl?: string;
  cognitoIssuerUrl?: string;
  cognitoClientId?: string;
  logger?: boolean | object;
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
  });

  // Routes — prefix /v1
  await app.register(
    async (v1) => {
      registerHealthRoutes(v1);
      registerAgentRoutes(v1, agentService);
      registerSessionRoutes(v1, {
        sessionService,
        tokenService,
        publicWebsocketUrl: opts.publicWebsocketUrl ?? 'ws://localhost:3001',
      });
      registerMessageRoutes(v1, sessionService);
      registerRunRoutes(v1, sessionService);
      registerTraceRoutes(v1, { traceRepo: opts.repos.traceRepo, sessionService });
    },
    { prefix: '/v1' },
  );

  // Management API — Cognito JWT auth (scoped to /v1/management)
  if (opts.cognitoIssuerUrl && opts.cognitoClientId) {
    await app.register(
      async (management) => {
        registerCognitoAuth(management, {
          issuerUrl: opts.cognitoIssuerUrl!,
          audience: opts.cognitoClientId!,
        });
        // Management routes will be registered here in WS-17
      },
      { prefix: '/v1/management' },
    );
  }

  // Also register health at root for load balancers
  registerHealthRoutes(app);

  return { app, tokenService, agentService, sessionService };
}

export async function startServer(port: number, opts: BuildAppOptions): Promise<AppContext> {
  const ctx = await buildApp(opts);
  await ctx.app.listen({ port, host: '0.0.0.0' });
  return ctx;
}
