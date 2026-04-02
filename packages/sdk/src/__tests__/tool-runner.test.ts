import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { startToolRunner } from '../tool-runner.js';
import { tool } from '../tool.js';
import type { ToolDefinition, ToolRegistry } from '../types.js';

const API_KEY = 'test-secret-key';
const PORT = 0; // Random port

function buildRegistry(...tools: ToolDefinition[]): ToolRegistry {
  const map: ToolRegistry = new Map();
  for (const t of tools) {
    map.set(t.name, t);
  }
  return map;
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
  const json = await res.json().catch(() => null) as Record<string, any>;
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
    server = await startToolRunner({
      port: PORT,
      registry: buildRegistry(weatherTool),
      apiKey: API_KEY,
    });

    const port = await getPort(server);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;
    expect(body.status).toBe('ok');
  });

  it('POST /tools/weather with valid auth and input returns 200', async () => {
    server = await startToolRunner({
      port: PORT,
      registry: buildRegistry(weatherTool),
      apiKey: API_KEY,
    });

    const port = await getPort(server);
    const { status, body } = await post(
      port,
      '/tools/weather',
      { input: { city: 'NYC' }, context: { sessionId: 'ses_abc' } },
      { Authorization: `Bearer ${API_KEY}` },
    );

    expect(status).toBe(200);
    expect(body.result).toEqual({ temp: 72, city: 'NYC' });
  });

  it('returns 401 when auth header is missing', async () => {
    server = await startToolRunner({
      port: PORT,
      registry: buildRegistry(weatherTool),
      apiKey: API_KEY,
    });

    const port = await getPort(server);
    const { status, body } = await post(port, '/tools/weather', {
      input: { city: 'NYC' },
      context: { sessionId: 'ses_abc' },
    });

    expect(status).toBe(401);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 with wrong API key', async () => {
    server = await startToolRunner({
      port: PORT,
      registry: buildRegistry(weatherTool),
      apiKey: API_KEY,
    });

    const port = await getPort(server);
    const { status, body } = await post(
      port,
      '/tools/weather',
      { input: { city: 'NYC' }, context: { sessionId: 'ses_abc' } },
      { Authorization: 'Bearer wrong-key' },
    );

    expect(status).toBe(401);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 404 for unknown tool', async () => {
    server = await startToolRunner({
      port: PORT,
      registry: buildRegistry(weatherTool),
      apiKey: API_KEY,
    });

    const port = await getPort(server);
    const { status, body } = await post(
      port,
      '/tools/unknown',
      { input: {}, context: { sessionId: 'ses_abc' } },
      { Authorization: `Bearer ${API_KEY}` },
    );

    expect(status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns 400 on Zod validation failure', async () => {
    server = await startToolRunner({
      port: PORT,
      registry: buildRegistry(weatherTool),
      apiKey: API_KEY,
    });

    const port = await getPort(server);
    const { status, body } = await post(
      port,
      '/tools/weather',
      { input: { city: 123 }, context: { sessionId: 'ses_abc' } },
      { Authorization: `Bearer ${API_KEY}` },
    );

    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION');
  });

  it('returns 500 with structured error when handler throws', async () => {
    server = await startToolRunner({
      port: PORT,
      registry: buildRegistry(failingTool),
      apiKey: API_KEY,
    });

    const port = await getPort(server);
    const { status, body } = await post(
      port,
      '/tools/failing',
      { input: {}, context: { sessionId: 'ses_abc' } },
      { Authorization: `Bearer ${API_KEY}` },
    );

    expect(status).toBe(500);
    expect(body.error.code).toBe('EXECUTION_ERROR');
    expect(body.error.message).toBe('Something went wrong');
  });

  it('returns 504 on timeout', async () => {
    server = await startToolRunner({
      port: PORT,
      registry: buildRegistry(slowTool),
      apiKey: API_KEY,
      toolTimeoutMs: 100, // Very short timeout
    });

    const port = await getPort(server);
    const { status, body } = await post(
      port,
      '/tools/slow',
      { input: {}, context: { sessionId: 'ses_abc' } },
      { Authorization: `Bearer ${API_KEY}` },
    );

    expect(status).toBe(504);
    expect(body.error.code).toBe('TIMEOUT');
  });
});
