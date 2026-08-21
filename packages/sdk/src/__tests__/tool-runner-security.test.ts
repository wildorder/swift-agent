import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { z } from 'zod';
import { SignJWT, generateKeyPair, type CryptoKey } from 'jose';
import type { FastifyInstance } from 'fastify';
import { startToolRunner } from '../tool-runner.js';
import { tool } from '../tool.js';
import type { ToolDefinition, ToolRegistry, RunnerAuthConfig } from '../types.js';

/**
 * WS-22 security tests for the SDK runner: scoped-token verification (SC-08) and
 * in-process idempotency de-dup (SC-10). Tokens are minted here with `jose` to
 * mirror the runtime's asymmetric minter without a runtime dependency.
 */

const AUDIENCE = 'https://runner-a.example';
const OTHER_AUDIENCE = 'https://runner-b.example';
const WORKSPACE = 'ws_owner';

let privateKey: CryptoKey;
let publicKey: CryptoKey;
let foreignPrivateKey: CryptoKey; // a different EdDSA key — forged tokens

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA');
  privateKey = pair.privateKey as CryptoKey;
  publicKey = pair.publicKey as CryptoKey;
  const foreign = await generateKeyPair('EdDSA');
  foreignPrivateKey = foreign.privateKey as CryptoKey;
});

interface Claims {
  aud?: string;
  workspaceId?: string;
  agentId?: string;
  runId?: string;
  callId?: string;
  idempotencyKey?: string;
  toolName?: string;
  expSeconds?: number;
}

function signWith(key: CryptoKey | Uint8Array, alg: string, c: Claims): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    workspaceId: c.workspaceId ?? WORKSPACE,
    agentId: c.agentId ?? 'agt_1',
    runId: c.runId ?? 'run_1',
    callId: c.callId ?? 'tc_1',
    idempotencyKey: c.idempotencyKey ?? 'tc_1',
    toolName: c.toolName ?? 'echo',
  })
    .setProtectedHeader({ alg })
    .setAudience(c.aud ?? AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(c.expSeconds ?? now + 60)
    .sign(key);
}

function mint(c: Claims = {}): Promise<string> {
  return signWith(privateKey, 'EdDSA', c);
}

function authConfig(overrides: Partial<RunnerAuthConfig> = {}): RunnerAuthConfig {
  return { publicKey, expectedAudience: AUDIENCE, expectedWorkspaceId: WORKSPACE, ...overrides };
}

function registry(...tools: ToolDefinition[]): ToolRegistry {
  const map: ToolRegistry = new Map();
  for (const t of tools) map.set(t.name, t);
  return map;
}

function body(overrides: Record<string, unknown> = {}, ctxOverrides: Record<string, unknown> = {}) {
  return {
    version: '1',
    idempotencyKey: 'tc_1',
    input: {},
    context: { sessionId: 'ses_1', agentId: 'agt_1', runId: 'run_1', callId: 'tc_1', ...ctxOverrides },
    ...overrides,
  };
}

async function getPort(app: FastifyInstance): Promise<number> {
  const addr = app.server.address();
  if (typeof addr === 'object' && addr) return addr.port;
  throw new Error('Server not listening');
}

async function post(port: number, path: string, b: unknown, token?: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(b),
  });
  const json = (await res.json().catch(() => null)) as Record<string, any> | null;
  return { status: res.status, body: json };
}

const echoTool = tool({
  name: 'echo',
  description: 'echo',
  inputSchema: z.object({}),
  execute: async () => ({ ok: true }),
});

