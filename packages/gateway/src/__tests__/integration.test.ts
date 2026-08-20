import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as jose from 'jose';
import WebSocket from 'ws';
import { createGatewayServer } from '../server.js';
import type { GatewayContext } from '../server.js';
import type { GatewayConfig, RuntimeDelegate } from '../types.js';
import type { ChatEvent } from '@swiftagent/shared';

// ── Helpers ──────────────────────────────────────────────────────────────

const JWT_SECRET = 'integration-test-secret-long-enough-for-hs256!!';
const JWT_SECRET_BYTES = new TextEncoder().encode(JWT_SECRET);

async function signToken(
  claims: Record<string, unknown>,
  options?: { expiresIn?: string; secret?: Uint8Array },
): Promise<string> {
  return new jose.SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer('swiftagent')
    .setAudience('swiftagent-gateway')
    .setExpirationTime(options?.expiresIn ?? '1h')
    .sign(options?.secret ?? JWT_SECRET_BYTES);
}

function validClaims(sessionId = 'ses_integ1'): Record<string, unknown> {
  return {
    sessionId,
    agentId: 'agt_test1',
    permissions: ['chat'],
  };
}

/** Collect N messages from a WebSocket, with a timeout. */
function collectMessages(ws: WebSocket, count: number, timeoutMs = 5000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const messages: string[] = [];
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${count} messages, got ${messages.length}`));
    }, timeoutMs);

    ws.on('message', (data: Buffer | string) => {
      const str = typeof data === 'string' ? data : data.toString('utf-8');
      messages.push(str);
      if (messages.length >= count) {
        clearTimeout(timer);
        resolve(messages);
      }
    });
  });
}

/** Wait for WebSocket to open. */
function waitForOpen(ws: WebSocket, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), timeoutMs);
    ws.on('open', () => { clearTimeout(timer); resolve(); });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

/** Wait for WebSocket to close. */
function waitForClose(ws: WebSocket, timeoutMs = 5000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket close timeout')), timeoutMs);
    ws.on('close', (code: number, reason: Buffer) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString('utf-8') });
    });
  });
}

// ── Test suite ───────────────────────────────────────────────────────────

describe('Gateway Integration', () => {
  let ctx: GatewayContext;
  let baseUrl: string;
  let wsUrl: string;
  const openSockets: WebSocket[] = [];

  // Mock runtime that yields a sequence of ChatEvents
  const mockEvents: ChatEvent[] = [
    {
      type: 'message_started',
      messageId: 'msg_i1',
      runId: 'run_i1',
      sessionId: 'ses_integ1',
    },
    {
      type: 'token',
      runId: 'run_i1',
      sessionId: 'ses_integ1',
      messageId: 'msg_i1',
      text: 'Hello',
    },
    {
      type: 'token',
      runId: 'run_i1',
      sessionId: 'ses_integ1',
      messageId: 'msg_i1',
      text: ' World',
    },
    {
      type: 'message_completed',
      messageId: 'msg_i1',
      runId: 'run_i1',
      sessionId: 'ses_integ1',
    },
  ];

  const mockRuntime: RuntimeDelegate = {
    start: (async (
      _input: { sessionId: string; content: string },
      opts?: { onEvent?: (event: ChatEvent) => void },
    ) => {
      for (const event of mockEvents) {
        opts?.onEvent?.(event);
      }
      return { runId: 'run_i1' };
    }) as unknown as RuntimeDelegate['start'],
    requestCancel: (async () => ({ requested: true })) as RuntimeDelegate['requestCancel'],
  };

  beforeAll(async () => {
    const config: GatewayConfig = {
      port: 0, // Let OS pick a free port
      jwtSecret: JWT_SECRET,
      heartbeatTimeoutMs: 30_000,
      logger: false,
    };

    ctx = await createGatewayServer(config, mockRuntime);
    // Listen on port 0 to get a random free port
    const address = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = address;
    wsUrl = address.replace('http', 'ws');
  });

  afterEach(() => {
    // Close any sockets opened during tests
    for (const ws of openSockets) {
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      } catch {
        // ignore
      }
    }
    openSockets.length = 0;
  });

  afterAll(async () => {
    ctx.heartbeat.clear();
    ctx.connectionManager.closeAll(1001, 'Test cleanup');
    await ctx.sessionBridge.shutdown();
    await ctx.app.close();
  });

  function createWs(path: string): WebSocket {
    const ws = new WebSocket(`${wsUrl}${path}`);
    openSockets.push(ws);
    return ws;
  }

  // ── Health check ─────────────────────────────────────────────────────

  describe('GET /health', () => {
    it('returns status ok', async () => {
      const res = await fetch(`${baseUrl}/health`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toEqual({ status: 'ok' });
    });
  });

  // ── Auth: missing token ──────────────────────────────────────────────

  describe('WebSocket auth', () => {
    it('rejects connection without token', async () => {
      const ws = createWs('/v1/stream');

      const closePromise = waitForClose(ws);
      const messagesPromise = collectMessages(ws, 1);

      const [closeInfo, messages] = await Promise.all([closePromise, messagesPromise]);

      const errorEvent = JSON.parse(messages[0]);
      expect(errorEvent.type).toBe('error');
      expect(errorEvent.code).toBe('AUTH_REQUIRED');
      expect(closeInfo.code).toBe(4001);
    });

    it('rejects connection with invalid token', async () => {
      const ws = createWs('/v1/stream?token=garbage-not-a-jwt');

      const closePromise = waitForClose(ws);
      const messagesPromise = collectMessages(ws, 1);

      const [, messages] = await Promise.all([closePromise, messagesPromise]);

      const errorEvent = JSON.parse(messages[0]);
      expect(errorEvent.type).toBe('error');
      // Could be TOKEN_INVALID or TOKEN_MALFORMED
      expect(['TOKEN_INVALID', 'TOKEN_MALFORMED', 'AUTH_FAILED']).toContain(errorEvent.code);
    });

    it('rejects connection with expired token', async () => {
      const pastExp = Math.floor(Date.now() / 1000) - 3600;
      const token = await new jose.SignJWT(validClaims())
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setIssuer('swiftagent')
        .setAudience('swiftagent-gateway')
        .setExpirationTime(pastExp)
        .sign(JWT_SECRET_BYTES);

      const ws = createWs(`/v1/stream?token=${token}`);

      const closePromise = waitForClose(ws);
      const messagesPromise = collectMessages(ws, 1);

      const [closeResult, messages] = await Promise.all([closePromise, messagesPromise]);

      const errorEvent = JSON.parse(messages[0]);
      expect(errorEvent.type).toBe('error');
      expect(errorEvent.code).toBe('TOKEN_EXPIRED');
      expect(closeResult.code).toBe(4001);
    });

    it('rejects connection with wrong secret', async () => {
      const wrongSecret = new TextEncoder().encode('wrong-secret-long-enough-for-hs256-testing!!');
      const token = await signToken(validClaims(), { secret: wrongSecret });

      const ws = createWs(`/v1/stream?token=${token}`);

      const closePromise = waitForClose(ws);
      const messagesPromise = collectMessages(ws, 1);

      const [closeResult, messages] = await Promise.all([closePromise, messagesPromise]);

      const errorEvent = JSON.parse(messages[0]);
      expect(errorEvent.type).toBe('error');
      expect(errorEvent.code).toBe('TOKEN_INVALID');
      expect(closeResult.code).toBe(4003);
    });
  });

  // ── Authenticated flow ───────────────────────────────────────────────

  describe('Authenticated WebSocket', () => {
    it('connects successfully with valid token', async () => {
      const token = await signToken(validClaims());
      const ws = createWs(`/v1/stream?token=${token}`);

      await waitForOpen(ws);
      expect(ws.readyState).toBe(WebSocket.OPEN);

      // Give time for auth to complete
      await new Promise((r) => setTimeout(r, 100));
      expect(ctx.connectionManager.isConnected('ses_integ1')).toBe(true);
    });

    it('responds to application-level ping with pong', async () => {
      const token = await signToken(validClaims());
      const ws = createWs(`/v1/stream?token=${token}`);

      await waitForOpen(ws);
      // Wait for auth to complete
      await new Promise((r) => setTimeout(r, 100));

      const messagesPromise = collectMessages(ws, 1);
      ws.send(JSON.stringify({ type: 'ping' }));

      const messages = await messagesPromise;
      const pong = JSON.parse(messages[0]);
      expect(pong.type).toBe('pong');
    });

    it('does not drop a frame sent immediately on open (pre-auth buffer)', async () => {
      // Regression: the inbound handler used to be attached only after the
      // async auth + subscribe steps completed, so a frame sent the moment
      // `open` fired (fast localhost links) was silently dropped. The
      // synchronous pre-auth buffer must capture and replay it. Note: no
      // settle delay here, unlike the tests above — the race IS the test.
      const token = await signToken(validClaims());
      const ws = createWs(`/v1/stream?token=${token}`);

      const messagesPromise = collectMessages(ws, 1);
      await waitForOpen(ws);
      ws.send(JSON.stringify({ type: 'ping' }));

      const messages = await messagesPromise;
      const pong = JSON.parse(messages[0]);
      expect(pong.type).toBe('pong');
    });

    it('returns error for invalid inbound message', async () => {
      const token = await signToken(validClaims());
      const ws = createWs(`/v1/stream?token=${token}`);

      await waitForOpen(ws);
      await new Promise((r) => setTimeout(r, 100));

      const messagesPromise = collectMessages(ws, 1);
      ws.send('not valid json');

      const messages = await messagesPromise;
      const errorEvent = JSON.parse(messages[0]);
      expect(errorEvent.type).toBe('error');
      expect(errorEvent.code).toBe('INVALID_JSON');
    });

    it('returns error for invalid schema', async () => {
      const token = await signToken(validClaims());
      const ws = createWs(`/v1/stream?token=${token}`);

      await waitForOpen(ws);
      await new Promise((r) => setTimeout(r, 100));

      const messagesPromise = collectMessages(ws, 1);
      ws.send(JSON.stringify({ type: 'unknown_command' }));

      const messages = await messagesPromise;
      const errorEvent = JSON.parse(messages[0]);
      expect(errorEvent.type).toBe('error');
      expect(errorEvent.code).toBe('INVALID_SCHEMA');
    });

    it('receives ChatEvent sequence after sending a message', async () => {
      const token = await signToken(validClaims('ses_integ1'));
      const ws = createWs(`/v1/stream?token=${token}`);

      await waitForOpen(ws);
      await new Promise((r) => setTimeout(r, 100));

      // We expect 4 events: message_started, token, token, message_completed
      const messagesPromise = collectMessages(ws, 4);
      ws.send(JSON.stringify({ type: 'send_message', content: 'Hello agent!' }));

      const messages = await messagesPromise;
      expect(messages.length).toBe(4);

      const events = messages.map((m) => JSON.parse(m));

      expect(events[0].type).toBe('message_started');
      expect(events[0].runId).toBe('run_i1');
      expect(events[0].sessionId).toBe('ses_integ1');

      expect(events[1].type).toBe('token');
      expect(events[1].text).toBe('Hello');

      expect(events[2].type).toBe('token');
      expect(events[2].text).toBe(' World');

      expect(events[3].type).toBe('message_completed');
      expect(events[3].messageId).toBe('msg_i1');
    });

    it('broadcasts events to multiple connections on same session', async () => {
      const sessionId = 'ses_multi';
      const token1 = await signToken(validClaims(sessionId));
      const token2 = await signToken(validClaims(sessionId));

      const ws1 = createWs(`/v1/stream?token=${token1}`);
      const ws2 = createWs(`/v1/stream?token=${token2}`);

      await Promise.all([waitForOpen(ws1), waitForOpen(ws2)]);
      await new Promise((r) => setTimeout(r, 200));

      const messages1Promise = collectMessages(ws1, 4);
      const messages2Promise = collectMessages(ws2, 4);

      ws1.send(JSON.stringify({ type: 'send_message', content: 'Hello from ws1' }));

      const [messages1, messages2] = await Promise.all([messages1Promise, messages2Promise]);

      // Both should receive the same events
      expect(messages1.length).toBe(4);
      expect(messages2.length).toBe(4);

      // The serialized JSON should be identical
      for (let i = 0; i < 4; i++) {
        expect(JSON.parse(messages1[i]).type).toBe(JSON.parse(messages2[i]).type);
      }
    });

    it('cleans up connection on close', async () => {
      const sessionId = 'ses_cleanup';
      const token = await signToken(validClaims(sessionId));
      const ws = createWs(`/v1/stream?token=${token}`);

      await waitForOpen(ws);
      await new Promise((r) => setTimeout(r, 100));

      expect(ctx.connectionManager.isConnected(sessionId)).toBe(true);

      ws.close();
      await waitForClose(ws);

      // Give a tick for the close handler to fire
      await new Promise((r) => setTimeout(r, 100));
      expect(ctx.connectionManager.isConnected(sessionId)).toBe(false);
    });
  });
});
