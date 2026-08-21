import { createHash, randomUUID } from 'node:crypto';
import { generateKeyPair, type CryptoKey } from 'jose';
import {
  createDbClient,
  createWorkspaceRepo,
  createApiKeyRepo,
  createAgentRepo,
  createSessionRepo,
  createMessageRepo,
  createRunRepo,
  createToolCallRepo,
  createTraceRepo,
  createUserRepo,
  createUserWorkspaceRepo,
  type Db,
} from '@swiftagent/db';
import {
  generateWorkspaceId,
  generateApiKeyId,
  generateAgentId,
  generateSessionId,
  type AgentRecord,
  type SessionRecord,
  type ToolDefinition as SharedToolDefinition,
  type MemoryConfig,
} from '@swiftagent/shared';
import { ProviderRegistry } from '@swiftagent/models';
import { Tracer, type TraceSink } from '@swiftagent/observability';
import {
  createToolExecutorResolver,
  createRunExecutionService,
  mintRunnerToken,
  type ToolExecutorResolver,
  type RunExecutionService,
  type AgentEngineDeps,
  type AgentEngineOptions,
  type OutboundUrlPolicy,
} from '@swiftagent/runtime';
import { buildApp, createTokenService, type AppContext } from '@swiftagent/api';
import { createGatewayServer, type GatewayContext } from '@swiftagent/gateway';
import type { AddressInfo } from 'node:net';
import { createFakeProvider, type FakeProviderHandle } from './fake-provider.js';

/**
 * Composes the REAL runtime — repos, fake provider registry, per-agent executor
 * resolution with asymmetric scoped-token minting, `RunExecutionService`,
 * `Tracer`, `buildApp`, and gateway — against the Testcontainers Postgres that
 * `test/setup-db.ts` provisions (via the real Drizzle migrator). No second
 * container, no schema bootstrap: the harness only reads `DATABASE_URL`.
 */

const FAKE_MODEL = 'fake/deterministic';
const JWT_SECRET = 'ws25-integration-jwt-secret-at-least-32-bytes';

export interface HarnessRepos {
  workspaceRepo: ReturnType<typeof createWorkspaceRepo>;
  apiKeyRepo: ReturnType<typeof createApiKeyRepo>;
  agentRepo: ReturnType<typeof createAgentRepo>;
  sessionRepo: ReturnType<typeof createSessionRepo>;
  messageRepo: ReturnType<typeof createMessageRepo>;
  runRepo: ReturnType<typeof createRunRepo>;
  toolCallRepo: ReturnType<typeof createToolCallRepo>;
  traceRepo: ReturnType<typeof createTraceRepo>;
  userRepo: ReturnType<typeof createUserRepo>;
  userWorkspaceRepo: ReturnType<typeof createUserWorkspaceRepo>;
}

export interface GatewayHandle {
  ctx: GatewayContext;
  port: number;
  /** `ws://127.0.0.1:${port}/v1/stream` — append `?token=<clientToken>`. */
  wsBaseUrl: string;
}

export interface SeedAgentOptions {
  workspaceId: string;
  model?: string;
  systemPrompt?: string;
  tools?: SharedToolDefinition[];
  toolRunnerUrl?: string | null;
  memoryConfig?: MemoryConfig;
  name?: string;
}

export interface RuntimeHarness {
  db: Db;
  repos: HarnessRepos;
  modelRegistry: ProviderRegistry;
  fake: FakeProviderHandle;
  resolver: ToolExecutorResolver;
  tracer: Tracer;
  keys: { privateKey: CryptoKey; publicKey: CryptoKey };
  policy: OutboundUrlPolicy;
  jwtSecret: string;
  /** The fake model string agents should use (`fake/deterministic`). */
  fakeModel: string;

  /** Build a run execution service against the shared deps, with tuned options. */
  createRunService(options?: AgentEngineOptions): RunExecutionService;
  /** Build a REST app (`AppContext`) wired to the given run service. */
  buildRestApp(runService: RunExecutionService): Promise<AppContext>;
  /** Build + listen a gateway wired to the given run service; returns its URL. */
  buildGateway(runService: RunExecutionService): Promise<GatewayHandle>;
  /** Mint a client WS token (HS256) for a session. */
  signClientToken(payload: { sessionId: string; agentId: string; permissions?: string[] }): Promise<string>;

  // Seeding helpers ───────────────────────────────────────────────────────
  seedWorkspaceWithKey(): Promise<{ workspaceId: string; apiKey: string }>;
  seedAgent(opts: SeedAgentOptions): Promise<AgentRecord>;
  seedSession(agentId: string, opts?: { userId?: string; metadata?: Record<string, unknown> }): Promise<SessionRecord>;

  teardown(): Promise<void>;
}