describe('tool-runner security — scoped token verification (SC-08)', () => {
  let server: FastifyInstance | null = null;
  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it('accepts a valid token whose every scope claim matches the request', async () => {
    server = await startToolRunner({ port: 0, registry: registry(echoTool), auth: authConfig() });
    const port = await getPort(server);
    const { status } = await post(port, '/tools/echo', body(), await mint());
    expect(status).toBe(200);
  });

  it('rejects an expired token (401)', async () => {
    server = await startToolRunner({ port: 0, registry: registry(echoTool), auth: authConfig() });
    const port = await getPort(server);
    const now = Math.floor(Date.now() / 1000);
    const token = await mint({ expSeconds: now - 10 });
    const { status, body: b } = await post(port, '/tools/echo', body(), token);
    expect(status).toBe(401);
    expect(b?.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a token whose agentId does not match the request (401)', async () => {
    server = await startToolRunner({ port: 0, registry: registry(echoTool), auth: authConfig() });
    const port = await getPort(server);
    // Token says agt_2, request context says agt_1.
    const token = await mint({ agentId: 'agt_2' });
    const { status } = await post(port, '/tools/echo', body({}, { agentId: 'agt_1' }), token);
    expect(status).toBe(401);
  });

  it('rejects a token whose toolName does not match the path (401)', async () => {
    server = await startToolRunner({ port: 0, registry: registry(echoTool), auth: authConfig() });
    const port = await getPort(server);
    const token = await mint({ toolName: 'other' });
    const { status } = await post(port, '/tools/echo', body(), token);
    expect(status).toBe(401);
  });

  it('rejects mismatched runId / callId (401)', async () => {
    server = await startToolRunner({ port: 0, registry: registry(echoTool), auth: authConfig() });
    const port = await getPort(server);
    const token = await mint({ runId: 'run_9', callId: 'tc_9', idempotencyKey: 'tc_9' });
    const { status } = await post(port, '/tools/echo', body(), token);
    expect(status).toBe(401);
  });

  it('rejects a token signed by a foreign private key (401)', async () => {
    server = await startToolRunner({ port: 0, registry: registry(echoTool), auth: authConfig() });
    const port = await getPort(server);
    const token = await signWith(foreignPrivateKey, 'EdDSA', {});
    const { status } = await post(port, '/tools/echo', body(), token);
    expect(status).toBe(401);
  });

  it('rejects a symmetric (HS256) token — asymmetric key isolation (401)', async () => {
    server = await startToolRunner({ port: 0, registry: registry(echoTool), auth: authConfig() });
    const port = await getPort(server);
    const token = await signWith(new TextEncoder().encode('shared-secret'), 'HS256', {});
    const { status } = await post(port, '/tools/echo', body(), token);
    expect(status).toBe(401);
  });

  it('rejects cross-runner replay: aud targets runner A but this is runner B (401)', async () => {
    // Runner configured with a DIFFERENT expected audience.
    server = await startToolRunner({
      port: 0,
      registry: registry(echoTool),
      auth: authConfig({ expectedAudience: OTHER_AUDIENCE }),
    });
    const port = await getPort(server);
    const token = await mint({ aud: AUDIENCE }); // minted for runner A
    const { status } = await post(port, '/tools/echo', body(), token);
    expect(status).toBe(401);
  });

  it('rejects confused-deputy: valid signature + this runner URL but foreign workspace (401)', async () => {
    server = await startToolRunner({ port: 0, registry: registry(echoTool), auth: authConfig() });
    const port = await getPort(server);
    // aud matches this runner, but the token was minted for another workspace.
    const token = await mint({ aud: AUDIENCE, workspaceId: 'ws_attacker' });
    const { status } = await post(port, '/tools/echo', body(), token);
    expect(status).toBe(401);
  });
});

describe('tool-runner security — idempotency de-dup (SC-10)', () => {
  let server: FastifyInstance | null = null;
  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it('executes a handler once across a retried request with the same key', async () => {
    let executions = 0;
    const counter = tool({
      name: 'echo',
      description: 'counts',
      inputSchema: z.object({}),
      execute: async () => {
        executions += 1;
        return { n: executions };
      },
    });
    server = await startToolRunner({ port: 0, registry: registry(counter), auth: authConfig() });
    const port = await getPort(server);
    const token = await mint();

    const first = await post(port, '/tools/echo', body(), token);
    const second = await post(port, '/tools/echo', body(), token); // retry, same key

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(executions).toBe(1);
    expect(second.body?.result).toEqual(first.body?.result);
  });

  it('de-dups concurrent in-flight requests with the same key', async () => {
    let executions = 0;
    const slow = tool({
      name: 'echo',
      description: 'slow',
      inputSchema: z.object({}),
      execute: async () => {
        executions += 1;
        await new Promise((r) => setTimeout(r, 150));
        return { n: executions };
      },
    });
    server = await startToolRunner({ port: 0, registry: registry(slow), auth: authConfig() });
    const port = await getPort(server);
    const token = await mint();

    // Fire both before the first settles — the second must await the in-flight promise.
    const [a, b] = await Promise.all([
      post(port, '/tools/echo', body(), token),
      post(port, '/tools/echo', body(), token),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(executions).toBe(1);
    expect(a.body?.result).toEqual(b.body?.result);
  });

  it('rejects an over-limit request body with 400', async () => {
    server = await startToolRunner({ port: 0, registry: registry(echoTool), auth: authConfig() });
    const port = await getPort(server);
    const token = await mint();
    // Oversized input (> 256 KiB + envelope allowance).
    const huge = 'x'.repeat(300 * 1024);
    const { status, body: b } = await post(port, '/tools/echo', body({ input: { huge } }), token);
    expect(status).toBe(400);
    expect(b?.error.code).toBe('VALIDATION');
  });
});
