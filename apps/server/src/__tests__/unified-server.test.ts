import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as jose from 'jose';
import WebSocket from 'ws';
import { buildApp, type AppContext } from '@swiftagent/api';
import {
  registerGatewayPlugin,
  createGatewayServer,
  type GatewayComponents,
  type RuntimeDelegate,
  type GatewayContext,
} from '@swiftagent/gateway';
import type { ChatEvent } from '@swiftagent/shared';
import { registerHealthCheck } from '../health.js';

// ── Helpers ──────────────────────────────────────────────────────────────

const JWT_SECRET = 'unified-server-test-secret-long-enough-hs256!!';
const JWT_SECRET_BYTES = new TextEncoder().encode(JWT_SECRET);

async function signToken(sessionId = 'ses_unified1'): Promise<string> {
  return new jose.SignJWT({ sessionId, agentId: 'agt_test1', permissions: ['chat'] })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer('swiftagent')
    .setAudience('swiftagent-gateway')
    .setExpirationTime('1h')
    .sign(JWT_SECRET_BYTES);
}

function waitForOpen(ws: WebSocket, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), timeoutMs);
    ws.on('open', () => { clearTimeout(timer); resolve(); });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function waitForClose(ws: WebSocket, timeoutMs = 5000): Promise<{ code: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket close timeout')), timeoutMs);
    ws.on('close', (code: number) => { clearTimeout(timer); resolve({ code }); });
  });
}

// Composed health shape from apps/server/src/health.ts.
interface HealthBody {
  status: string;
  checks: { db: string; redis: string; gateway: { connections: number } };
  uptime: number;
}

