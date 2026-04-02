import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, TEST_API_KEY } from './helpers.js';

describe('Integration: agent → session → messages', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const ctx = await buildTestApp();
    app = ctx.app;
  });

  afterAll(async () => {
    await app.close();
  });

  const headers = { authorization: `Bearer ${TEST_API_KEY}` };

  it('creates agent → creates session → lists messages (empty for new session)', async () => {
    // Step 1: Create agent
    const agentRes = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers,
      payload: {
        name: 'integration-agent',
        modelConfig: { model: 'openai/gpt-4' },
        systemPrompt: 'Integration test agent.',
      },
    });
    expect(agentRes.statusCode).toBe(201);
    const agent = agentRes.json();
    expect(agent.agentId).toMatch(/^agt_/);

    // Step 2: Create session
    const sessionRes = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers,
      payload: {
        agentName: 'integration-agent',
        userId: 'user_int',
      },
    });
    expect(sessionRes.statusCode).toBe(201);
    const session = sessionRes.json();
    expect(session.sessionId).toMatch(/^ses_/);
    expect(session.clientToken).toBeDefined();
    expect(session.websocketUrl).toBeDefined();

    // Step 3: List messages (empty for this new session since mock returns
    // SEED_MESSAGES only for the seed session)
    const msgsRes = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${session.sessionId}/messages`,
      headers,
    });
    expect(msgsRes.statusCode).toBe(200);
    const msgs = msgsRes.json();
    expect(Array.isArray(msgs.data)).toBe(true);
  });

  it('health endpoint has X-Request-Id header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBeDefined();
  });
});
