import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, TEST_API_KEY, SEED_SESSION, SEED_MESSAGES } from './helpers.js';

describe('Messages routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const ctx = await buildTestApp();
    app = ctx.app;
  });

  afterAll(async () => {
    await app.close();
  });

  const headers = { authorization: `Bearer ${TEST_API_KEY}` };

  it('GET /v1/sessions/:sessionId/messages returns ordered list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${SEED_SESSION.sessionId}/messages`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(SEED_MESSAGES.length);
    expect(body.data[0].role).toBe('user');
    expect(body.data[1].role).toBe('assistant');
  });

  it('GET /v1/sessions/:sessionId/messages supports cursor pagination', async () => {
    const firstMsg = SEED_MESSAGES[0];
    if (!firstMsg) throw new Error('Missing seed message');
    const firstMsgId = firstMsg.messageId;
    const res = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${SEED_SESSION.sessionId}/messages?cursor=${firstMsgId}`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // After the first message, should return the second
    expect(body.data).toHaveLength(1);
    expect(body.data[0].role).toBe('assistant');
  });

  it('GET /v1/sessions/:sessionId/messages returns 400 for invalid cursor', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${SEED_SESSION.sessionId}/messages?cursor=msg_invalid`,
      headers,
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /v1/sessions/:sessionId/messages returns 404 for unknown session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/sessions/ses_nonexistent00000000/messages',
      headers,
    });
    expect(res.statusCode).toBe(404);
  });
});
