import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, TEST_API_KEY } from './helpers.js';

describe('Auth middleware', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const ctx = await buildTestApp();
    app = ctx.app;
  });

  afterAll(async () => {
    await app.close();
  });

  it('attaches workspaceId when a valid API key is provided', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents?name=test-agent',
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe('test-agent');
  });

  it('returns 401 when Authorization header is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents?name=test-agent',
    });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 when API key is invalid', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents?name=test-agent',
      headers: { authorization: 'Bearer invalid-key-123456' },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('skips auth for /health', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('skips auth for /v1/health', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/health',
    });
    expect(res.statusCode).toBe(200);
  });
});
