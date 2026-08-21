import { describe, it, expect } from 'vitest';
import type { TraceRepo, TraceRecordRow, SpanRecordRow } from '@swiftagent/db';
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
  createMockUserRepo,
  createMockUserWorkspaceRepo,
  createMockWorkspaceRepo,
  createMockRunExecutionService,
  TEST_JWT_SECRET,
} from './helpers.js';
import { buildApp, type AppContext } from '../server.js';
import { RunMetricsResponseSchema } from '../types.js';

const headers = { authorization: `Bearer ${TEST_API_KEY}` };

const TRACE_ID = 'tr_metricstrace123456';

const SEED_TRACE: TraceRecordRow = {
  traceId: TRACE_ID,
  runId: SEED_RUN.runId,
  rootSpanId: 'sp_rootspan1234567890',
  startedAt: new Date('2025-01-01T00:00:00Z'),
  completedAt: new Date('2025-01-01T00:00:01Z'),
  totalDurationMs: 1000,
};

function runSpan(): SpanRecordRow {
  return {
    spanId: 'sp_rootspan1234567890',
    parentSpanId: null,
    traceId: TRACE_ID,
    type: 'run_span',
    name: `run:${SEED_RUN.runId}`,
    startedAt: new Date('2025-01-01T00:00:00Z'),
    completedAt: new Date('2025-01-01T00:00:01Z'),
    durationMs: 1000,
    metadata: {},
    status: 'ok',
    error: null,
  };
}

function modelSpan(id: string, offsetMs: number, durationMs: number, metadata: Record<string, unknown>): SpanRecordRow {
  const started = new Date(Date.parse('2025-01-01T00:00:00Z') + offsetMs);
  return {
    spanId: id,
    parentSpanId: 'sp_rootspan1234567890',
    traceId: TRACE_ID,
    type: 'model_call_span',
    name: 'model:gpt-4',
    startedAt: started,
    completedAt: new Date(started.getTime() + durationMs),
    durationMs,
    metadata,
    status: 'ok',
    error: null,
  };
}

function toolSpan(id: string, offsetMs: number, durationMs: number): SpanRecordRow {
  const started = new Date(Date.parse('2025-01-01T00:00:00Z') + offsetMs);
  return {
    spanId: id,
    parentSpanId: 'sp_rootspan1234567890',
    traceId: TRACE_ID,
    type: 'tool_call_span',
    name: 'tool:lookupOrder',
    startedAt: started,
    completedAt: new Date(started.getTime() + durationMs),
    durationMs,
    metadata: { toolName: 'lookupOrder', callId: 'tc_1' },
    status: 'ok',
    error: null,
  };
}

async function buildAppWith(traceRepo: TraceRepo): Promise<AppContext> {
  return buildApp({
    runExecutionService: createMockRunExecutionService(),
    repos: {
      apiKeyRepo: createMockApiKeyRepo(),
      agentRepo: createMockAgentRepo(),
      sessionRepo: createMockSessionRepo(),
      messageRepo: createMockMessageRepo(),
      runRepo: createMockRunRepo(),
      toolCallRepo: createMockToolCallRepo(),
      traceRepo,
      userRepo: createMockUserRepo(),
      userWorkspaceRepo: createMockUserWorkspaceRepo(),
      workspaceRepo: createMockWorkspaceRepo(),
    },
    jwtSecret: TEST_JWT_SECRET,
    publicWebsocketUrl: 'ws://localhost:3001',
    logger: false,
  });
}

async function seededRepo(spans: SpanRecordRow[]): Promise<TraceRepo> {
  const repo = createMockTraceRepo();
  await repo.saveTrace(SEED_TRACE);
  await repo.saveSpans(spans);
  return repo;
}

