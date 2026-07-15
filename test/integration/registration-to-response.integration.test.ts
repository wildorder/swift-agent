import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { ChatEvent } from '@swiftagent/shared';
import type { RunExecutionService } from '@swiftagent/runtime';
import {
  createRuntimeHarness,
  seededTool,
  type RuntimeHarness,
} from '../support/runtime-harness.js';
import { byTurn, textTurn, toolTurn } from '../support/fake-provider.js';
import { startFakeRunner, type FakeRunnerHandle } from '../support/fake-runner.js';

/**
 * WS-25 · Registration → response (SC-06, SC-16).
 * No-tool run, single remote-tool run, and multi-tool-turn run against the real
 * runtime, real persistence, and a real SDK tool runner over HTTP.
 */
describe('registration-to-response', () => {
  let harness: RuntimeHarness;
  let service: RunExecutionService;
  const runners: FakeRunnerHandle[] = [];

  beforeAll(async () => {
    harness = await createRuntimeHarness();
    service = harness.createRunService();
  });

  afterEach(async () => {
    while (runners.length) await runners.pop()!.teardown();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  /** Start a run and, because `onEvent` is supplied, await its terminal state. */
  async function runToTerminal(sessionId: string, content: string): Promise<{ runId: string; events: ChatEvent[] }> {
    const events: ChatEvent[] = [];
    const { runId } = await service.start({ sessionId, content }, { onEvent: (e) => events.push(e) });
    return { runId, events };
  }

  it('completes a no-tool run with a single assistant message', async () => {
    const { workspaceId } = await harness.seedWorkspaceWithKey();
    const agent = await harness.seedAgent({ workspaceId });
    const session = await harness.seedSession(agent.agentId);

    harness.fake.setResponder(() => textTurn('Hello there.'));

    const { runId, events } = await runToTerminal(session.sessionId, 'Hi');

    const run = await harness.repos.runRepo.getById(runId);
    expect(run?.status).toBe('completed');

    const messages = await harness.repos.messageRepo.listBySession(session.sessionId);
    const assistants = messages.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.content).toBe('Hello there.');

    expect(events.map((e) => e.type)).toContain('message_completed');
  });

  it('executes a single remote tool and completes (SC-06)', async () => {
    const { workspaceId } = await harness.seedWorkspaceWithKey();
    const runner = await startFakeRunner({ publicKey: harness.keys.publicKey, workspaceId });
    runners.push(runner);

    const agent = await harness.seedAgent({
      workspaceId,
      tools: [seededTool('echo')],
      toolRunnerUrl: runner.url,
    });
    const session = await harness.seedSession(agent.agentId);

    harness.fake.setResponder(byTurn(toolTurn('echo', { value: 'hi' }), textTurn('Echoed.')));

    const { runId } = await runToTerminal(session.sessionId, 'please echo');

    const run = await harness.repos.runRepo.getById(runId);
    expect(run?.status).toBe('completed');

    const toolCalls = await harness.repos.toolCallRepo.listByRun(runId);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.callId).toMatch(/^tc_/);
    expect(toolCalls[0]!.toolName).toBe('echo');
    expect(toolCalls[0]!.status).toBe('completed');
    // The real runner returned `{ echoed: <input> }` over HTTP.
    expect(toolCalls[0]!.output).toEqual({ echoed: { value: 'hi' } });

    const messages = await harness.repos.messageRepo.listBySession(session.sessionId);
    const finalAssistant = messages.filter((m) => m.role === 'assistant').at(-1);
    expect(finalAssistant?.content).toBe('Echoed.');

    // SC-03: the loop forwarded the registered tool to the model on the tool turn.
    const sawEchoTool = harness.fake.requests.some((r) => r.tools?.some((t) => t.name === 'echo'));
    expect(sawEchoTool).toBe(true);
  });

  it('runs multiple tool turns with correct iteration accounting', async () => {
    const { workspaceId } = await harness.seedWorkspaceWithKey();
    const runner = await startFakeRunner({ publicKey: harness.keys.publicKey, workspaceId });
    runners.push(runner);

    const agent = await harness.seedAgent({
      workspaceId,
      tools: [seededTool('echo'), seededTool('counter')],
      toolRunnerUrl: runner.url,
    });
    const session = await harness.seedSession(agent.agentId);

    harness.fake.setResponder(
      byTurn(toolTurn('echo', { a: 1 }), toolTurn('counter', {}), textTurn('All done.')),
    );

    const { runId } = await runToTerminal(session.sessionId, 'do two things');

    const run = await harness.repos.runRepo.getById(runId);
    expect(run?.status).toBe('completed');

    const toolCalls = await harness.repos.toolCallRepo.listByRun(runId);
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls.map((c) => c.toolName)).toEqual(['echo', 'counter']);
    expect(toolCalls.every((c) => c.status === 'completed')).toBe(true);
    // The counter tool executed exactly once on the runner across the run.
    expect(runner.counter.value).toBe(1);

    const messages = await harness.repos.messageRepo.listBySession(session.sessionId);
    // Two assistant tool-call messages (one per model round) + the final answer.
    const assistants = messages.filter((m) => m.role === 'assistant');
    expect(assistants.at(-1)!.content).toBe('All done.');
    expect(assistants.length).toBe(3);
  });
});
