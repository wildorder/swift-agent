import { describe, it, expect, vi } from 'vitest';
import type {
  AgentRecord,
  ChatEvent,
  MessageRecord,
  RunRecord,
  RunStatus,
  SessionRecord,
  ToolCallRecord,
  ToolDefinition,
} from '@swiftagent/shared';
import type { ModelProvider, ModelStreamChunk } from '@swiftagent/models';
import { ProviderRegistry } from '@swiftagent/models';
import { createRunExecutionService } from '../run-execution-service.js';
import type { AgentEngineDeps, AgentEngineOptions, Tracer } from '../types.js';
import type { ToolExecutor, ToolCallResult } from '../tool-executor.js';

const SESSION_ID = 'ses_lifecyclexxxxxxxxxxx';

const SLOW_TOOL: ToolDefinition = {
  name: 'slowTool',
  description: 'A tool used to exercise deadlines',
  inputSchema: { type: 'object', properties: {} },
};

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    agentId: 'agt_lifecyclexxxxxxxxxxx',
    workspaceId: 'ws_lifecyclexxxxxxxxxxxx',
    name: 'Lifecycle Agent',
    modelConfig: { model: 'openai/gpt-4o' },
    systemPrompt: 'You are a helpful assistant.',
    memoryConfig: { strategy: 'last_n', maxMessages: 50 },
    toolRunnerUrl: null,
    tools: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeSession(): SessionRecord {
  return {
    sessionId: SESSION_ID,
    agentId: 'agt_lifecyclexxxxxxxxxxx',
    userId: null,
    status: 'active',
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// ── Captured tracer (structurally satisfies the runtime Tracer) ──────────

function makeSpan() {
  const span = {
    ended: null as { status: 'ok' | 'error'; error?: Error } | null,
    end(status: 'ok' | 'error', error?: Error) {
      span.ended = { status, error };
      return span;
    },
    addMetadata() {
      return span;
    },
  };
  return span;
}
type CapturedSpan = ReturnType<typeof makeSpan>;

interface CapturedTrace {
  runId: string;
  modelCalls: Array<{ name: string; span: CapturedSpan }>;
  toolCalls: Array<{ name: string; callId: string; span: CapturedSpan }>;
  finished: { status: 'ok' | 'error'; error?: Error } | null;
}

function makeTracer(): { tracer: Tracer; traces: CapturedTrace[] } {
  const traces: CapturedTrace[] = [];
  const tracer: Tracer = {
    startRunTrace(runId: string) {
      const rec: CapturedTrace = { runId, modelCalls: [], toolCalls: [], finished: null };
      traces.push(rec);
      return {
        startModelCall(name: string) {
          const span = makeSpan();
          rec.modelCalls.push({ name, span });
          return span;
        },
        startToolCall(name: string, callId: string) {
          const span = makeSpan();
          rec.toolCalls.push({ name, callId, span });
          return span;
        },
        async finish(status: 'ok' | 'error', error?: Error) {
          rec.finished = { status, error };
        },
      };
    },
  };
  return { tracer, traces };
}

// ── In-memory stores with the WS-24 conditional terminal semantics ───────

interface Stores {
  runs: RunRecord[];
  toolCalls: ToolCallRecord[];
  messages: MessageRecord[];
}

function createDeps(
  provider: ModelProvider,
  opts: { agent?: AgentRecord; toolExecutor?: ToolExecutor; tracer?: Tracer } = {},
): { deps: AgentEngineDeps; stores: Stores } {
  const stores: Stores = { runs: [], toolCalls: [], messages: [] };
  const session = makeSession();
  const agent = opts.agent ?? makeAgent();

  const registry = new ProviderRegistry();
  registry.register('openai', () => provider, { apiKey: 'test-key' });

  const toolExecutor: ToolExecutor =
    opts.toolExecutor ?? { execute: vi.fn(async () => ({ ok: true as const, output: 'ok' })) };

  // Conditional run transition: only a `running` run moves to a terminal state.
  const transitionRun = (runId: string, status: RunStatus, tokenUsage?: unknown): RunRecord | null => {
    const run = stores.runs.find((r) => r.runId === runId);
    if (!run || run.status !== 'running') return null;
    run.status = status;
    if (tokenUsage !== undefined) run.tokenUsage = tokenUsage as RunRecord['tokenUsage'];
    run.updatedAt = new Date();
    return { ...run };
  };

  // Conditional tool-call transition: only a `started` call is finalized.
  const transitionTool = (callId: string, output: unknown, status: ToolCallRecord['status']): ToolCallRecord | null => {
    const tc = stores.toolCalls.find((t) => t.callId === callId);
    if (!tc || tc.status !== 'started') return null;
    tc.status = status;
    if (output !== undefined) tc.output = output;
    tc.updatedAt = new Date();
    return { ...tc };
  };

  const deps: AgentEngineDeps = {
    db: {
      messages: {
        create: vi.fn(async (record) => {
          const msg = {
            messageId: record.messageId,
            sessionId: record.sessionId,
            runId: record.runId ?? null,
            role: record.role,
            content: record.content,
            createdAt: new Date(),
          } as MessageRecord;
          stores.messages.push(msg);
          return msg;
        }),
        createBatch: vi.fn(async () => []),
        listBySession: vi.fn(async () => [...stores.messages]),
        listByRun: vi.fn(async () => []),
        getLastN: vi.fn(async (_sid: string, n: number) => stores.messages.slice(-n)),
      } as unknown as AgentEngineDeps['db']['messages'],
      runs: {
        create: vi.fn(async (record) => {
          const run: RunRecord = {
            runId: record.runId,
            sessionId: record.sessionId,
            status: 'running',
            model: record.model,
            tokenUsage: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          stores.runs.push(run);
          return run;
        }),
        getById: vi.fn(async (runId: string) => stores.runs.find((r) => r.runId === runId) ?? null),
        updateStatus: vi.fn(async () => null),
        complete: vi.fn(async (runId: string, tokenUsage: unknown) => transitionRun(runId, 'completed', tokenUsage)),
        fail: vi.fn(async (runId: string) => transitionRun(runId, 'failed')),
        cancel: vi.fn(async (runId: string) => transitionRun(runId, 'cancelled')),
        timeout: vi.fn(async (runId: string) => transitionRun(runId, 'timed_out')),
        listBySession: vi.fn(async () => []),
      } as unknown as AgentEngineDeps['db']['runs'],
      toolCalls: {
        create: vi.fn(async (record) => {
          const tc: ToolCallRecord = {
            callId: record.callId,
            runId: record.runId,
            toolName: record.toolName,
            input: record.input,
            output: null,
            status: 'started',
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          stores.toolCalls.push(tc);
          return tc;
        }),
        updateResult: vi.fn(async (callId: string, output: unknown, status: ToolCallRecord['status'] = 'completed') =>
          transitionTool(callId, output, status),
        ),
        fail: vi.fn(async (callId: string) => transitionTool(callId, undefined, 'failed')),
        listByRun: vi.fn(async (runId: string) => stores.toolCalls.filter((t) => t.runId === runId)),
      } as unknown as AgentEngineDeps['db']['toolCalls'],
      sessions: {
        create: vi.fn(async () => null),
        getById: vi.fn(async () => session),
        updateStatus: vi.fn(async () => null),
        listByAgent: vi.fn(async () => []),
        listByUser: vi.fn(async () => []),
      } as unknown as AgentEngineDeps['db']['sessions'],
      agents: {
        create: vi.fn(async () => null),
        getById: vi.fn(async () => agent),
        getByWorkspaceId: vi.fn(async () => []),
        getByName: vi.fn(async () => null),
        update: vi.fn(async () => null),
      } as unknown as AgentEngineDeps['db']['agents'],
    },
    modelRegistry: registry,
    toolExecutorResolver: { resolve: vi.fn(async () => toolExecutor) },
    tracer: opts.tracer,
  };

  return { deps, stores };
}

// ── Fake providers ──────────────────────────────────────────────────────

function completingProvider(text = 'Hello'): ModelProvider {
  return {
    async *generate(): AsyncGenerator<ModelStreamChunk> {
      yield { type: 'token', text };
      yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    },
  };
}

/** Emits a partial token then hangs until the abort signal fires (respects it). */
function hangingProvider(): ModelProvider {
  return {
    async *generate(params: { signal?: AbortSignal }): AsyncGenerator<ModelStreamChunk> {
      yield { type: 'token', text: 'partial' };
      await new Promise<void>((_resolve, reject) => {
        const signal = params.signal;
        if (signal?.aborted) {
          reject(signal.reason ?? new Error('aborted'));
          return;
        }
        signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
      });
    },
  };
}

/** Always requests one tool call per round (drives multi-round runs). */
function toolLoopProvider(toolName = SLOW_TOOL.name): ModelProvider {
  return {
    async *generate(): AsyncGenerator<ModelStreamChunk> {
      yield { type: 'tool_call', toolName, callId: 'prov_call', arguments: {} };
      yield { type: 'finish', finishReason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    },
  };
}

/** Round 1 requests a tool; round 2 throws mid-stream. */
function failOnSecondRoundProvider(): ModelProvider {
  let round = 0;
  return {
    async *generate(): AsyncGenerator<ModelStreamChunk> {
      round += 1;
      if (round === 1) {
        yield { type: 'tool_call', toolName: SLOW_TOOL.name, callId: 'prov_call', arguments: {} };
        yield { type: 'finish', finishReason: 'tool_calls', usage: {} };
        return;
      }
      yield { type: 'token', text: 'about to fail' };
      throw new Error('provider boom');
    },
  };
}

const toolAgent = () => makeAgent({ tools: [SLOW_TOOL] });

describe('run lifecycle hardening (WS-24)', () => {
  it('model deadline aborts the provider stream and persists timed_out (SC-14)', async () => {
    const { deps, stores } = createDeps(hangingProvider());
    const service = createRunExecutionService(deps, { modelTimeoutMs: 30 } satisfies AgentEngineOptions);

    const events: ChatEvent[] = [];
    await service.start({ sessionId: SESSION_ID, content: 'hang' }, { onEvent: (e) => events.push(e) });

    expect(stores.runs[0]?.status).toBe('timed_out');
    const terminal = events.at(-1);
    expect(terminal?.type).toBe('run_failed');
    expect(terminal && 'code' in terminal ? terminal.code : undefined).toBe('TIMED_OUT');
  });

  it('tool deadline fails the tool call AND times out the run (SC-14)', async () => {
    // Executor hangs until aborted — respects the (tool-deadline) signal.
    const toolExecutor: ToolExecutor = {
      execute: vi.fn(
        (_call, _ctx, signal): Promise<ToolCallResult> =>
          new Promise<ToolCallResult>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
          }),
      ),
    };
    const { deps, stores } = createDeps(toolLoopProvider(), { agent: toolAgent(), toolExecutor });
    const service = createRunExecutionService(deps, { toolTimeoutMs: 30 });

    await service.start({ sessionId: SESSION_ID, content: 'slow tool' }, { onEvent: () => {} });

    expect(stores.runs[0]?.status).toBe('timed_out');
    // No silent continuation — the hung tool call is finalized as failed.
    expect(stores.toolCalls).toHaveLength(1);
    expect(stores.toolCalls[0]?.status).toBe('failed');
  });

  it('total-run deadline times out a multi-round run (SC-14)', async () => {
    // Fast tool, but the provider always asks for another → unbounded rounds.
    const toolExecutor: ToolExecutor = {
      execute: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 15));
        return { ok: true as const, output: 'ok' };
      }),
    };
    const { deps, stores } = createDeps(toolLoopProvider(), { agent: toolAgent(), toolExecutor });
    const service = createRunExecutionService(deps, { totalRunMs: 40, maxToolIterations: 100 });

    await service.start({ sessionId: SESSION_ID, content: 'loop' }, { onEvent: () => {} });

    expect(stores.runs[0]?.status).toBe('timed_out');
  });

  it('provider failure mid-stream finalizes run + tool call + trace (SC-15)', async () => {
    const toolExecutor: ToolExecutor = {
      execute: vi.fn(async () => ({ ok: false as const, error: 'handler boom' })),
    };
    const { tracer, traces } = makeTracer();
    const { deps, stores } = createDeps(failOnSecondRoundProvider(), {
      agent: toolAgent(),
      toolExecutor,
      tracer,
    });
    const service = createRunExecutionService(deps);

    const events: ChatEvent[] = [];
    await service.start({ sessionId: SESSION_ID, content: 'boom' }, { onEvent: (e) => events.push(e) });

    expect(stores.runs[0]?.status).toBe('failed');
    // The round-1 tool call was finalized failed (not left dangling in started).
    expect(stores.toolCalls[0]?.status).toBe('failed');

    // Trace persisted with an error outcome and at least one error span.
    const trace = traces[0];
    expect(trace?.finished?.status).toBe('error');
    const anyErrorSpan =
      trace!.modelCalls.some((m) => m.span.ended?.status === 'error') ||
      trace!.toolCalls.some((t) => t.span.ended?.status === 'error');
    expect(anyErrorSpan).toBe(true);

    const terminal = events.at(-1);
    expect(terminal?.type).toBe('run_failed');
    expect(terminal && 'code' in terminal ? terminal.code : undefined).toBe('INTERNAL');
  });

  it('cancel mid-tool finalizes the tool call failed and the run cancelled (SC-15)', async () => {
    let started!: () => void;
    const toolStarted = new Promise<void>((r) => { started = r; });
    const toolExecutor: ToolExecutor = {
      execute: vi.fn(
        (_call, _ctx, signal): Promise<ToolCallResult> =>
          new Promise<ToolCallResult>((_resolve, reject) => {
            started();
            signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
          }),
      ),
    };
    const { tracer, traces } = makeTracer();
    const { deps, stores } = createDeps(toolLoopProvider(), { agent: toolAgent(), toolExecutor, tracer });
    const service = createRunExecutionService(deps);

    const { runId } = await service.start({ sessionId: SESSION_ID, content: 'cancel me' });
    await toolStarted;
    await service.requestCancel(runId);

    await vi.waitFor(() => {
      expect(stores.runs[0]?.status).toBe('cancelled');
    });
    expect(stores.toolCalls[0]?.status).toBe('failed');
    expect(traces[0]?.finished?.status).toBe('error');
  });

  it('idempotent cancel wins; a late completion cannot flip a cancelled run (SC-13)', async () => {
    const { deps, stores } = createDeps(hangingProvider());
    const service = createRunExecutionService(deps);

    const { runId } = await service.start({ sessionId: SESSION_ID, content: 'cancel' });

    await expect(service.requestCancel(runId)).resolves.toEqual({ requested: true });
    await expect(service.requestCancel(runId)).resolves.toEqual({ requested: true });

    await vi.waitFor(() => {
      expect(stores.runs[0]?.status).toBe('cancelled');
    });

    // A late provider/runner completion must be a no-op against a terminal run.
    const flipped = await deps.db.runs.complete(runId, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect(flipped).toBeNull();
    expect(stores.runs[0]?.status).toBe('cancelled');
  });

  it('wires the tracer into a successful run: root/model spans + ok finish (SC-15)', async () => {
    const { tracer, traces } = makeTracer();
    const { deps, stores } = createDeps(completingProvider(), { tracer });
    const service = createRunExecutionService(deps);

    await service.start({ sessionId: SESSION_ID, content: 'trace me' }, { onEvent: () => {} });

    expect(stores.runs[0]?.status).toBe('completed');
    const trace = traces[0];
    expect(trace).toBeDefined();
    expect(trace!.modelCalls.length).toBeGreaterThanOrEqual(1);
    expect(trace!.modelCalls[0]?.span.ended?.status).toBe('ok');
    expect(trace!.finished?.status).toBe('ok');
  });
});
