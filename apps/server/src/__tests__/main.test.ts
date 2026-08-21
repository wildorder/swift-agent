import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all packages used by main.ts
vi.mock('@swiftagent/shared', async () => {
  const actual = await vi.importActual('@swiftagent/shared');
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

// Hoisted so the (hoisted-above-imports) vi.mock factories below can reference
// these spies without hitting a temporal-dead-zone error, while the test body
// can still assert on them.
const { mockClose, mockListen, mockApiApp } = vi.hoisted(() => {
  const listen = vi.fn(async () => {});
  return {
    mockClose: vi.fn(async () => {}),
    mockListen: listen,
    mockApiApp: {
      listen,
      close: vi.fn(async () => {}),
      get: vi.fn(),
      inject: vi.fn(),
    },
  };
});

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
      userRepo: {},
      userWorkspaceRepo: {},
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

vi.mock('@swiftagent/api', () => ({
  buildApp: vi.fn(async () => ({
    app: mockApiApp,
    tokenService: {},
    agentService: {},
    sessionService: {},
  })),
}));

vi.mock('@swiftagent/gateway', () => ({
  // WS-30: main.ts mounts the gateway onto the API app via registerGatewayPlugin
  // (no second Fastify app, no second listen). Returns a GatewayComponents shape.
  registerGatewayPlugin: vi.fn(async () => ({
    connectionManager: { closeAll: vi.fn(), connectionCount: vi.fn(() => 0) },
    sessionBridge: { shutdown: vi.fn(async () => {}) },
    heartbeat: { clear: vi.fn() },
    redisPing: vi.fn(async () => true),
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

  it('calls listen exactly once (unified REST + WS server)', async () => {
    await startServer();
    // WS-30: a single Fastify instance serves REST + WebSocket on one port, so
    // listen is called exactly once (no separate gateway listener).
    expect(mockListen).toHaveBeenCalledTimes(1);
  });
});