function collectMessages(ws: WebSocket, count: number, timeoutMs = 5000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const messages: string[] = [];
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${count} messages, got ${messages.length}`)),
      timeoutMs,
    );
    ws.on('message', (data: Buffer | string) => {
      messages.push(typeof data === 'string' ? data : data.toString('utf-8'));
      if (messages.length >= count) { clearTimeout(timer); resolve(messages); }
    });
  });
}

// Mock runtime yielding a 4-event ChatEvent sequence (mirrors the gateway suite).
const mockEvents: ChatEvent[] = [
  { type: 'message_started', messageId: 'msg_u1', runId: 'run_u1', sessionId: 'ses_unified1' },
  { type: 'token', runId: 'run_u1', sessionId: 'ses_unified1', messageId: 'msg_u1', text: 'Hi' },
  { type: 'token', runId: 'run_u1', sessionId: 'ses_unified1', messageId: 'msg_u1', text: ' there' },
  { type: 'message_completed', messageId: 'msg_u1', runId: 'run_u1', sessionId: 'ses_unified1' },
];

const mockRuntime: RuntimeDelegate = {
  start: (async (
    _input: { sessionId: string; content: string },
    opts?: { onEvent?: (event: ChatEvent) => void },
  ) => {
    for (const event of mockEvents) opts?.onEvent?.(event);
    return { runId: 'run_u1' };
  }) as unknown as RuntimeDelegate['start'],
  requestCancel: (async () => ({ requested: true })) as RuntimeDelegate['requestCancel'],
};

// Minimal mock DB client (tagged-template `pool` + `close`), mirroring health.test.ts.
const mockDbClient = {
  db: {},
  pool: Object.assign((..._args: unknown[]) => Promise.resolve([{ '?column?': 1 }]), { end: vi.fn() }),
  close: vi.fn(),
};

// Proxy-based repo mocks — routes close over these but never invoke them here.
const mockRepo = new Proxy({}, { get: () => () => Promise.resolve(undefined) });
const mockRepos = new Proxy({}, { get: () => mockRepo });

async function buildUnifiedApp(): Promise<{ api: AppContext; gw: GatewayComponents }> {
  const api = await buildApp({
    runExecutionService: mockRepo as never,
    repos: mockRepos as never,
    jwtSecret: JWT_SECRET,
    logger: false,
    // Server owns the composed root /health (below); opt out of buildApp's plain one.
    registerRootHealth: false,
  });
  const gw = await registerGatewayPlugin(
    api.app,
    { jwtSecret: JWT_SECRET, redisEnabled: false },
    mockRuntime,
  );
  registerHealthCheck(api.app, {
    dbClient: mockDbClient as never,
    connectionManager: gw.connectionManager,
    redisEnabled: false,
    redisPing: gw.redisPing,
  });
  return { api, gw };
}

// ── Suite: REST + WS on ONE port (SC-01) ───────────────────────────────────

describe('Unified server (REST + WebSocket on one port)', () => {
  let api: AppContext;
  let gw: GatewayComponents;
  let baseUrl: string;
  let wsUrl: string;
  let boundPort: number;
  const openSockets: WebSocket[] = [];

  beforeAll(async () => {
    ({ api, gw } = await buildUnifiedApp());
    const address = await api.app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = address;
    wsUrl = address.replace('http', 'ws');
    boundPort = Number(new URL(address).port);
  });

  afterEach(() => {
    for (const ws of openSockets) {
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      } catch { /* ignore */ }
    }
    openSockets.length = 0;
  });

  afterAll(async () => {
    gw.heartbeat.clear();
    gw.connectionManager.closeAll(1001, 'Test cleanup');
    await gw.sessionBridge.shutdown();
    await api.app.close();
  });

  function createWs(path: string): WebSocket {
    const ws = new WebSocket(`${wsUrl}${path}`);
    openSockets.push(ws);
    return ws;
  }

  it('serves REST /health with the composed gateway shape', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthBody;
    // Composed shape from apps/server/src/health.ts (not the plain api one).
    expect(body.checks.gateway.connections).toBe(0);
    expect(body.checks.redis).toBe('disabled');
    expect(body.checks.db).toBe('ok');
  });

  it('accepts a WebSocket /v1/stream connection on the SAME port as REST', async () => {
    const token = await signToken();
    const ws = createWs(`/v1/stream?token=${token}`);
    await waitForOpen(ws);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    // The socket's remote port is the very port the REST call used.
    expect(ws.url).toContain(`:${boundPort}/`);
    expect(gw.connectionManager).toBeDefined();
  });

  it('streams the ChatEvent sequence over the unified socket', async () => {
    const token = await signToken();
    const ws = createWs(`/v1/stream?token=${token}`);
    await waitForOpen(ws);
    await new Promise((r) => setTimeout(r, 100));

    const messagesPromise = collectMessages(ws, 4);
    ws.send(JSON.stringify({ type: 'send_message', content: 'hi' }));
    const messages = await messagesPromise;

    const events = messages.map((m) => JSON.parse(m));
    expect(events.map((e) => e.type)).toEqual([
      'message_started', 'token', 'token', 'message_completed',
    ]);
  });

  it('answers application-level ping with pong on the unified socket', async () => {
    const token = await signToken();
    const ws = createWs(`/v1/stream?token=${token}`);
    await waitForOpen(ws);
    await new Promise((r) => setTimeout(r, 100));

    const messagesPromise = collectMessages(ws, 1);
    ws.send(JSON.stringify({ type: 'ping' }));
    const [msg] = await messagesPromise;
    expect(JSON.parse(msg).type).toBe('pong');
  });

  // ── Health reports live gateway connection count ──────────────────────

  it('reports live gateway connection count via composed /health', async () => {
    const token = await signToken('ses_healthcount');
    const ws = createWs(`/v1/stream?token=${token}`);
    await waitForOpen(ws);
    await new Promise((r) => setTimeout(r, 100));

    const openBody = (await (await fetch(`${baseUrl}/health`)).json()) as HealthBody;
    expect(openBody.checks.gateway.connections).toBe(1);

    ws.close();
    await waitForClose(ws);
    await new Promise((r) => setTimeout(r, 100));

    const closedBody = (await (await fetch(`${baseUrl}/health`)).json()) as HealthBody;
    expect(closedBody.checks.gateway.connections).toBe(0);
  });
});

// ── Suite: consolidated graceful shutdown (SC-05) ──────────────────────────

describe('Unified server graceful shutdown', () => {
  it('drains in-flight WebSockets with code 1001 and stops accepting connections', async () => {
    const { api, gw } = await buildUnifiedApp();
    const address = await api.app.listen({ port: 0, host: '127.0.0.1' });
    const wsUrl = address.replace('http', 'ws');

    const token = await signToken('ses_shutdown');
    const ws = new WebSocket(`${wsUrl}/v1/stream?token=${token}`);
    await waitForOpen(ws);
    await new Promise((r) => setTimeout(r, 100));

    const closePromise = waitForClose(ws);

    // The exact shutdown sequence main.ts runs (minus process.exit / DB close):
    // drain sockets with 1001 BEFORE closing the app, else clients see 1005.
    gw.connectionManager.closeAll(1001, 'Server shutting down');
    gw.heartbeat.clear();
    await api.app.close();
    await gw.sessionBridge.shutdown();

    const { code } = await closePromise;
    expect(code).toBe(1001);

    // A fresh connect after close must not open (server stopped listening).
    const late = new WebSocket(`${wsUrl}/v1/stream?token=${token}`);
    await expect(waitForOpen(late, 1000)).rejects.toThrow();
    try { late.terminate(); } catch { /* ignore */ }
  });
});

// ── Suite: plugin lifecycle boundaries ─────────────────────────────────────

describe('registerGatewayPlugin lifecycle boundaries', () => {
  it('registers ZERO process signal handlers (unlike the standalone server)', async () => {
    // Fresh API app WITHOUT the gateway plugin, so we snapshot listener counts
    // immediately around a single registerGatewayPlugin call.
    const api = await buildApp({
      runExecutionService: mockRepo as never, repos: mockRepos as never,
      jwtSecret: JWT_SECRET, logger: false, registerRootHealth: false,
    });
    const sigtermBefore = process.listenerCount('SIGTERM');
    const sigintBefore = process.listenerCount('SIGINT');

    const gw = await registerGatewayPlugin(
      api.app,
      { jwtSecret: JWT_SECRET, redisEnabled: false },
      mockRuntime,
    );

    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore);

    // Sanity: it returns components, never an `app`.
    expect(gw.connectionManager).toBeDefined();
    expect('app' in gw).toBe(false);

    await api.app.close();
  });

  it('contrast: standalone createGatewayServer DOES add signal handlers', async () => {
    const termsBefore = process.listeners('SIGTERM');
    const intsBefore = process.listeners('SIGINT');

    const ctx: GatewayContext = await createGatewayServer(
      { jwtSecret: JWT_SECRET, logger: false },
      mockRuntime,
    );

    expect(process.listenerCount('SIGTERM') - termsBefore.length).toBe(1);
    expect(process.listenerCount('SIGINT') - intsBefore.length).toBe(1);

    // Clean up: close the app and drop exactly the handlers this test added, so
    // the process listener table is left as we found it (no leakage between tests).
    await ctx.app.close();
    ctx.heartbeat.clear();
    await ctx.sessionBridge.shutdown();
    for (const l of process.listeners('SIGTERM')) {
      if (!termsBefore.includes(l)) process.removeListener('SIGTERM', l);
    }
    for (const l of process.listeners('SIGINT')) {
      if (!intsBefore.includes(l)) process.removeListener('SIGINT', l);
    }
    expect(process.listenerCount('SIGTERM')).toBe(termsBefore.length);
    expect(process.listenerCount('SIGINT')).toBe(intsBefore.length);
  });

  it('exposes a callable redisPing that resolves true when Redis is disabled', async () => {
    const { api, gw } = await buildUnifiedApp();
    await expect(gw.redisPing()).resolves.toBe(true);
    await api.app.close();
  });

  it('mounting on two different apps does not leak @fastify/websocket between them', async () => {
    const a = await buildApp({
      runExecutionService: mockRepo as never, repos: mockRepos as never,
      jwtSecret: JWT_SECRET, logger: false, registerRootHealth: false,
    });
    const b = await buildApp({
      runExecutionService: mockRepo as never, repos: mockRepos as never,
      jwtSecret: JWT_SECRET, logger: false, registerRootHealth: false,
    });
    const gwA = await registerGatewayPlugin(a.app, { jwtSecret: JWT_SECRET, redisEnabled: false }, mockRuntime);
    const gwB = await registerGatewayPlugin(b.app, { jwtSecret: JWT_SECRET, redisEnabled: false }, mockRuntime);
    await expect(a.app.ready()).resolves.toBeDefined();
    await expect(b.app.ready()).resolves.toBeDefined();
    expect(gwA.connectionManager).not.toBe(gwB.connectionManager);
    await a.app.close();
    await b.app.close();
  });
});
