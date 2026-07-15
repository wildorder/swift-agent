import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { RunExecutionService } from '@swiftagent/runtime';
import {
  createRuntimeHarness,
  seededTool,
  type RuntimeHarness,
} from '../support/runtime-harness.js';
import { byTurn, textTurn, toolTurn } from '../support/fake-provider.js';
import { startFakeRunner, type FakeRunnerHandle } from '../support/fake-runner.js';

/**
 * WS-25 · Executor routing (SC-07, end to end). Two agents point at two distinct
 * real runners; interleaved runs must each hit ONLY their own runner. Each runner
 * counts invocations, so a cross-routed call would show up as an imbalance.
 */
describe('executor-routing', () => {
  let harness: RuntimeHarness;
  let service: RunExecutionService;
  const runners: FakeRunnerHandle[] = [];

  beforeAll(async () => {
    harness = await createRuntimeHarness();
    service = harness.createRunService();
  });

  afterAll(async () => {
    while (runners.length) await runners.pop()!.teardown();
    await harness.teardown();
  });

  it('never cross-routes tool calls between two agents / two runners', async () => {
    const { workspaceId } = await harness.seedWorkspaceWithKey();

    const runnerA = await startFakeRunner({ publicKey: harness.keys.publicKey, workspaceId });
    const runnerB = await startFakeRunner({ publicKey: harness.keys.publicKey, workspaceId });
    runners.push(runnerA, runnerB);

    const agentA = await harness.seedAgent({
      workspaceId,
      name: `agent-a-${workspaceId}`,
      tools: [seededTool('counter')],
      toolRunnerUrl: runnerA.url,
    });
    const agentB = await harness.seedAgent({
      workspaceId,
      name: `agent-b-${workspaceId}`,
      tools: [seededTool('counter')],
      toolRunnerUrl: runnerB.url,
    });

    const sessionA = await harness.seedSession(agentA.agentId);
    const sessionB = await harness.seedSession(agentB.agentId);

    // Both agents run the identical script: call `counter` once, then answer.
    harness.fake.setResponder(byTurn(toolTurn('counter', {}), textTurn('done')));

    // Interleave the two runs.
    const [resA, resB] = await Promise.all([
      service.start({ sessionId: sessionA.sessionId, content: 'go A' }, { onEvent: () => {} }),
      service.start({ sessionId: sessionB.sessionId, content: 'go B' }, { onEvent: () => {} }),
    ]);

    const runA = await harness.repos.runRepo.getById(resA.runId);
    const runB = await harness.repos.runRepo.getById(resB.runId);
    expect(runA?.status).toBe('completed');
    expect(runB?.status).toBe('completed');

    // Each runner was invoked exactly once — by its own agent, never the other's.
    expect(runnerA.counter.value).toBe(1);
    expect(runnerB.counter.value).toBe(1);

    const callsA = await harness.repos.toolCallRepo.listByRun(resA.runId);
    const callsB = await harness.repos.toolCallRepo.listByRun(resB.runId);
    expect(callsA).toHaveLength(1);
    expect(callsB).toHaveLength(1);
    expect(callsA[0]!.status).toBe('completed');
    expect(callsB[0]!.status).toBe('completed');
  });
});