/** SHA-256 hex of an API key — matches the auth middleware's hashing. */
function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export async function createRuntimeHarness(): Promise<RuntimeHarness> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set — is test/setup-db.ts running as globalSetup?');
  }

  const dbClient = createDbClient(databaseUrl);
  const { db } = dbClient;

  const repos: HarnessRepos = {
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

  // Fake deterministic provider, registered under the `fake` provider id with an
  // explicit config so the registry never reaches for a real API key env var.
  const fake = createFakeProvider();
  const modelRegistry = new ProviderRegistry();
  modelRegistry.register('fake', () => fake.provider, { apiKey: 'fake' });

  const tracer = new Tracer(repos.traceRepo as unknown as TraceSink);

  // Asymmetric runner keypair (EdDSA) — the private key mints scoped tokens, the
  // public key is provisioned to the SDK runner for verification.
  const { privateKey, publicKey } = await generateKeyPair('EdDSA');

  // Dev/test policy: no HTTPS requirement, loopback runners permitted. Non-loopback
  // private / link-local / metadata targets are still rejected (SC-09).
  const policy: OutboundUrlPolicy = { requireHttps: false, allowLoopback: true };

  const resolver = createToolExecutorResolver({
    policy,
    mintToken: async (agent, call, ctx) => {
      const audience = agent.toolRunnerUrl;
      if (!audience) {
        throw new Error(`Agent ${agent.agentId} has no tool runner URL to scope a token to`);
      }
      return mintRunnerToken(privateKey, {
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

  const engineDeps: AgentEngineDeps = {
    db: {
      messages: repos.messageRepo,
      runs: repos.runRepo,
      toolCalls: repos.toolCallRepo,
      sessions: repos.sessionRepo,
      agents: repos.agentRepo,
    },
    modelRegistry,
    toolExecutorResolver: resolver,
    tracer,
  };

  const tokenService = createTokenService({ secret: JWT_SECRET });

  const restApps: AppContext[] = [];
  const gateways: GatewayContext[] = [];

  const harness: RuntimeHarness = {
    db,
    repos,
    modelRegistry,
    fake,
    resolver,
    tracer,
    keys: { privateKey, publicKey },
    policy,
    jwtSecret: JWT_SECRET,
    fakeModel: FAKE_MODEL,

    createRunService(options) {
      return createRunExecutionService(engineDeps, options);
    },

    async buildRestApp(runService) {
      const app = await buildApp({
        runExecutionService: runService,
        repos,
        jwtSecret: JWT_SECRET,
        publicWebsocketUrl: 'ws://127.0.0.1:0/v1/stream',
        logger: false,
      });
      restApps.push(app);
      return app;
    },

    async buildGateway(runService) {
      const ctx = await createGatewayServer(
        { jwtSecret: JWT_SECRET, redisEnabled: false, logger: false },
        runService,
      );
      await ctx.app.listen({ port: 0, host: '127.0.0.1' });
      gateways.push(ctx);
      const addr = ctx.app.server.address() as AddressInfo;
      const { port } = addr;
      return { ctx, port, wsBaseUrl: `ws://127.0.0.1:${port}/v1/stream` };
    },

    signClientToken(payload) {
      return tokenService.signClientToken({
        sessionId: payload.sessionId,
        agentId: payload.agentId,
        permissions: payload.permissions ?? ['chat'],
      });
    },

    async seedWorkspaceWithKey() {
      const workspaceId = generateWorkspaceId();
      await repos.workspaceRepo.create({ workspaceId, name: `ws-${randomUUID()}` });
      const apiKey = `ak_${randomUUID().replace(/-/g, '')}`;
      await repos.apiKeyRepo.create({
        apiKeyId: generateApiKeyId(),
        workspaceId,
        keyHash: hashKey(apiKey),
        name: 'ws25-test-key',
      });
      return { workspaceId, apiKey };
    },

    async seedAgent(opts) {
      return repos.agentRepo.create({
        agentId: generateAgentId(),
        workspaceId: opts.workspaceId,
        name: opts.name ?? `agent-${randomUUID()}`,
        modelConfig: { model: opts.model ?? FAKE_MODEL },
        systemPrompt: opts.systemPrompt ?? 'You are a deterministic test agent.',
        memoryConfig: opts.memoryConfig ?? { strategy: 'last_n', maxMessages: 50 },
        tools: opts.tools ?? [],
        toolRunnerUrl: opts.toolRunnerUrl ?? null,
      });
    },

    async seedSession(agentId, sopts) {
      return repos.sessionRepo.create({
        sessionId: generateSessionId(),
        agentId,
        userId: sopts?.userId ?? null,
        metadata: sopts?.metadata ?? {},
      });
    },

    async teardown() {
      for (const g of gateways) {
        await g.app.close();
        g.connectionManager.closeAll(1001, 'test teardown');
        g.heartbeat.clear();
        await g.sessionBridge.shutdown();
      }
      for (const a of restApps) {
        await a.app.close();
      }
      await dbClient.close();
    },
  };

  return harness;
}

/**
 * A permissive persisted JSON input schema for a seeded tool. Ajv is configured
 * `strict:false`, so `{ type:'object' }` accepts any argument object the fake
 * model emits (letting the executor / runner enforce the real bounds).
 */
export function anyObjectSchema(): Record<string, unknown> {
  return { type: 'object', additionalProperties: true };
}

/** Build a persisted tool definition (name + description + JSON input schema). */
export function seededTool(name: string, description = `${name} tool`): SharedToolDefinition {
  return { name, description, inputSchema: anyObjectSchema() };
}