describe('Metrics route — GET /v1/runs/:runId/metrics', () => {
  it('happy path: returns 200 with span counts, latencies, and summed tokens (SC-07/SC-08)', async () => {
    const spans = [
      runSpan(),
      modelSpan('sp_model1234567890a', 100, 400, { modelName: 'gpt-4', promptTokens: 100, completionTokens: 50 }),
      modelSpan('sp_model1234567890b', 600, 300, { modelName: 'gpt-4', promptTokens: 100, completionTokens: 50 }),
      toolSpan('sp_tool12345678901a', 500, 200),
    ];
    const ctx = await buildAppWith(await seededRepo(spans));

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/runs/${SEED_RUN.runId}/metrics`,
      headers,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.runId).toBe(SEED_RUN.runId);
    expect(body.traceId).toBe(TRACE_ID);
    expect(body.modelCallCount).toBe(2);
    expect(body.toolCallCount).toBe(1);
    expect(body.totalModelLatencyMs).toBe(700);
    expect(body.totalToolLatencyMs).toBe(200);
    expect(body.totalRunDurationMs).toBe(1000);
    expect(body.totalTokens).toBe(300);

    await ctx.app.close();
  });

  it('token correctness: a single model span with { promptTokens: 100, completionTokens: 50 } yields totalTokens === 150 (SC-08)', async () => {
    const spans = [
      runSpan(),
      modelSpan('sp_model1234567890a', 100, 400, { modelName: 'gpt-4', promptTokens: 100, completionTokens: 50 }),
    ];
    const ctx = await buildAppWith(await seededRepo(spans));

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/runs/${SEED_RUN.runId}/metrics`,
      headers,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().totalTokens).toBe(150);

    await ctx.app.close();
  });

  it('run-row fallback: spans without token metadata fall back to run.tokenUsage.totalTokens', async () => {
    // Seeded spans carry NO token metadata; SEED_RUN.tokenUsage.totalTokens === 150.
    const spans = [
      runSpan(),
      modelSpan('sp_model1234567890a', 100, 400, { modelName: 'gpt-4' }),
    ];
    const ctx = await buildAppWith(await seededRepo(spans));

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/runs/${SEED_RUN.runId}/metrics`,
      headers,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().totalTokens).toBe(150);

    await ctx.app.close();
  });

  it('span-derived tokens win over the run row when spans carry tokens', async () => {
    // Spans sum to 400 tokens; SEED_RUN row total is 150 — the span sum wins.
    const spans = [
      runSpan(),
      modelSpan('sp_model1234567890a', 100, 400, { promptTokens: 250, completionTokens: 150 }),
    ];
    const ctx = await buildAppWith(await seededRepo(spans));

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/runs/${SEED_RUN.runId}/metrics`,
      headers,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().totalTokens).toBe(400);

    await ctx.app.close();
  });

  it('404 when the run exists but has no trace (SC-07)', async () => {
    // Empty trace repo: ownership passes (SEED_RUN exists) but no trace is found.
    const ctx = await buildAppWith(createMockTraceRepo());

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/runs/${SEED_RUN.runId}/metrics`,
      headers,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');

    await ctx.app.close();
  });

  it('404 when the run is missing/cross-workspace, without consulting the trace repo (SC-07)', async () => {
    let listed = false;
    const spyRepo = createMockTraceRepo();
    const wrapped: TraceRepo = {
      ...spyRepo,
      getTraceByRunId: async (runId) => {
        listed = true;
        return spyRepo.getTraceByRunId(runId);
      },
      listSpansByTraceId: async (traceId) => {
        listed = true;
        return spyRepo.listSpansByTraceId(traceId);
      },
    };
    const ctx = await buildAppWith(wrapped);

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/runs/run_doesnotexist12345/metrics',
      headers,
    });

    expect(res.statusCode).toBe(404);
    // No existence leak: the trace repo is never consulted for a run that fails
    // the ownership check.
    expect(listed).toBe(false);

    await ctx.app.close();
  });

  it('response body satisfies RunMetricsResponseSchema (strict, no extra keys)', async () => {
    const spans = [
      runSpan(),
      modelSpan('sp_model1234567890a', 100, 400, { promptTokens: 100, completionTokens: 50 }),
    ];
    const ctx = await buildAppWith(await seededRepo(spans));

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/runs/${SEED_RUN.runId}/metrics`,
      headers,
    });

    expect(res.statusCode).toBe(200);
    expect(() => RunMetricsResponseSchema.parse(res.json())).not.toThrow();

    await ctx.app.close();
  });
});
