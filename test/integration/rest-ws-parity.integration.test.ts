import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RunExecutionService } from '@swiftagent/runtime';
import {
  createRuntimeHarness,
  type RuntimeHarness,
  type GatewayHandle,
} from '../support/runtime-harness.js';
import { textTurn } from '../support/fake-provider.js';
import { connectWs } from '../support/ws-client.js';

/**
 * WS-25 · REST ↔ WS parity + shared session lock (SC-12). Identical content
 * through each entry point of the SAME composed stack yields the same persisted
 * shape (one run, one user + one assistant message, equivalent terminal status),
 * and a run in-flight on one entry point conflicts a concurrent run on the other.
 */
describe('rest-ws-parity', () => {
  let harness: RuntimeHarness;
  let service: RunExecutionService;
  let app: FastifyInstance;
  let gateway: GatewayHandle;

  beforeAll(async () => {
    harness = await createRuntimeHarness();
    // One execution service shared by REST + WS — one session lock, one registry.
    service = harness.createRunService();
    const restCtx = await harness.buildRestApp(service);
    app = restCtx.app;
    gateway = await harness.buildGateway(service);
  });

  afterAll(async () => {
    await harness.teardown();
  });

  function auth(apiKey: string): { authorization: string } {
    return { authorization: `Bearer ${apiKey}` };
  }

  async function pollRun(apiKey: string, runId: string): Promise<string> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const res = await app.inject({ method: 'GET', url: `/v1/runs/${runId}`, headers: auth(apiKey) });
      const body = res.json();
      if (body.status !== 'running') return body.status as string;
      if (Date.now() > deadline) throw new Error('run stuck');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it('produces identical persistence for the same content via REST and WS', async () => {
    const { workspaceId, apiKey } = await harness.seedWorkspaceWithKey();
    const agent = await harness.seedAgent({ workspaceId });
    const restSession = await harness.seedSession(agent.agentId);
    const wsSession = await harness.seedSession(agent.agentId);

    const content = 'Identical parity content';
    harness.fake.setResponder(() => textTurn('Same answer.'));

    // ── REST path ──
    const restRun = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${restSession.sessionId}/runs`,
      headers: { ...auth(apiKey), 'content-type': 'application/json' },
      payload: { content },
    });
    expect(restRun.statusCode).toBe(202);
    const { runId: restRunId } = restRun.json() as { runId: string };
    expect(await pollRun(apiKey, restRunId)).toBe('completed');

    // ── WS path ──
    const token = await harness.signClientToken({ sessionId: wsSession.sessionId, agentId: agent.agentId });
    const client = await connectWs(`${gateway.wsBaseUrl}?token=${token}`);
    try {
      client.send({ type: 'send_message', content });
      await client.waitForType('message_completed');
    } finally {
      await client.close();
    }

    // ── Compare persisted shape ──
    const restRuns = await harness.repos.runRepo.listBySession(restSession.sessionId);
    const wsRuns = await harness.repos.runRepo.listBySession(wsSession.sessionId);
    expect(restRuns).toHaveLength(1);
    expect(wsRuns).toHaveLength(1);
    expect(restRuns[0]!.status).toBe(wsRuns[0]!.status);
    expect(wsRuns[0]!.status).toBe('completed');

    const restMsgs = await harness.repos.messageRepo.listBySession(restSession.sessionId);
    const wsMsgs = await harness.repos.messageRepo.listBySession(wsSession.sessionId);
    const shape = (ms: typeof restMsgs): Array<{ role: string; content: string }> =>
      ms.map((m) => ({ role: m.role, content: m.content }));
    expect(shape(restMsgs)).toEqual([
      { role: 'user', content },
      { role: 'assistant', content: 'Same answer.' },
    ]);
    expect(shape(wsMsgs)).toEqual(shape(restMsgs));
  });

  it('shares the session lock across REST and WS (concurrent run → conflict)', async () => {
    const { workspaceId, apiKey } = await harness.seedWorkspaceWithKey();
    const agent = await harness.seedAgent({ workspaceId });
    const session = await harness.seedSession(agent.agentId);

    // A slow model turn keeps the WS-started run in-flight while REST tries again.
    harness.fake.setResponder(() => ({ delayMs: 1_500, tokens: ['eventually'] }));

    const token = await harness.signClientToken({ sessionId: session.sessionId, agentId: agent.agentId });
    const client = await connectWs(`${gateway.wsBaseUrl}?token=${token}`);
    try {
      client.send({ type: 'send_message', content: 'start on ws' });
      await client.waitForType('message_started'); // run is now in-flight

      // REST run on the SAME session must conflict on the shared lock.
      const conflict = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${session.sessionId}/runs`,
        headers: { ...auth(apiKey), 'content-type': 'application/json' },
        payload: { content: 'race from rest' },
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().error.code).toBe('CONFLICT');

      // Let the WS run finish cleanly.
      await client.waitForType('message_completed');
    } finally {
      await client.close();
    }
  });
});
