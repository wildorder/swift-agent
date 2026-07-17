import { ENV_KEYS } from '@swiftagent/shared';
import {
  createDbClient,
  type DbClient,
  createWorkspaceRepo,
  type WorkspaceRepo,
  createApiKeyRepo,
  type ApiKeyRepo,
  createAgentRepo,
  type AgentRepo,
  createSessionRepo,
  type SessionRepo,
  createMessageRepo,
  type MessageRepo,
  createRunRepo,
  type RunRepo,
  createToolCallRepo,
  type ToolCallRepo,
  createTraceRepo,
  type TraceRepo,
  createUserRepo,
  type UserRepo,
  createUserWorkspaceRepo,
  type UserWorkspaceRepo,
} from '@swiftagent/db';
import {
  ProviderRegistry,
  createOpenAIProvider,
  createAnthropicProvider,
  createGoogleProvider,
} from '@swiftagent/models';
import { Tracer, type TraceSink } from '@swiftagent/observability';
import {
  AgentEngine,
  createRunExecutionService,
  createToolExecutorResolver,
  mintRunnerToken,
  importRunnerPrivateKey,
  type AgentEngineDeps,
  type RunExecutionService,
  type RunnerSigningKey,
  type OutboundUrlPolicy,
  type Logger,
} from '@swiftagent/runtime';
import {
  createTokenService,
  type TokenService,
  createAgentService,
  type AgentService,
  createSessionService,
  type SessionService,
} from '@swiftagent/api';
import type { ServerConfig } from './config.js';

// ── Container type ────────────────────────────────────────────────────

export interface Container {
  /** Database client (pool + drizzle instance) */
  dbClient: DbClient;

  /** All repository instances */
  repos: {
    workspaceRepo: WorkspaceRepo;
    apiKeyRepo: ApiKeyRepo;
    agentRepo: AgentRepo;
    sessionRepo: SessionRepo;
    messageRepo: MessageRepo;
    runRepo: RunRepo;
    toolCallRepo: ToolCallRepo;
    traceRepo: TraceRepo;
    userRepo: UserRepo;
    userWorkspaceRepo: UserWorkspaceRepo;
  };

  /** Model provider registry with registered providers */
  modelRegistry: ProviderRegistry;

  /** Observability tracer */
  tracer: Tracer;

  /** Agent runtime engine — legacy lock-owning entry point. */
  engine: AgentEngine;

  /** Unified run execution service (WS-23) — the single run-id + session-lock
   *  owner shared by the REST API and the WebSocket gateway. */
  runExecutionService: RunExecutionService;

  /** API services */
  tokenService: TokenService;
  agentService: AgentService;
  sessionService: SessionService;

  /** Track which model providers were registered */
  registeredProviders: string[];
}

// ── Build container ───────────────────────────────────────────────────

/**
 * Wire all package dependencies in order:
 *
 * 1. Database client (everything depends on this)
 * 2. Repositories (depend on DB)
 * 3. Model provider registry (depends on config — only register providers with keys)
 * 4. Tracer + TraceSink (depends on TraceRepo)
 * 5. AgentEngine (depends on repos, model registry, tracer)
 * 6. API services: TokenService, AgentService, SessionService (depend on repos)
 */
