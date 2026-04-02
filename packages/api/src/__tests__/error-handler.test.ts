import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SwiftAgentError } from '@swiftagent/shared';
import { z } from 'zod';
import { buildTestApp, TEST_API_KEY } from './helpers.js';

describe('Error handler', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const ctx = await buildTestApp();
    app = ctx.app;

    // Register test routes that throw specific errors
    app.get('/test/domain-error', async () => {
      throw new SwiftAgentError('NOT_FOUND', 'Resource not found');
    });

    app.get('/test/zod-error', async () => {
      z.object({ name: z.string() }).parse({ name: 123 });
    });

    app.get('/test/unexpected-error', async () => {
      throw new Error('Something unexpected happened');
    });
  });

  afterAll(async () => {
    await app.close();
  });

  const headers = { authorization: `Bearer ${TEST_API_KEY}` };

  it('maps SwiftAgentError to correct status and JSON body', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/test/domain-error',
      headers,
    });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBe('Resource not found');
  });

  it('maps ZodError to 400 with validation details', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/test/zod-error',
      headers,
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('VALIDATION');
    expect(body.error.details).toBeDefined();
    expect(Array.isArray(body.error.details)).toBe(true);
  });

  it('maps unknown errors to 500 with generic message', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/test/unexpected-error',
      headers,
    });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.message).toBe('Internal server error');
    // Should NOT leak the actual error message
    expect(body.error.message).not.toContain('unexpected');
  });
});
