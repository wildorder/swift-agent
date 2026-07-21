import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { z } from 'zod';
import { SignJWT, generateKeyPair, type CryptoKey } from 'jose';
import type { FastifyInstance } from 'fastify';
import { RUNNER_MAX_ERROR_BYTES } from '@swiftagent/shared';
import { startToolRunner } from '../tool-runner.js';
import { tool } from '../tool.js';
import type { ToolDefinition, ToolRegistry, RunnerAuthConfig } from '../types.js';

const AUDIENCE = 'https://runner.example';
const WORKSPACE = 'ws_owner';
const PORT = 0;

let privateKey: CryptoKey;
let publicKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA');
  privateKey = pair.privateKey as CryptoKey;
  publicKey = pair.publicKey as CryptoKey;
});

function authConfig(overrides: Partial<RunnerAuthConfig> = {}): RunnerAuthConfig {
  return { publicKey, expectedAudience: AUDIENCE, expectedWorkspaceId: WORKSPACE, ...overrides };
}

function buildRegistry(...tools: ToolDefinition[]): ToolRegistry {
  const map: ToolRegistry = new Map();
  for (const t of tools) map.set(t.name, t);
  return map;
}

interface ScopeClaims {
  aud?: string;
  workspaceId?: string;
  agentId?: string;
  runId?: string;
  callId?: string;
  idempotencyKey?: string;
  toolName?: string;
  expSeconds?: number; // absolute epoch seconds; default now + 60
}

async function mint(claims: ScopeClaims = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    workspaceId: claims.workspaceId ?? WORKSPACE,
    agentId: claims.agentId ?? 'agt_1',
    runId: claims.runId ?? 'run_1',
    callId: claims.callId ?? 'tc_1',
    idempotencyKey: claims.idempotencyKey ?? 'tc_1',
    toolName: claims.toolName ?? 'weather',
  })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setAudience(claims.aud ?? AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(claims.expSeconds ?? now + 60)
    .sign(privateKey);
}

function makeBody(overrides: Record<string, unknown> = {}, ctxOverrides: Record<string, unknown> = {}) {
  return {
    version: '1',
    idempotencyKey: 'tc_1',
    input: { city: 'NYC' },
    context: {
      sessionId: 'ses_abc',
      agentId: 'agt_1',
      runId: 'run_1',
      callId: 'tc_1',
      ...ctxOverrides,
    },
    ...overrides,
  };
}

async function getPort(app: FastifyInstance): Promise<number> {
  const addr = app.server.address();
  if (typeof addr === 'object' && addr) return addr.port;
  throw new Error('Server not listening');
}

async function post(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as Record<string, any> | null;
  return { status: res.status, body: json };
}

