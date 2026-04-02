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
} from '@swiftagent/db';
import {
  ProviderRegistry,
  createOpenAIProvider,
  createAnthropicProvider,
  createGoogleProvider,
} from '@swiftagent/models';
import { Tracer, type TraceSink } from '@swiftagent/observability';
import { AgentEngine, LocalToolExecutor } from '@swiftagent/runtime';
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
  };

  /** Model provider registry with registered providers */
  modelRegistry: ProviderRegistry;

  /** Observability tracer */
  tracer: Tracer;

  /** Agent runtime engine — implements RuntimeDelegate */
  engine: AgentEngine;

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
  };

  // 3. Model provider registry — only register providers whose API keys are present
  const modelRegistry = new ProviderRegistry();
  const registeredProviders: string[] = [];

  if (config[ENV_KEYS.OPENAI_API_KEY]) {
    modelRegistry.register('openai', createOpenAIProvider, {
      apiKey: config[ENV_KEYS.OPENAI_API_KEY]!,
    });
    registeredProviders.push('openai');
  }

  if (config[ENV_KEYS.ANTHROPIC_API_KEY]) {
    modelRegistry.register('anthropic', createAnthropicProvider, {
      apiKey: config[ENV_KEYS.ANTHROPIC_API_KEY]!,
    });
    registeredProviders.push('anthropic');
  }

  if (config[ENV_KEYS.GOOGLE_API_KEY]) {
    modelRegistry.register('google', createGoogleProvider, {
      apiKey: config[ENV_KEYS.GOOGLE_API_KEY]!,
    });
    registeredProviders.push('google');
  }

  // 4. Tracer — TraceRepo implements TraceSink interface
  const tracer = new Tracer(repos.traceRepo as unknown as TraceSink);

  // 5. AgentEngine — the core runtime, implements RuntimeDelegate
  const toolExecutor = new LocalToolExecutor();
  const engine = new AgentEngine({
    db: {
      messages: repos.messageRepo,
      runs: repos.runRepo,
      toolCalls: repos.toolCallRepo,
      sessions: repos.sessionRepo,
      agents: repos.agentRepo,
    },
    modelRegistry,
    toolExecutor,
  });

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
  });

  return {
    dbClient,
    repos,
    modelRegistry,
    tracer,
    engine,
    tokenService,
    agentService,
    sessionService,
    registeredProviders,
  };
}
