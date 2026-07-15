import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  createRuntimeHarness,
  seededTool,
  type RuntimeHarness,
} from '../support/runtime-harness.js';
import { byTurn, textTurn, toolTurn } from '../support/fake-provider.js';
import { startFakeRunner, type FakeRunnerHandle } from '../support/fake-runner.js';

/**
 * WS-25 · REST async runs (SC-11). A `202` run start observed to a terminal
 * state by polling, with tool-call and trace endpoints reflecting persistence,
 * idempotent cancel, and cross-workspace isolation (404, no existence leak).
 */
describe('rest-runs', () => {
  let harness: RuntimeHarness;
  let app: FastifyInstance;
  const runners: FakeRunnerHandle[] = [];

  beforeAll(async () => {
    harness = await createRuntimeHarness();
    const service = harness.createRunService();
    const ctx = await harness.buildRestApp(service);
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
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it('starts a run (202), polls to terminal, and exposes tool-calls + trace', async () => {
    const { workspaceId, apiKey } = await harness.seedWorkspaceWithKey();
    const runner = await startFakeRunner({ publicKey: harness.keys.publicKey, workspaceId });
    runners.push(runner);

    const agent = await harness.seedAgent({
      workspaceId,
      tools: [seededTool('echo')],
      toolRunnerUrl: runner.url,
    });

    harness.fake.setResponder(byTurn(toolTurn('echo', { hi: true }), textTurn('done via REST')));

    // Create session via REST.
    const sessionRes = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { ...auth(apiKey), 'content-type': 'application/json' },
      payload: { agentName: agent.name },
    });
    expect(sessionRes.statusCode).toBe(201);
    const { sessionId } = sessionRes.json() as { sessionId: string };

    // Start the run — async 202.
    const runRes = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/runs`,
      headers: { ...auth(apiKey), 'content-type': 'application/json' },
      payload: { content: 'echo it' },
    });
    expect(runRes.statusCode).toBe(202);
    const { runId, status } = runRes.json() as { runId: string; status: string };
    expect(runId).toMatch(/^run_/);
    expect(status).toBe('running');

    const run = await pollRun(apiKey, runId);
    expect(run.status).toBe('completed');

    // Tool-calls endpoint reflects the executed remote tool.
    const tcRes = await app.inject({ method: 'GET', url: `/v1/runs/${runId}/tool-calls`, headers: auth(apiKey) });
    expect(tcRes.statusCode).toBe(200);
    const tcBody = tcRes.json() as { data: Array<{ toolName: string; status: string }> };
    expect(tcBody.data).toHaveLength(1);
    expect(tcBody.data[0]!.toolName).toBe('echo');
    expect(tcBody.data[0]!.status).toBe('completed');

    // Trace endpoint (finalized in the run's `finally`; retry briefly).
    let traceBody: { trace: { runId: string }; spans: unknown[] } | undefined;
    for (let i = 0; i < 50; i++) {
      const traceRes = await app.inject({ method: 'GET', url: `/v1/runs/${runId}/trace`, headers: auth(apiKey) });
      if (traceRes.statusCode === 200) {
        traceBody = traceRes.json();
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(traceBody).toBeDefined();
    expect(traceBody!.trace.runId).toBe(runId);
    expect(traceBody!.spans.length).toBeGreaterThan(0);
  });

  it('accepts idempotent cancel (202) and isolates runs cross-workspace (404)', async () => {
    // Self-contained owner workspace for the cancel/isolation checks.
    const owner = await harness.seedWorkspaceWithKey();
    const ownerAgent = await harness.seedAgent({ workspaceId: owner.workspaceId });
    harness.fake.setResponder(() => textTurn('quick'));

    const sessionRes = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { ...auth(owner.apiKey), 'content-type': 'application/json' },
      payload: { agentName: ownerAgent.name },
    });
    const { sessionId } = sessionRes.json() as { sessionId: string };

    const runRes = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/runs`,
      headers: { ...auth(owner.apiKey), 'content-type': 'application/json' },
      payload: { content: 'hello' },
    });
    const { runId } = runRes.json() as { runId: string };
    await pollRun(owner.apiKey, runId);

    // Cancel is idempotent — 202 even after the run is terminal, twice.
    for (let i = 0; i < 2; i++) {
      const cancelRes = await app.inject({ method: 'POST', url: `/v1/runs/${runId}/cancel`, headers: auth(owner.apiKey) });
      expect(cancelRes.statusCode).toBe(202);
    }

    // A different workspace cannot GET or cancel the run — 404, no existence leak.
    const other = await harness.seedWorkspaceWithKey();
    const getOther = await app.inject({ method: 'GET', url: `/v1/runs/${runId}`, headers: auth(other.apiKey) });
    expect(getOther.statusCode).toBe(404);
    const cancelOther = await app.inject({ method: 'POST', url: `/v1/runs/${runId}/cancel`, headers: auth(other.apiKey) });
    expect(cancelOther.statusCode).toBe(404);
  });
});
