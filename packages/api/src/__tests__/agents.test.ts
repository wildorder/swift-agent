import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, TEST_API_KEY } from './helpers.js';

describe('Agents routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const ctx = await buildTestApp();
    app = ctx.app;
  });

  afterAll(async () => {
    await app.close();
  });

  const headers = { authorization: `Bearer ${TEST_API_KEY}` };

  it('POST /v1/agents creates a new agent (201)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers,
      payload: {
        name: 'new-agent',
        modelConfig: { model: 'anthropic/claude-sonnet' },
        systemPrompt: 'You are helpful.',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe('new-agent');
    expect(body.agentId).toMatch(/^agt_/);
  });

  it('POST /v1/agents updates existing agent (200)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers,
      payload: {
        name: 'test-agent',
        modelConfig: { model: 'openai/gpt-4o' },
        systemPrompt: 'Updated prompt.',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe('test-agent');
    expect(body.modelConfig.model).toBe('openai/gpt-4o');
  });

  it('GET /v1/agents/:agentId returns 404 when absent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents/agt_nonexistent000000000',
      headers,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('GET /v1/agents?name= returns agent by name', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents?name=test-agent',
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('test-agent');
  });

  it('GET /v1/agents without name lists all agents', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });
});
