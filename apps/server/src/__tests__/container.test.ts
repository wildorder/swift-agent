import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerConfig } from '../config.js';

// Mock all external packages to avoid real DB/Redis connections
vi.mock('@swiftagent/db', () => {
  const mockDb = {};
  return {
    createDbClient: vi.fn(() => ({
      db: mockDb,
      pool: {},
      close: vi.fn(),
    })),
    createWorkspaceRepo: vi.fn(() => ({ name: 'workspace' })),
    createApiKeyRepo: vi.fn(() => ({ name: 'apiKey' })),
    createAgentRepo: vi.fn(() => ({ name: 'agent', getById: vi.fn() })),
    createSessionRepo: vi.fn(() => ({ name: 'session' })),
    createMessageRepo: vi.fn(() => ({ name: 'message' })),
    createRunRepo: vi.fn(() => ({ name: 'run' })),
    createToolCallRepo: vi.fn(() => ({ name: 'toolCall' })),
    createTraceRepo: vi.fn(() => ({ name: 'trace', saveTrace: vi.fn(), saveSpans: vi.fn() })),
    createUserRepo: vi.fn(() => ({ name: 'user' })),
    createUserWorkspaceRepo: vi.fn(() => ({ name: 'userWorkspace' })),
  };
});

// Hoisted so both the vi.mock factory and the test bodies can see the register
// spy (asserting exactly which provider ids get registered, WS-43).
const { registerFn } = vi.hoisted(() => ({ registerFn: vi.fn() }));

vi.mock('@swiftagent/models', () => {
  return {
    ProviderRegistry: vi.fn(() => ({
      register: registerFn,
      getProvider: vi.fn(),
      resolveForModel: vi.fn(),
    })),
    createOpenAIProvider: vi.fn(),
    createAnthropicProvider: vi.fn(),
    createGoogleProvider: vi.fn(),
    createEchoProvider: vi.fn(),
    createToolFixtureProvider: vi.fn(),
  };
});

vi.mock('@swiftagent/observability', () => ({
  Tracer: vi.fn(() => ({
    startRunTrace: vi.fn(),
  })),
}));

// Hoisted so the vi.mock factory (itself hoisted above imports) can reference
// these spies, while the test body can still assert on them.
const { resolverInstance, createToolExecutorResolverMock, localToolExecutorMock } = vi.hoisted(() => {
  const resolverInstance = { resolve: vi.fn() };
  return {
    resolverInstance,
    createToolExecutorResolverMock: vi.fn(() => resolverInstance),
    localToolExecutorMock: vi.fn(() => ({ execute: vi.fn() })),
  };
});

vi.mock('@swiftagent/runtime', () => ({
  AgentEngine: vi.fn(() => ({
    run: vi.fn(),
  })),
  // WS-23: the container composes a unified RunExecutionService from the same
  // engine deps. Must be mocked or buildContainer throws on the missing export.
  createRunExecutionService: vi.fn(() => ({
    start: vi.fn(),
    cancel: vi.fn(),
  })),
  createToolExecutorResolver: createToolExecutorResolverMock,
  // WS-22: imported for per-invocation scoped-token minting. Only invoked inside
  // the resolver's mintToken closure at run time, never during composition.
  mintRunnerToken: vi.fn(),
  importRunnerPrivateKey: vi.fn(),
  // Exported for completeness, but composition must NOT construct one.
  LocalToolExecutor: localToolExecutorMock,
}));

vi.mock('@swiftagent/api', () => ({
  createTokenService: vi.fn(() => ({
    signClientToken: vi.fn(),
    verifyClientToken: vi.fn(),
  })),
  createAgentService: vi.fn(() => ({
    registerOrUpdateAgent: vi.fn(),
    getById: vi.fn(),
    getByName: vi.fn(),
  })),
  createSessionService: vi.fn(() => ({
    createSession: vi.fn(),
    getSession: vi.fn(),
  })),
}));

// Import after mocks
import { buildContainer } from '../container.js';
import { AgentEngine } from '@swiftagent/runtime';

