import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MAX_SPAN_ERROR_MESSAGE_CHARS } from '@swiftagent/observability';
import { createRuntimeHarness, seededTool, type RuntimeHarness } from '../support/runtime-harness.js';
import { byTurn, textTurn, toolTurn } from '../support/fake-provider.js';
import { startFakeRunner, type FakeRunnerHandle } from '../support/fake-runner.js';
import type { SpanRecordRow, TraceRecordRow } from '@swiftagent/db';

/**
 * WS-29 · Observability span persistence (SC-08 / SC-11 / SC-09). Drives REAL
 * runs through the WS-25 harness against the shared migrated DB, then asserts the
 * spans the loop's tracer persisted: model/tool/error spans, failure-path trace
 * finalization on every exit path, and bounded payloads on an oversized tool
 * output. Isolation is by fresh seeded workspace/agent/session per test.
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('observability-spans (SC-08 / SC-11 / SC-09)', () => {
  let harness: RuntimeHarness;
  const runners: FakeRunnerHandle[] = [];

  beforeAll(async () => {
    harness = await createRuntimeHarness();
  });

  afterAll(async () => {
    while (runners.length) await runners.pop()!.teardown();
    await harness.teardown();
  });

  /** Poll the run row until it leaves `running`. */
  async function pollTerminal(runId: string, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const run = await harness.repos.runRepo.getById(runId);
      if (run && run.status !== 'running') return run;
      if (Date.now() > deadline) throw new Error(`Run ${runId} stuck at running`);
      await sleep(20);
    }
  }

  /** The trace is persisted in the loop's `finally`, just after the terminal
   *  status write — poll briefly for it. */
  async function waitForTrace(runId: string, timeoutMs = 5_000): Promise<TraceRecordRow> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const trace = await harness.repos.traceRepo.getTraceByRunId(runId);
      if (trace) return trace;
      if (Date.now() > deadline) throw new Error(`No trace persisted for run ${runId}`);
      await sleep(20);
    }
  }

  async function spansFor(runId: string): Promise<{ trace: TraceRecordRow; spans: SpanRecordRow[] }> {
    const trace = await waitForTrace(runId);
    const spans = await harness.repos.traceRepo.listSpansByTraceId(trace.traceId);
    return { trace, spans };
  }

  /** Seed workspace + agent (wired to a fresh real runner) + session. */
  async function seedWithRunner(toolName: string) {
    const { workspaceId } = await harness.seedWorkspaceWithKey();
    const runner = await startFakeRunner({ publicKey: harness.keys.publicKey, workspaceId });
    runners.push(runner);
    const agent = await harness.seedAgent({
      workspaceId,
      tools: [seededTool(toolName)],
      toolRunnerUrl: runner.url,
    });
    const session = await harness.seedSession(agent.agentId);
    return { workspaceId, session };
  }

  it('persists a root run_span + model_call_span + tool_call_span with correct statuses (SC-08)', async () => {
    const { session } = await seedWithRunner('echo');
    harness.fake.setResponder(byTurn(toolTurn('echo', { hi: true }), textTurn('done')));

    const runService = harness.createRunService();
    const { runId } = await runService.start({ sessionId: session.sessionId, content: 'echo it' });
    const run = await pollTerminal(runId);
    expect(run.status).toBe('completed');

    const { spans } = await spansFor(runId);

    const rootSpans = spans.filter((s) => s.type === 'run_span');
    expect(rootSpans).toHaveLength(1);
    expect(rootSpans[0]!.parentSpanId).toBeNull();
    expect(rootSpans[0]!.status).toBe('ok');

    const modelSpans = spans.filter((s) => s.type === 'model_call_span');
    expect(modelSpans.length).toBeGreaterThanOrEqual(1);
    expect(modelSpans.every((s) => s.status === 'ok')).toBe(true);

    const echoSpans = spans.filter((s) => s.type === 'tool_call_span' && s.name.includes('echo'));
    expect(echoSpans).toHaveLength(1);
    expect(echoSpans[0]!.status).toBe('ok');
  });

  it('persists a tool-error span with a bounded error when a tool throws (SC-08/SC-11)', async () => {
    const { session } = await seedWithRunner('boom');
    // Single boom turn; the loop re-calls the model each round (byTurn repeats the
    // last turn), so a maxToolIterations=1 run fires boom once then fails.
    harness.fake.setResponder(byTurn(toolTurn('boom', {})));

    const runService = harness.createRunService({ maxToolIterations: 1 });
    const { runId } = await runService.start({ sessionId: session.sessionId, content: 'boom' });
    const run = await pollTerminal(runId);
    expect(run.status).toBe('failed');

    const { spans } = await spansFor(runId);
    const boomSpan = spans.find((s) => s.type === 'tool_call_span' && s.name.includes('boom'));
    expect(boomSpan).toBeDefined();
    expect(boomSpan!.status).toBe('error');
    expect(boomSpan!.error).toBeTruthy();
    expect(boomSpan!.error!.message.length).toBeLessThanOrEqual(MAX_SPAN_ERROR_MESSAGE_CHARS);
  });

  it('persists a model-error span and fails the run when the provider throws (SC-08)', async () => {
    const { workspaceId } = await harness.seedWorkspaceWithKey();
    const agent = await harness.seedAgent({ workspaceId });
    const session = await harness.seedSession(agent.agentId);
    harness.fake.setResponder(() => ({ error: 'provider exploded' }));

    const runService = harness.createRunService();
    const { runId } = await runService.start({ sessionId: session.sessionId, content: 'go' });
    const run = await pollTerminal(runId);
    expect(run.status).toBe('failed');

    const { spans } = await spansFor(runId);
    const errored = spans.filter((s) => s.status === 'error');
    // The model_call_span (and the root run_span) are finalized `error`.
    expect(errored.some((s) => s.type === 'model_call_span')).toBe(true);
  });

  it('finalizes the trace on the failure path: root run_span ended with error status (SC-08/SC-11)', async () => {
    const { workspaceId } = await harness.seedWorkspaceWithKey();
    const agent = await harness.seedAgent({ workspaceId });
    const session = await harness.seedSession(agent.agentId);
    harness.fake.setResponder(() => ({ error: 'boom in the model' }));

    const runService = harness.createRunService();
    const { runId } = await runService.start({ sessionId: session.sessionId, content: 'fail me' });
    const run = await pollTerminal(runId);
    expect(run.status).toBe('failed');

    const { spans } = await spansFor(runId);
    const root = spans.find((s) => s.type === 'run_span');
    expect(root).toBeDefined();
    expect(root!.completedAt).not.toBeNull();
    expect(root!.durationMs).not.toBeNull();
    expect(root!.status).toBe('error');
  });

  it('bounds an oversized tool output on the persisted tool_call_span (SC-09)', async () => {
    const { session } = await seedWithRunner('big');
    harness.fake.setResponder(byTurn(toolTurn('big', {}), textTurn('recovered')));

    const runService = harness.createRunService();
    const { runId } = await runService.start({ sessionId: session.sessionId, content: 'send big' });
    await pollTerminal(runId);

    const { spans } = await spansFor(runId);
    const bigSpan = spans.find((s) => s.type === 'tool_call_span' && s.name.includes('big'));
    expect(bigSpan).toBeDefined();
    // The oversized output is rejected output-bound → a bounded error span, never
    // the full multi-MiB blob.
    expect(bigSpan!.status).toBe('error');
    expect(bigSpan!.error).toBeTruthy();
    expect(bigSpan!.error!.message.length).toBeLessThanOrEqual(MAX_SPAN_ERROR_MESSAGE_CHARS);
    expect(bigSpan!.error!.message).not.toMatch(/x{1000,}/);
  });
});
