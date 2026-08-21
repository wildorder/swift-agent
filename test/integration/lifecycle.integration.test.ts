import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { RunRecord } from '@swiftagent/shared';
import {
  createRuntimeHarness,
  seededTool,
  type RuntimeHarness,
} from '../support/runtime-harness.js';
import { byTurn, textTurn, toolTurn } from '../support/fake-provider.js';
import { startFakeRunner, type FakeRunnerHandle } from '../support/fake-runner.js';

/**
 * WS-25 · Lifecycle hardening (SC-13 cancellation + race safety, SC-14
 * model/tool/total timeouts, SC-15 failure finalization). Terminal-state
 * transitions are conditional (`WHERE status='running'`), so whichever cause
 * fires first wins and a late completion can never overwrite it.
 */
describe('lifecycle', () => {
  let harness: RuntimeHarness;
  const runners: FakeRunnerHandle[] = [];

  beforeAll(async () => {
    harness = await createRuntimeHarness();
  });

  afterEach(async () => {
    while (runners.length) await runners.pop()!.teardown();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  async function waitForTerminal(runId: string, timeoutMs = 15_000): Promise<RunRecord> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const run = await harness.repos.runRepo.getById(runId);
      if (run && run.status !== 'running') return run;
      if (Date.now() > deadline) {
        throw new Error(`Run ${runId} did not reach a terminal state (last: ${run?.status})`);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it('cancels an in-flight run → terminal cancelled, tool call finalized (SC-13)', async () => {
    const { workspaceId } = await harness.seedWorkspaceWithKey();
    const runner = await startFakeRunner({ publicKey: harness.keys.publicKey, workspaceId, slowToolDelayMs: 1_000 });
    runners.push(runner);

    const agent = await harness.seedAgent({
      workspaceId,
      tools: [seededTool('slow')],
      toolRunnerUrl: runner.url,
    });
    const session = await harness.seedSession(agent.agentId);

    const service = harness.createRunService();
    harness.fake.setResponder(byTurn(toolTurn('slow', {}), textTurn('should not reach')));

    // Cancel as soon as the tool call starts; start() resolves at terminal state.
    const { runId } = await service.start(
      { sessionId: session.sessionId, content: 'run slow' },
      {
        onEvent: (e) => {
          if (e.type === 'tool_call_started') void service.requestCancel(e.runId);
        },
      },
    );

    const run = await harness.repos.runRepo.getById(runId);
    expect(run?.status).toBe('cancelled');

    // No tool call is left dangling in `started`.
    const calls = await harness.repos.toolCallRepo.listByRun(runId);
    expect(calls.every((c) => c.status !== 'started')).toBe(true);

    // A late re-read never flips the terminal state.
    await new Promise((r) => setTimeout(r, 200));
    const again = await harness.repos.runRepo.getById(runId);
    expect(again?.status).toBe('cancelled');
  });

  it('times out a hanging model call → timed_out (SC-14)', async () => {
    const { workspaceId } = await harness.seedWorkspaceWithKey();
    const agent = await harness.seedAgent({ workspaceId });
    const session = await harness.seedSession(agent.agentId);

    const service = harness.createRunService({ modelTimeoutMs: 150 });
    harness.fake.setResponder(() => ({ delayMs: 5_000, tokens: ['too late'] }));

    const { runId } = await service.start(
      { sessionId: session.sessionId, content: 'hang the model' },
      { onEvent: () => {} },
    );

    const run = await harness.repos.runRepo.getById(runId);
    expect(run?.status).toBe('timed_out');
  });

  it('times out a hanging tool call → tool failed + run timed_out (SC-14)', async () => {
    const { workspaceId } = await harness.seedWorkspaceWithKey();
    const runner = await startFakeRunner({ publicKey: harness.keys.publicKey, workspaceId, slowToolDelayMs: 3_000 });
    runners.push(runner);

    const agent = await harness.seedAgent({
      workspaceId,
      tools: [seededTool('slow')],
      toolRunnerUrl: runner.url,
    });
    const session = await harness.seedSession(agent.agentId);

    const service = harness.createRunService({ toolTimeoutMs: 150 });
    harness.fake.setResponder(() => toolTurn('slow', {}));

    const { runId } = await service.start(
      { sessionId: session.sessionId, content: 'hang the tool' },
      { onEvent: () => {} },
    );

    const run = await harness.repos.runRepo.getById(runId);
    expect(run?.status).toBe('timed_out');

    const calls = await harness.repos.toolCallRepo.listByRun(runId);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.status).toBe('failed');
  });

  it('enforces the total-run deadline → timed_out (SC-14)', async () => {
    const { workspaceId } = await harness.seedWorkspaceWithKey();
    const agent = await harness.seedAgent({ workspaceId });
    const session = await harness.seedSession(agent.agentId);

    const service = harness.createRunService({ totalRunMs: 150 });
    harness.fake.setResponder(() => ({ delayMs: 5_000, tokens: ['too late'] }));

    const { runId } = await service.start(
      { sessionId: session.sessionId, content: 'exceed total' },
      { onEvent: () => {} },
    );

    const run = await harness.repos.runRepo.getById(runId);
    expect(run?.status).toBe('timed_out');
  });

  it('finalizes run + tool call + trace on failure (SC-15)', async () => {
    const { workspaceId } = await harness.seedWorkspaceWithKey();
    const runner = await startFakeRunner({ publicKey: harness.keys.publicKey, workspaceId });
    runners.push(runner);

    const agent = await harness.seedAgent({
      workspaceId,
      tools: [seededTool('boom')],
      toolRunnerUrl: runner.url,
    });
    const session = await harness.seedSession(agent.agentId);

    const service = harness.createRunService();
    // Turn 0: the `boom` tool throws on the runner. Turn 1: the model errors.
    harness.fake.setResponder(byTurn(toolTurn('boom', {}), { error: 'model gave up' }));

    const { runId } = await service.start(
      { sessionId: session.sessionId, content: 'break it' },
      { onEvent: () => {} },
    );

    const run = await harness.repos.runRepo.getById(runId);
    expect(run?.status).toBe('failed');

    const calls = await harness.repos.toolCallRepo.listByRun(runId);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.status).toBe('failed');

    // The trace is persisted and finalized for the failed run.
    const trace = await harness.repos.traceRepo.getTraceByRunId(runId);
    expect(trace).not.toBeNull();
    const spans = await harness.repos.traceRepo.listSpansByTraceId(trace!.traceId);
    expect(spans.length).toBeGreaterThan(0);
  });

  it('resolves a cancel/completion race to exactly one terminal state (SC-13)', async () => {
    const { workspaceId } = await harness.seedWorkspaceWithKey();
    const agent = await harness.seedAgent({ workspaceId });
    const session = await harness.seedSession(agent.agentId);

    const service = harness.createRunService();
    harness.fake.setResponder(() => textTurn('quick answer'));

    // Fire-and-forget start, then race a cancel against the fast completion.
    const { runId } = await service.start({ sessionId: session.sessionId, content: 'go fast' });
    await service.requestCancel(runId);

    const terminal = await waitForTerminal(runId);
    // Exactly one terminal state — either outcome is valid, but never both/neither.
    expect(['completed', 'cancelled']).toContain(terminal.status);

    // Stable: re-reading yields the same terminal state (no late overwrite).
    const again = await harness.repos.runRepo.getById(runId);
    expect(again?.status).toBe(terminal.status);
  });
});