describe('buildContainer', () => {
  const baseConfig: ServerConfig = {
    DATABASE_URL: 'postgres://localhost:5432/test',
    REDIS_URL: undefined as unknown as string,
    CLIENT_JWT_SECRET: 'test-secret',
    OPENAI_API_KEY: 'sk-test',
    ANTHROPIC_API_KEY: undefined,
    GOOGLE_API_KEY: undefined,
    PUBLIC_WEBSOCKET_URL: undefined,
    TOOL_RUNNER_PUBLIC_URL: undefined,
    API_PORT: 3000,
    GATEWAY_PORT: 3001,
    AUTO_MIGRATE: false,
    LOCAL_FIXTURE_PROVIDER: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a Container with all expected properties', () => {
    const container = buildContainer(baseConfig);

    expect(container.dbClient).toBeDefined();
    expect(container.repos).toBeDefined();
    expect(container.repos.workspaceRepo).toBeDefined();
    expect(container.repos.apiKeyRepo).toBeDefined();
    expect(container.repos.agentRepo).toBeDefined();
    expect(container.repos.sessionRepo).toBeDefined();
    expect(container.repos.messageRepo).toBeDefined();
    expect(container.repos.runRepo).toBeDefined();
    expect(container.repos.toolCallRepo).toBeDefined();
    expect(container.repos.traceRepo).toBeDefined();
    expect(container.modelRegistry).toBeDefined();
    expect(container.tracer).toBeDefined();
    expect(container.engine).toBeDefined();
    expect(container.runExecutionService).toBeDefined();
    expect(container.tokenService).toBeDefined();
    expect(container.agentService).toBeDefined();
    expect(container.sessionService).toBeDefined();
    expect(container.registeredProviders).toBeDefined();
  });

  it('only registers providers whose keys are present', () => {
    const container = buildContainer(baseConfig);
    // Only openai key is set
    expect(container.registeredProviders).toEqual(['openai']);
  });

  it('registers multiple providers when multiple keys are set', () => {
    const config: ServerConfig = {
      ...baseConfig,
      ANTHROPIC_API_KEY: 'sk-ant-test',
      GOOGLE_API_KEY: 'gk-test',
    };
    const container = buildContainer(config);
    expect(container.registeredProviders).toEqual(['openai', 'anthropic', 'google']);
  });

  it('registers no providers when no keys are set', () => {
    const config: ServerConfig = {
      ...baseConfig,
      OPENAI_API_KEY: undefined,
    };
    const container = buildContainer(config);
    expect(container.registeredProviders).toEqual([]);
  });

  // WS-43: the `fixture` tool-calling provider is gated on the local-only flag;
  // `echo` stays always-registered (cloud smoke); neither joins
  // `registeredProviders` (doc-commented choice: banner tracks key-gated real
  // providers only, the flag itself shows in redactConfig).
  it('registers the fixture provider only when LOCAL_FIXTURE_PROVIDER is set', () => {
    buildContainer(baseConfig);
    const idsWithoutFlag = registerFn.mock.calls.map((c) => c[0] as string);
    expect(idsWithoutFlag).toContain('echo');
    expect(idsWithoutFlag).not.toContain('fixture');

    vi.clearAllMocks();

    const container = buildContainer({ ...baseConfig, LOCAL_FIXTURE_PROVIDER: true });
    const idsWithFlag = registerFn.mock.calls.map((c) => c[0] as string);
    expect(idsWithFlag).toContain('echo');
    expect(idsWithFlag).toContain('fixture');
    // Excluded from the key-gated banner list, like echo.
    expect(container.registeredProviders).toEqual(['openai']);

    // Registered with an explicit throwaway config, never a real env key.
    const fixtureCall = registerFn.mock.calls.find((c) => c[0] === 'fixture');
    expect(fixtureCall?.[2]).toEqual({ apiKey: 'fixture-provider-no-key' });
  });

  // WS-21 / SC-07: composition wires a per-agent resolver, not a fixed
  // server-wide LocalToolExecutor singleton.
  it('composes the engine with a ToolExecutorResolver, not a LocalToolExecutor', () => {
    buildContainer(baseConfig);

    // A resolver was built and no LocalToolExecutor singleton was constructed.
    expect(createToolExecutorResolverMock).toHaveBeenCalledTimes(1);
    expect(localToolExecutorMock).not.toHaveBeenCalled();

    // The engine received the resolver (and NOT a `toolExecutor`).
    const engineArgs = (AgentEngine as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(engineArgs.toolExecutorResolver).toBe(resolverInstance);
    expect(engineArgs.toolExecutor).toBeUndefined();
  });
});
