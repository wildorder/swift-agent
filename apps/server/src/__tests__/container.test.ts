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

vi.mock('@swiftagent/models', () => {
  const registerFn = vi.fn();
  return {
    ProviderRegistry: vi.fn(() => ({
      register: registerFn,
      getProvider: vi.fn(),
      resolveForModel: vi.fn(),
    })),
    createOpenAIProvider: vi.fn(),
    createAnthropicProvider: vi.fn(),
    createGoogleProvider: vi.fn(),
  };
});

vi.mock('@swiftagent/observability', () => ({
  Tracer: vi.fn(() => ({
    startRunTrace: vi.fn(),
  })),
}));

vi.mock('@swiftagent/runtime', () => ({
  AgentEngine: vi.fn(() => ({
    run: vi.fn(),
  })),
  LocalToolExecutor: vi.fn(() => ({
    execute: vi.fn(),
  })),
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
});
