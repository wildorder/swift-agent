import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import * as jose from 'jose';
import { buildTestApp, TEST_API_KEY, TEST_JWT_SECRET } from './helpers.js';

describe('Sessions routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const ctx = await buildTestApp();
    app = ctx.app;
  });

  afterAll(async () => {
    await app.close();
  });

  const headers = { authorization: `Bearer ${TEST_API_KEY}` };

  it('POST /v1/sessions returns sessionId, clientToken, websocketUrl', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers,
      payload: {
        agentName: 'test-agent',
        userId: 'user_abc',
        metadata: { foo: 'bar' },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.sessionId).toMatch(/^ses_/);
    expect(typeof body.clientToken).toBe('string');
    expect(body.websocketUrl).toContain('ws://');
    expect(body.websocketUrl).toContain(body.clientToken);
  });

  it('POST /v1/sessions JWT is decodable and contains correct claims', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers,
      payload: { agentName: 'test-agent' },
    });
    const { clientToken } = res.json();

    const secret = new TextEncoder().encode(TEST_JWT_SECRET);
    const { payload } = await jose.jwtVerify(clientToken, secret, {
      issuer: 'swiftagent',
      audience: 'swiftagent-gateway',
    });

    expect(payload.sessionId).toMatch(/^ses_/);
    expect(payload.agentId).toMatch(/^agt_/);
    expect(payload.permissions).toEqual(['chat']);
    expect(typeof payload.exp).toBe('number');
  });

  it('POST /v1/sessions returns 404 for unknown agent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers,
      payload: { agentName: 'nonexistent-agent' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('PATCH /v1/sessions/:sessionId updates status', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers,
      payload: { agentName: 'test-agent' },
    });
    const { sessionId } = createRes.json();

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/sessions/${sessionId}`,
      headers,
      payload: { status: 'closed' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('closed');
  });
});
