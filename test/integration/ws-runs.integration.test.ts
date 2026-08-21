import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { RunExecutionService } from '@swiftagent/runtime';
import {
  createRuntimeHarness,
  seededTool,
  type RuntimeHarness,
  type GatewayHandle,
} from '../support/runtime-harness.js';
import { byTurn, textTurn, toolTurn } from '../support/fake-provider.js';
import { startFakeRunner, type FakeRunnerHandle } from '../support/fake-runner.js';
import { connectWs } from '../support/ws-client.js';

/**
 * WS-25 · WebSocket runs (SC-16). Streaming a run over a real gateway WS, the
 * `cancel` control message, and the disconnect-≠-cancel + reconnection-replay
 * contract (a client disconnect never cancels a server-owned run).
 */
describe('ws-runs', () => {
  let harness: RuntimeHarness;
  let service: RunExecutionService;
  let gateway: GatewayHandle;
  const runners: FakeRunnerHandle[] = [];

  beforeAll(async () => {
    harness = await createRuntimeHarness();
    service = harness.createRunService();
    gateway = await harness.buildGateway(service);
  });

  afterEach(async () => {
    while (runners.length) await runners.pop()!.teardown();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  async function wsUrlFor(agentId: string, sessionId: string): Promise<string> {
    const token = await harness.signClientToken({ sessionId, agentId });
    return `${gateway.wsBaseUrl}?token=${token}`;
  }

  it('streams a full run: message_started → token → tool_call → message_completed', async () => {
    const { workspaceId } = await harness.seedWorkspaceWithKey();
    const runner = await startFakeRunner({ publicKey: harness.keys.publicKey, workspaceId });
    runners.push(runner);

    const agent = await harness.seedAgent({
      workspaceId,
      tools: [seededTool('echo')],
      toolRunnerUrl: runner.url,
    });
    const session = await harness.seedSession(agent.agentId);

    harness.fake.setResponder(byTurn(toolTurn('echo', { v: 1 }), textTurn('Hi from WS')));

    const client = await connectWs(await wsUrlFor(agent.agentId, session.sessionId));
    try {
      client.send({ type: 'send_message', content: 'stream please' });
      await client.waitForType('message_completed');

      const types = client.frames.map((f) => f.type);
      expect(types).toContain('message_started');
      expect(types).toContain('token');
      expect(types).toContain('tool_call_started');
      expect(types).toContain('tool_call_completed');
      expect(types).toContain('message_completed');
    } finally {
      await client.close();
    }
  });

  it('stops an in-flight run on a cancel message', async () => {
    const { workspaceId } = await harness.seedWorkspaceWithKey();
    const runner = await startFakeRunner({ publicKey: harness.keys.publicKey, workspaceId, slowToolDelayMs: 2_000 });
    runners.push(runner);

    const agent = await harness.seedAgent({
      workspaceId,
      tools: [seededTool('slow')],
      toolRunnerUrl: runner.url,
    });
    const session = await harness.seedSession(agent.agentId);

    harness.fake.setResponder(byTurn(toolTurn('slow', {}), textTurn('should not reach')));

    const client = await connectWs(await wsUrlFor(agent.agentId, session.sessionId));
    try {
      client.send({ type: 'send_message', content: 'run slow' });
      await client.waitForType('tool_call_started');
      client.send({ type: 'cancel' });

      // Terminal cancel is streamed as run_failed{code: CANCELLED}.
      const failed = await client.waitFor((f) => f.type === 'run_failed');
      expect(failed.code).toBe('CANCELLED');

      // Persisted terminal state matches.
      const runId = failed.runId as string;
      const run = await harness.repos.runRepo.getById(runId);
      expect(run?.status).toBe('cancelled');
    } finally {
      await client.close();
    }
  });

  it('does not cancel on disconnect and replays buffered events on reconnect', async () => {
    const { workspaceId } = await harness.seedWorkspaceWithKey();
    const agent = await harness.seedAgent({ workspaceId });
    const session = await harness.seedSession(agent.agentId);

    // A slow model turn keeps the run in-flight across the reconnect. `message_started`
    // is emitted before the model call, so it is buffered immediately.
    harness.fake.setResponder(() => ({ delayMs: 1_200, tokens: ['delivered'] }));

    const url = await wsUrlFor(agent.agentId, session.sessionId);
    const conn1 = await connectWs(url);
    let runId: string;
    try {
      conn1.send({ type: 'send_message', content: 'keep running' });
      const started = await conn1.waitForType('message_started');
      runId = started.runId as string;
    } finally {
      await conn1.close(); // disconnect — must NOT cancel the run
    }

    // Reconnect while the run is still in-flight; buffered events replay.
    const conn2 = await connectWs(url);
    try {
      const replayed = await conn2.waitForType('message_started');
      expect(replayed.runId).toBe(runId);

      await conn2.waitForType('message_completed');
    } finally {
      await conn2.close();
    }

    // The run reached `completed` — the disconnect never cancelled it.
    const run = await harness.repos.runRepo.getById(runId);
    expect(run?.status).toBe('completed');
  });
});