export function buildContainer(config: ServerConfig): Container {
  // 1. Database client
  const dbClient = createDbClient(config[ENV_KEYS.DATABASE_URL]);
  const { db } = dbClient;

  // 2. Repositories
  const repos = {
    workspaceRepo: createWorkspaceRepo(db),
    apiKeyRepo: createApiKeyRepo(db),
    agentRepo: createAgentRepo(db),
    sessionRepo: createSessionRepo(db),
    messageRepo: createMessageRepo(db),
    runRepo: createRunRepo(db),
    toolCallRepo: createToolCallRepo(db),
    traceRepo: createTraceRepo(db),
    userRepo: createUserRepo(db),
    userWorkspaceRepo: createUserWorkspaceRepo(db),
  };

  // 3. Model provider registry — only register providers whose API keys are present
  const modelRegistry = new ProviderRegistry();
  const registeredProviders: string[] = [];

  if (config[ENV_KEYS.OPENAI_API_KEY]) {
    modelRegistry.register('openai', createOpenAIProvider, {
      apiKey: config[ENV_KEYS.OPENAI_API_KEY] as string,
    });
    registeredProviders.push('openai');
  }

  if (config[ENV_KEYS.ANTHROPIC_API_KEY]) {
    modelRegistry.register('anthropic', createAnthropicProvider, {
      apiKey: config[ENV_KEYS.ANTHROPIC_API_KEY] as string,
    });
    registeredProviders.push('anthropic');
  }

  if (config[ENV_KEYS.GOOGLE_API_KEY]) {
    modelRegistry.register('google', createGoogleProvider, {
      apiKey: config[ENV_KEYS.GOOGLE_API_KEY] as string,
    });
    registeredProviders.push('google');
  }

  // 4. Tracer — TraceRepo implements TraceSink interface
  const tracer = new Tracer(repos.traceRepo as unknown as TraceSink);

  // 5. AgentEngine — the core runtime, implements RuntimeDelegate.
  // Executors are resolved per-agent at run time (WS-21): agents with a
  // toolRunnerUrl get a RemoteToolExecutor for that URL; agents with no
  // execution config fail fast. No server-wide LocalToolExecutor singleton.
  //
  // WS-22: the resolver mints a short-lived, asymmetrically-signed scoped token
  // per tool invocation. The PRIVATE signing key lives only here (hosted
  // runtime); the SDK runner verifies with the distributed PUBLIC key. The raw
  // workspace API key is never used as a runner credential.
  const privateKeyMaterial = config[ENV_KEYS.RUNNER_TOKEN_PRIVATE_KEY];
  // Import lazily + once: buildContainer is sync, and tool-less deployments
  // never mint, so a missing key only fails when a remote tool actually runs.
  let signingKeyPromise: Promise<RunnerSigningKey> | null = null;
  const getSigningKey = (): Promise<RunnerSigningKey> => {
    if (!privateKeyMaterial) {
      throw new Error(
        `Remote tool execution requires ${ENV_KEYS.RUNNER_TOKEN_PRIVATE_KEY} to be configured`,
      );
    }
    signingKeyPromise ??= importRunnerPrivateKey(privateKeyMaterial);
    return signingKeyPromise;
  };

  // Deployed environments require HTTPS and disallow loopback; dev/test (https
  // not required) allow loopback for a local runner.
  const requireHttps = config[ENV_KEYS.RUNNER_REQUIRE_HTTPS] !== false;
  const runnerPolicy: OutboundUrlPolicy = {
    requireHttps,
    allowLoopback: !requireHttps,
  };

  const toolExecutorResolver = createToolExecutorResolver({
    policy: runnerPolicy,
    mintToken: async (agent, call, ctx) => {
      const audience = agent.toolRunnerUrl;
      if (!audience) {
        throw new Error(`Agent ${agent.agentId} has no tool runner URL to scope a token to`);
      }
      const signingKey = await getSigningKey();
      return mintRunnerToken(signingKey, {
        aud: audience,
        workspaceId: agent.workspaceId,
        agentId: agent.agentId,
        runId: ctx.runId,
        callId: call.callId,
        idempotencyKey: call.callId,
        toolName: call.toolName,
      });
    },
  });
  // WS-28: a thin console-backed logger so the loop's finalize logging is live
  // in production. Structured `data` is passed through as a second argument.
  const engineLogger: Logger = {
    info: (msg, data) => console.info(msg, data ?? {}),
    warn: (msg, data) => console.warn(msg, data ?? {}),
    error: (msg, data) => console.error(msg, data ?? {}),
  };

  const engineDeps: AgentEngineDeps = {
    db: {
      messages: repos.messageRepo,
      runs: repos.runRepo,
      toolCalls: repos.toolCallRepo,
      sessions: repos.sessionRepo,
      agents: repos.agentRepo,
    },
    modelRegistry,
    toolExecutorResolver,
    // WS-24: wire the observability tracer into the runtime loop so trace +
    // span records are populated on every run (previously the tracer was
    // instantiated but never passed in). This is what makes
    // `GET /v1/runs/:runId/trace` return real spans (SC-15).
    tracer,
    // WS-28: surface trace-write failures through the runtime logger instead of
    // swallowing them (SC-09).
    logger: engineLogger,
  };
  const engine = new AgentEngine(engineDeps);

  // The unified execution service (WS-23) owns the session lock + active-run
  // registry shared by REST and the gateway, so a REST-triggered run blocks a
  // concurrent WebSocket run on the same session and vice versa. Execution is
  // process-bound; in-flight runs are abandoned on restart (Phase 2 recovery).
  const runExecutionService = createRunExecutionService(engineDeps);

  // 6. API services
  const tokenService = createTokenService({
    secret: config[ENV_KEYS.CLIENT_JWT_SECRET],
  });

  const agentService = createAgentService(repos.agentRepo);

  const sessionService = createSessionService({
    sessionRepo: repos.sessionRepo,
    messageRepo: repos.messageRepo,
    runRepo: repos.runRepo,
    toolCallRepo: repos.toolCallRepo,
    agentService,
    runExecutionService,
  });

  return {
    dbClient,
    repos,
    modelRegistry,
    tracer,
    engine,
    runExecutionService,
    tokenService,
    agentService,
    sessionService,
    registeredProviders,
  };
}