describe('tool-runner', () => {
  let server: FastifyInstance | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  const weatherTool = tool({
    name: 'weather',
    description: 'Get weather for a city',
    inputSchema: z.object({ city: z.string() }),
    execute: async ({ city }) => ({ temp: 72, city }),
  });

  const failingTool = tool({
    name: 'failing',
    description: 'Always fails',
    inputSchema: z.object({}),
    execute: async () => {
      throw new Error('Something went wrong');
    },
  });

  const slowTool = tool({
    name: 'slow',
    description: 'Takes too long',
    inputSchema: z.object({}),
    execute: () => new Promise((resolve) => setTimeout(resolve, 10_000)),
  });

  it('GET /health returns 200 without auth', async () => {
    server = await startToolRunner({ port: PORT, registry: buildRegistry(weatherTool), auth: authConfig() });
    const port = await getPort(server);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, any>).status).toBe('ok');
  });

  it('POST /tools/weather with a valid scoped token returns 200', async () => {
    server = await startToolRunner({ port: PORT, registry: buildRegistry(weatherTool), auth: authConfig() });
    const port = await getPort(server);
    const token = await mint({ toolName: 'weather' });

    const { status, body } = await post(port, '/tools/weather', makeBody(), {
      Authorization: `Bearer ${token}`,
    });

    expect(status).toBe(200);
    expect(body?.version).toBe('1');
    expect(body?.result).toEqual({ temp: 72, city: 'NYC' });
  });

  it('returns 401 when auth header is missing', async () => {
    server = await startToolRunner({ port: PORT, registry: buildRegistry(weatherTool), auth: authConfig() });
    const port = await getPort(server);
    const { status, body } = await post(port, '/tools/weather', makeBody());
    expect(status).toBe(401);
    expect(body?.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 with a bogus (non-JWT) token', async () => {
    server = await startToolRunner({ port: PORT, registry: buildRegistry(weatherTool), auth: authConfig() });
    const port = await getPort(server);
    const { status, body } = await post(port, '/tools/weather', makeBody(), {
      Authorization: 'Bearer not-a-real-token',
    });
    expect(status).toBe(401);
    expect(body?.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 404 for unknown tool (token scoped to that tool)', async () => {
    server = await startToolRunner({ port: PORT, registry: buildRegistry(weatherTool), auth: authConfig() });
    const port = await getPort(server);
    const token = await mint({ toolName: 'unknown' });
    const { status, body } = await post(
      port,
      '/tools/unknown',
      makeBody({ input: {} }),
      { Authorization: `Bearer ${token}` },
    );
    expect(status).toBe(404);
    expect(body?.error.code).toBe('NOT_FOUND');
  });

  it('returns 400 on Zod input validation failure', async () => {
    server = await startToolRunner({ port: PORT, registry: buildRegistry(weatherTool), auth: authConfig() });
    const port = await getPort(server);
    const token = await mint({ toolName: 'weather' });
    const { status, body } = await post(
      port,
      '/tools/weather',
      makeBody({ input: { city: 123 } }),
      { Authorization: `Bearer ${token}` },
    );
    expect(status).toBe(400);
    expect(body?.error.code).toBe('VALIDATION');
  });

  it('returns 400 on unsupported protocol version', async () => {
    server = await startToolRunner({ port: PORT, registry: buildRegistry(weatherTool), auth: authConfig() });
    const port = await getPort(server);
    const token = await mint({ toolName: 'weather' });
    const { status, body } = await post(
      port,
      '/tools/weather',
      makeBody({ version: '2' }),
      { Authorization: `Bearer ${token}` },
    );
    expect(status).toBe(400);
    expect(body?.error.code).toBe('VALIDATION');
    expect(body?.error.message).toContain('version');
  });

  it('returns 500 with structured error when handler throws', async () => {
    server = await startToolRunner({ port: PORT, registry: buildRegistry(failingTool), auth: authConfig() });
    const port = await getPort(server);
    const token = await mint({ toolName: 'failing', callId: 'tc_fail', idempotencyKey: 'tc_fail' });
    const { status, body } = await post(
      port,
      '/tools/failing',
      makeBody({ input: {}, idempotencyKey: 'tc_fail' }, { callId: 'tc_fail' }),
      { Authorization: `Bearer ${token}` },
    );
    expect(status).toBe(500);
    expect(body?.error.code).toBe('EXECUTION_ERROR');
    expect(body?.error.message).toBe('Something went wrong');
  });

  it('returns only the message (never the stack) on a handler throw, bounded to the byte cap', async () => {
    // A message shaped like a stack — the wire must carry the message text, not
    // any `err.stack`, and must be <= RUNNER_MAX_ERROR_BYTES (WS-41).
    const stackyTool = tool({
      name: 'stacky',
      description: 'throws with stack-like message',
      inputSchema: z.object({}),
      execute: async () => {
        throw new Error('boom\n    at somewhere (/secret/path.ts:1:1)');
      },
    });
    server = await startToolRunner({ port: PORT, registry: buildRegistry(stackyTool), auth: authConfig() });
    const port = await getPort(server);
    const token = await mint({ toolName: 'stacky', callId: 'tc_s', idempotencyKey: 'tc_s' });
    const { status, body } = await post(
      port,
      '/tools/stacky',
      makeBody({ input: {}, idempotencyKey: 'tc_s' }, { callId: 'tc_s' }),
      { Authorization: `Bearer ${token}` },
    );
    expect(status).toBe(500);
    expect(body?.error.code).toBe('EXECUTION_ERROR');
    expect(body?.error.message).toBe('boom\n    at somewhere (/secret/path.ts:1:1)');
    // The `.message` is exactly the thrown message — no `.stack` frames appended.
    expect(body?.error.message).not.toContain('at Object.execute');
    expect(Buffer.byteLength(body?.error.message as string, 'utf-8')).toBeLessThanOrEqual(
      RUNNER_MAX_ERROR_BYTES,
    );
  });

  it('caps an over-long handler error message to RUNNER_MAX_ERROR_BYTES', async () => {
    const hugeTool = tool({
      name: 'huge',
      description: 'throws a very long message',
      inputSchema: z.object({}),
      execute: async () => {
        throw new Error('x'.repeat(RUNNER_MAX_ERROR_BYTES * 2));
      },
    });
    server = await startToolRunner({ port: PORT, registry: buildRegistry(hugeTool), auth: authConfig() });
    const port = await getPort(server);
    const token = await mint({ toolName: 'huge', callId: 'tc_h', idempotencyKey: 'tc_h' });
    const { status, body } = await post(
      port,
      '/tools/huge',
      makeBody({ input: {}, idempotencyKey: 'tc_h' }, { callId: 'tc_h' }),
      { Authorization: `Bearer ${token}` },
    );
    expect(status).toBe(500);
    expect(Buffer.byteLength(body?.error.message as string, 'utf-8')).toBeLessThanOrEqual(
      RUNNER_MAX_ERROR_BYTES,
    );
  });

  it('returns 504 on timeout', async () => {
    server = await startToolRunner({
      port: PORT,
      registry: buildRegistry(slowTool),
      auth: authConfig(),
      toolTimeoutMs: 100,
    });
    const port = await getPort(server);
    const token = await mint({ toolName: 'slow', callId: 'tc_slow', idempotencyKey: 'tc_slow' });
    const { status, body } = await post(
      port,
      '/tools/slow',
      makeBody({ input: {}, idempotencyKey: 'tc_slow' }, { callId: 'tc_slow' }),
      { Authorization: `Bearer ${token}` },
    );
    expect(status).toBe(504);
    expect(body?.error.code).toBe('TIMEOUT');
    // Names the tool + the timeout, and stays within the byte cap (WS-41).
    expect(body?.error.message).toContain('slow');
    expect(body?.error.message).toContain('100ms');
    expect(Buffer.byteLength(body?.error.message as string, 'utf-8')).toBeLessThanOrEqual(
      RUNNER_MAX_ERROR_BYTES,
    );
  });

  it('passes agentId/runId/callId into the handler context', async () => {
    let received: Record<string, unknown> | null = null;
    const identityTool = tool({
      name: 'identity',
      description: 'echoes context',
      inputSchema: z.object({}),
      execute: async (_input, ctx) => {
        received = { ...ctx };
        return 'ok';
      },
    });
    server = await startToolRunner({ port: PORT, registry: buildRegistry(identityTool), auth: authConfig() });
    const port = await getPort(server);
    const token = await mint({ toolName: 'identity' });
    await post(port, '/tools/identity', makeBody({ input: {} }), {
      Authorization: `Bearer ${token}`,
    });

    expect(received).toMatchObject({
      sessionId: 'ses_abc',
      agentId: 'agt_1',
      runId: 'run_1',
      callId: 'tc_1',
    });
  });
});
