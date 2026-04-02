import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  TEST_API_KEY,
  SEED_RUN,
  createMockTraceRepo,
  createMockApiKeyRepo,
  createMockAgentRepo,
  createMockSessionRepo,
  createMockMessageRepo,
  createMockRunRepo,
  createMockToolCallRepo,
  TEST_JWT_SECRET,
} from './helpers.js';
import { buildApp, type AppContext } from '../server.js';

describe('Trace routes', () => {
  let app: FastifyInstance;
  const headers = { authorization: `Bearer ${TEST_API_KEY}` };

  describe('with seeded trace data', () => {
    let ctx: AppContext;
    const mockTraceRepo = createMockTraceRepo();

    const SEED_TRACE = {
      traceId: 'tr_testtrace12345678901',
      runId: SEED_RUN.runId,
      rootSpanId: 'sp_rootspan12345678901',
      startedAt: new Date('2025-01-01T00:00:00Z'),
      completedAt: new Date('2025-01-01T00:00:01Z'),
      totalDurationMs: 1000,
    };

    const SEED_SPANS = [
      {
        spanId: 'sp_rootspan12345678901',
        parentSpanId: null,
        traceId: 'tr_testtrace12345678901',
        type: 'run_span',
        name: 'run:run_testrun12345678901',
        startedAt: new Date('2025-01-01T00:00:00Z'),
        completedAt: new Date('2025-01-01T00:00:01Z'),
        durationMs: 1000,
        metadata: {},
        status: 'ok',
        error: null,
      },
      {
        spanId: 'sp_modelspan1234567890',
        parentSpanId: 'sp_rootspan12345678901',
        traceId: 'tr_testtrace12345678901',
        type: 'model_call_span',
        name: 'model:gpt-4',
        startedAt: new Date('2025-01-01T00:00:00.100Z'),
        completedAt: new Date('2025-01-01T00:00:00.500Z'),
        durationMs: 400,
        metadata: { modelName: 'gpt-4', promptTokens: 100, completionTokens: 50 },
        status: 'ok',
        error: null,
      },
    ];

    beforeAll(async () => {
      // Seed the mock trace repo
      await mockTraceRepo.saveTrace(SEED_TRACE);
      await mockTraceRepo.saveSpans(SEED_SPANS);

      ctx = await buildApp({
        repos: {
          apiKeyRepo: createMockApiKeyRepo(),
          agentRepo: createMockAgentRepo(),
          sessionRepo: createMockSessionRepo(),
          messageRepo: createMockMessageRepo(),
          runRepo: createMockRunRepo(),
          toolCallRepo: createMockToolCallRepo(),
          traceRepo: mockTraceRepo,
        },
        jwtSecret: TEST_JWT_SECRET,
        publicWebsocketUrl: 'ws://localhost:3001',
        logger: false,
      });
      app = ctx.app;
    });

    afterAll(async () => {
      await app.close();
    });

    it('GET /v1/runs/:runId/trace returns trace with spans', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/runs/${SEED_RUN.runId}/trace`,
        headers,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.trace.traceId).toBe('tr_testtrace12345678901');
      expect(body.trace.runId).toBe(SEED_RUN.runId);
      expect(body.spans).toHaveLength(2);
      expect(body.spans[0].type).toBe('run_span');
      expect(body.spans[1].type).toBe('model_call_span');
    });

    it('GET /v1/runs/:runId/trace returns 404 for run without trace', async () => {
      // Create a run that exists but has no trace
      const runRepo = createMockRunRepo();
      const traceRepo = createMockTraceRepo();

      const innerCtx = await buildApp({
        repos: {
          apiKeyRepo: createMockApiKeyRepo(),
          agentRepo: createMockAgentRepo(),
          sessionRepo: createMockSessionRepo(),
          messageRepo: createMockMessageRepo(),
          runRepo,
          toolCallRepo: createMockToolCallRepo(),
          traceRepo,
        },
        jwtSecret: TEST_JWT_SECRET,
        logger: false,
      });

      const res = await innerCtx.app.inject({
        method: 'GET',
        url: `/v1/runs/${SEED_RUN.runId}/trace`,
        headers,
      });

      expect(res.statusCode).toBe(404);
      await innerCtx.app.close();
    });

    it('GET /v1/traces/:traceId/spans returns span list', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/traces/tr_testtrace12345678901/spans`,
        headers,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveLength(2);
      expect(body.data[0].spanId).toBe('sp_rootspan12345678901');
    });

    it('GET /v1/traces/:traceId/spans returns empty for unknown trace', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/traces/tr_nonexistent000000000/spans',
        headers,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data).toHaveLength(0);
    });
  });
});
