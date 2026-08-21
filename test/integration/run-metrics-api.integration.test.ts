import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createRuntimeHarness, seededTool, type RuntimeHarness } from '../support/runtime-harness.js';
import { byTurn } from '../support/fake-provider.js';
import { startFakeRunner, type FakeRunnerHandle } from '../support/fake-runner.js';

/**
 * WS-29 · Run-metrics API (SC-07 / SC-11). Drives a REAL run through the WS-25
 * harness, then reads WS-28's `GET /v1/runs/:runId/metrics` via the REST app:
 * derived latency + token roll-ups for the owning workspace, and a 404 (no
 * existence leak) for a foreign workspace. Shared migrated DB; isolation by
 * fresh seeded IDs.
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('run-metrics-api (SC-07 / SC-11)', () => {
  let harness: RuntimeHarness;
  let app: FastifyInstance;
  // The run service the REST app is wired to; runs are started through it so the
  // REST app observes them. Assigned in beforeAll.
  let metricsRunService: ReturnType<RuntimeHarness['createRunService']>;
  const runners: FakeRunnerHandle[] = [];

  beforeAll(async () => {
    harness = await createRuntimeHarness();
    metricsRunService = harness.createRunService();
    const ctx = await harness.buildRestApp(metricsRunService);
    app = ctx.app;
  });

  afterAll(async () => {
    while (runners.length) await runners.pop()!.teardown();
    await harness.teardown();
  });

  function auth(apiKey: string): { authorization: string } {
    return { authorization: `Bearer ${apiKey}` };
  }

  async function pollRun(apiKey: string, runId: string, timeoutMs = 15_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await app.inject({ method: 'GET', url: `/v1/runs/${runId}`, headers: auth(apiKey) });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      if (body.status !== 'running') return body;
      if (Date.now() > deadline) throw new Error(`Run ${runId} stuck at running`);
      await sleep(20);
    }
  }

  /** The metrics endpoint reads persisted spans; the trace lands in the loop's
   *  `finally`, just after the terminal status — retry briefly on a first 404. */
  async function getMetrics(apiKey: string, runId: string, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/runs/${runId}/metrics`,
        headers: auth(apiKey),
      });
      if (res.statusCode !== 404 || Date.now() > deadline) return res;
      await sleep(20);
    }
  }

  it('returns derived roll-ups for the owning workspace, with token usage from the model span (SC-07)', async () => {
    const { workspaceId, apiKey } = await harness.seedWorkspaceWithKey();
    const runner = await startFakeRunner({ publicKey: harness.keys.publicKey, workspaceId });
    runners.push(runner);
    const agent = await harness.seedAgent({
      workspaceId,
      tools: [seededTool('echo')],
      toolRunnerUrl: runner.url,
    });
    const session = await harness.seedSession(agent.agentId);

    // Only the FINAL model turn reports usage; the tool-call turn reports zero so
    // the span-summed `totalTokens` is exactly the final turn's 15 (SC-08 proof
    // that WS-28 put token metadata on the model span).
    harness.fake.setResponder(
      byTurn(
        { toolCalls: [{ toolName: 'echo', arguments: { hi: true } }], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
        { tokens: ['done'], usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
      ),
    );

    const { runId } = await metricsRunService.start({ sessionId: session.sessionId, content: 'echo it' });
    const run = await pollRun(apiKey, runId);
    expect(run.status).toBe('completed');

    const res = await getMetrics(apiKey, runId);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      runId: string;
      modelCallCount: number;
      toolCallCount: number;
      totalModelLatencyMs: number;
      totalToolLatencyMs: number;
      totalRunDurationMs: number | null;
      totalTokens: number;
    };

    expect(body.runId).toBe(runId);
    expect(body.modelCallCount).toBeGreaterThanOrEqual(1);
    expect(body.toolCallCount).toBe(1);
    expect(body.totalModelLatencyMs).toBeGreaterThanOrEqual(0);
    expect(body.totalToolLatencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof body.totalRunDurationMs).toBe('number');
    expect(body.totalRunDurationMs).toBeGreaterThanOrEqual(0);
    expect(body.totalTokens).toBe(15);
  });

  it('returns 404 for a foreign workspace (ownership, no existence leak) (SC-07)', async () => {
    const { workspaceId, apiKey } = await harness.seedWorkspaceWithKey();
    const runner = await startFakeRunner({ publicKey: harness.keys.publicKey, workspaceId });
    runners.push(runner);
    const agent = await harness.seedAgent({
      workspaceId,
      tools: [seededTool('echo')],
      toolRunnerUrl: runner.url,
    });
    const session = await harness.seedSession(agent.agentId);
    harness.fake.setResponder(
      byTurn(
        { toolCalls: [{ toolName: 'echo', arguments: {} }], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
        { tokens: ['done'], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      ),
    );

    const { runId } = await metricsRunService.start({ sessionId: session.sessionId, content: 'echo it' });
    await pollRun(apiKey, runId);
    // Confirm the owner can read it (so the 404 below is about ownership, not a
    // missing trace).
    const ownerRes = await getMetrics(apiKey, runId);
    expect(ownerRes.statusCode).toBe(200);

    const other = await harness.seedWorkspaceWithKey();
    const foreignRes = await app.inject({
      method: 'GET',
      url: `/v1/runs/${runId}/metrics`,
      headers: auth(other.apiKey),
    });
    expect(foreignRes.statusCode).toBe(404);
  });
});
