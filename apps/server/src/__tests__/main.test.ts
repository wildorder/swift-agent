import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock all packages used by main.ts
vi.mock('@swiftagent/shared', async () => {
  const actual = await vi.importActual<typeof import('@swiftagent/shared')>('@swiftagent/shared');
  return actual;
});

vi.mock('../config.js', () => ({
  loadServerConfig: vi.fn(() => ({
    DATABASE_URL: 'postgres://localhost:5432/test',
    REDIS_URL: undefined,
    CLIENT_JWT_SECRET: 'test-secret',
    OPENAI_API_KEY: 'sk-test',
    ANTHROPIC_API_KEY: undefined,
    GOOGLE_API_KEY: undefined,
    PUBLIC_WEBSOCKET_URL: undefined,
    TOOL_RUNNER_PUBLIC_URL: undefined,
    API_PORT: 0, // random port
    GATEWAY_PORT: 0, // random port
    AUTO_MIGRATE: false,
  })),
  redactConfig: vi.fn(() => ({
    DATABASE_URL: '***',
    API_PORT: '0',
    GATEWAY_PORT: '0',
  })),
}));

const mockClose = vi.fn(async () => {});
const mockListen = vi.fn(async () => {});

vi.mock('../container.js', () => ({
  buildContainer: vi.fn(() => ({
    dbClient: { db: {}, pool: {}, close: mockClose },
    repos: {
      workspaceRepo: {},
      apiKeyRepo: {},
      agentRepo: {},
      sessionRepo: {},
      messageRepo: {},
      runRepo: {},
      toolCallRepo: {},
      traceRepo: {},
    },
    modelRegistry: {},
    tracer: {},
    engine: { run: vi.fn() },
    tokenService: {},
    agentService: {},
    sessionService: {},
    registeredProviders: ['openai'],
  })),
}));

const mockApiApp = {
  listen: mockListen,
  close: vi.fn(async () => {}),
  get: vi.fn(),
  inject: vi.fn(),
};

vi.mock('@swiftagent/api', () => ({
  buildApp: vi.fn(async () => ({
    app: mockApiApp,
    tokenService: {},
    agentService: {},
    sessionService: {},
  })),
}));

const mockGatewayApp = {
  listen: mockListen,
  close: vi.fn(async () => {}),
};

vi.mock('@swiftagent/gateway', () => ({
  createGatewayServer: vi.fn(async () => ({
    app: mockGatewayApp,
    connectionManager: { closeAll: vi.fn(), connectionCount: vi.fn(() => 0) },
    sessionBridge: { shutdown: vi.fn(async () => {}) },
    heartbeat: { clear: vi.fn() },
  })),
  ConnectionManager: vi.fn(),
}));

vi.mock('../health.js', () => ({
  registerHealthCheck: vi.fn(),
}));

import { startServer } from '../main.js';

describe('startServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts the server and returns a ServerContext', async () => {
    const ctx = await startServer();
    expect(ctx.config).toBeDefined();
    expect(ctx.container).toBeDefined();
    expect(ctx.api).toBeDefined();
    expect(ctx.gateway).toBeDefined();
  });

  it('calls listen on both API and gateway servers', async () => {
    await startServer();
    // listen is called twice: once for API, once for gateway
    expect(mockListen).toHaveBeenCalledTimes(2);
  });
});
