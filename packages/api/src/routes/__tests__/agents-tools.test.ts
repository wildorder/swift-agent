import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, TEST_API_KEY } from '../../__tests__/helpers.js';

describe('Agent registration — persisted tool contract', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const ctx = await buildTestApp();
    app = ctx.app;
  });

  afterAll(async () => {
    await app.close();
  });

  const headers = { authorization: `Bearer ${TEST_API_KEY}` };

  const tools = [
    {
      name: 'lookupOrder',
      description: 'Look up an order by id',
      inputSchema: { type: 'object', properties: { orderId: { type: 'string' } } },
    },
    {
      name: 'cancelOrder',
      description: 'Cancel an order',
      inputSchema: { type: 'object', properties: { orderId: { type: 'string' } } },
    },
  ];

  it('POST /v1/agents persists and returns tools (SC-01)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers,
      payload: {
        name: 'tools-agent',
        modelConfig: { model: 'anthropic/claude-sonnet' },
        systemPrompt: 'You are helpful.',
        tools,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.tools).toEqual(tools);
  });

  it('POST /v1/agents without tools defaults to [] (SC-02)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers,
      payload: {
        name: 'no-tools-agent',
        modelConfig: { model: 'anthropic/claude-sonnet' },
        systemPrompt: 'You are helpful.',
      },
    });
    expect([200, 201]).toContain(res.statusCode);
    const body = res.json();
    expect(body.tools).toEqual([]);
  });

  it('re-registration with identical tools is idempotent', async () => {
    const payload = {
      name: 'idempotent-agent',
      modelConfig: { model: 'anthropic/claude-sonnet' },
      systemPrompt: 'You are helpful.',
      tools,
    };

    const first = await app.inject({ method: 'POST', url: '/v1/agents', headers, payload });
    const second = await app.inject({ method: 'POST', url: '/v1/agents', headers, payload });

    expect(first.json().tools).toEqual(tools);
    expect(second.json().tools).toEqual(tools);
    expect(second.json().tools).toEqual(first.json().tools);
  });

  it('rejects a tool carrying an execute handler', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers,
      payload: {
        name: 'bad-tools-agent',
        modelConfig: { model: 'anthropic/claude-sonnet' },
        systemPrompt: 'You are helpful.',
        tools: [{ ...tools[0], execute: 'nope' }],
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
