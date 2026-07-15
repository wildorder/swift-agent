import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, TEST_API_KEY, SEED_SESSION, SEED_RUN, SEED_TOOL_CALLS } from './helpers.js';

describe('Runs routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const ctx = await buildTestApp();
    app = ctx.app;
  });

  afterAll(async () => {
    await app.close();
  });

  const headers = { authorization: `Bearer ${TEST_API_KEY}` };

  it('POST /v1/sessions/:sessionId/runs accepts a run (202)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${SEED_SESSION.sessionId}/runs`,
      headers,
      payload: { content: 'Hello, agent!' },
    });
    // Async execution: 202 Accepted with { runId, status } — no full RunRecord.
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.runId).toMatch(/^run_/);
    expect(body.status).toBe('running');
  });

  it('GET /v1/runs/:runId returns run status', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/runs/${SEED_RUN.runId}`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('completed');
  });

  it('GET /v1/runs/:runId returns 404 for unknown run', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/runs/run_nonexistent00000000',
      headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /v1/runs/:runId/tool-calls returns tool calls', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/runs/${SEED_RUN.runId}/tool-calls`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(SEED_TOOL_CALLS.length);
    expect(body.data[0].toolName).toBe('lookupOrder');
  });
});
