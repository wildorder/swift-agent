import { describe, it, expect, vi, afterEach } from 'vitest';
import type {
  AgentRecord,
  ChatEvent,
  MessageRecord,
  RunRecord,
  RunStatus,
  SessionRecord,
} from '@swiftagent/shared';
import type { ModelProvider, ModelStreamChunk } from '@swiftagent/models';
import { ProviderRegistry } from '@swiftagent/models';
import { createRunExecutionService } from '../run-execution-service.js';
import type { AgentEngineDeps, Logger, Tracer } from '../types.js';
import type { ToolExecutor } from '../tool-executor.js';

const SESSION_ID = 'ses_metricsfinalizexxxxx';
const TRACE_ID = 'tr_metricsfinalize12345';

function makeAgent(): AgentRecord {
  return {
    agentId: 'agt_metricsfinalizexxxxx',
    workspaceId: 'ws_metricsfinalizexxxxxx',
    name: 'Metrics Agent',
    modelConfig: { model: 'openai/gpt-4o' },
    systemPrompt: 'You are a helpful assistant.',
    memoryConfig: { strategy: 'last_n', maxMessages: 50 },
    toolRunnerUrl: null,
    tools: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeSession(): SessionRecord {
  return {
    sessionId: SESSION_ID,
    agentId: 'agt_metricsfinalizexxxxx',
    userId: null,
    status: 'active',
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// ── Spy span/tracer capturing addMetadata + a controllable finish ────────

function makeSpan() {
  const metadata: Record<string, unknown> = {};
  const span = {
    metadata,
    ended: null as { status: 'ok' | 'error'; error?: Error } | null,
    end(status: 'ok' | 'error', error?: Error) {
      span.ended = { status, error };
      return span;
    },
    addMetadata(partial: Record<string, unknown>) {
      Object.assign(metadata, partial);
      return span;
    },
  };
  return span;
}
type CapturedSpan = ReturnType<typeof makeSpan>;

interface CapturedTrace {
  runId: string;
  modelSpans: CapturedSpan[];
  finished: { status: 'ok' | 'error'; error?: Error } | null;
}

function makeTracer(opts: { finishRejects?: boolean } = {}): {
  tracer: Tracer;
  traces: CapturedTrace[];
} {
  const traces: CapturedTrace[] = [];
  const tracer: Tracer = {
    startRunTrace(runId: string) {
      const rec: CapturedTrace = { runId, modelSpans: [], finished: null };
      traces.push(rec);
      return {
        traceId: TRACE_ID,
        startModelCall() {
          const span = makeSpan();
          rec.modelSpans.push(span);
          return span;
        },
        startToolCall() {
          return makeSpan();
        },
        async finish(status: 'ok' | 'error', error?: Error) {
          if (opts.finishRejects) {
            throw new Error('sink write failed');
          }
          rec.finished = { status, error };
        },
      };
    },
  };
  return { tracer, traces };
}

// ── In-memory deps (conditional terminal semantics) ──────────────────────

interface Stores {
  runs: RunRecord[];
  messages: MessageRecord[];
}

function createDeps(
  provider: ModelProvider,
  opts: { tracer?: Tracer; logger?: Logger } = {},
): { deps: AgentEngineDeps; stores: Stores; completeSpy: ReturnType<typeof vi.fn> } {
  const stores: Stores = { runs: [], messages: [] };
  const session = makeSession();
  const agent = makeAgent();

  const registry = new ProviderRegistry();
  registry.register('openai', () => provider, { apiKey: 'test-key' });

  const toolExecutor: ToolExecutor = { execute: vi.fn(async () => ({ ok: true as const, output: 'ok' })) };

  const transitionRun = (runId: string, status: RunStatus, tokenUsage?: unknown): RunRecord | null => {
    const run = stores.runs.find((r) => r.runId === runId);
    if (!run || run.status !== 'running') return null;
    run.status = status;
    if (tokenUsage !== undefined) run.tokenUsage = tokenUsage as RunRecord['tokenUsage'];
    run.updatedAt = new Date();
    return { ...run };
  };

  const completeSpy = vi.fn(async (runId: string, tokenUsage: unknown) =>
    transitionRun(runId, 'completed', tokenUsage),
  );

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
        complete: completeSpy,
        fail: vi.fn(async (runId: string) => transitionRun(runId, 'failed')),
        cancel: vi.fn(async (runId: string) => transitionRun(runId, 'cancelled')),
        timeout: vi.fn(async (runId: string) => transitionRun(runId, 'timed_out')),
        listBySession: vi.fn(async () => []),
      } as unknown as AgentEngineDeps['db']['runs'],
      toolCalls: {
        create: vi.fn(async () => null),
        updateResult: vi.fn(async () => null),
        fail: vi.fn(async () => null),
        listByRun: vi.fn(async () => []),
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
    logger: opts.logger,
  };

  return { deps, stores, completeSpy };
}

function completingProvider(): ModelProvider {
  return {
    async *generate(): AsyncGenerator<ModelStreamChunk> {
      yield { type: 'token', text: 'Hello' };
      yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } };
    },
  };
}

describe('loop metrics + finalize (WS-28)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes token metadata onto the model span AND persists runs.complete with the same usage (SC-08)', async () => {
    const { tracer, traces } = makeTracer();
    const { deps, stores, completeSpy } = createDeps(completingProvider(), { tracer });
    const service = createRunExecutionService(deps);

    await service.start({ sessionId: SESSION_ID, content: 'metrics' }, { onEvent: () => {} });

    expect(stores.runs[0]?.status).toBe('completed');

    // The model span received span-derived token metadata.
    const modelSpan = traces[0]?.modelSpans[0];
    expect(modelSpan?.metadata).toMatchObject({ promptTokens: 100, completionTokens: 50 });

    // The run row's authoritative token_usage was still written.
    expect(completeSpy).toHaveBeenCalledWith(expect.any(String), {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });
  });

  it('logs a failing trace.finish via deps.logger without throwing or masking the terminal outcome (SC-09)', async () => {
    const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { tracer } = makeTracer({ finishRejects: true });
    const { deps, stores } = createDeps(completingProvider(), { tracer, logger });
    const service = createRunExecutionService(deps);

    const events: ChatEvent[] = [];
    await expect(
      service.start({ sessionId: SESSION_ID, content: 'boom' }, { onEvent: (e) => events.push(e) }),
    ).resolves.toBeDefined();

    // Terminal outcome not masked by the failed finalize.
    expect(stores.runs[0]?.status).toBe('completed');
    expect(events.at(-1)?.type).toBe('message_completed');

    expect(logger.warn).toHaveBeenCalledWith(
      'trace persistence failed',
      expect.objectContaining({ runId: expect.any(String), traceId: TRACE_ID }),
    );
  });

  it('falls back to console.warn when no logger is wired (SC-09)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { tracer } = makeTracer({ finishRejects: true });
    const { deps, stores } = createDeps(completingProvider(), { tracer });
    const service = createRunExecutionService(deps);

    await service.start({ sessionId: SESSION_ID, content: 'boom' }, { onEvent: () => {} });

    expect(stores.runs[0]?.status).toBe('completed');
    expect(warnSpy).toHaveBeenCalledWith(
      'trace persistence failed',
      expect.objectContaining({ runId: expect.any(String), traceId: TRACE_ID }),
    );
  });
});
