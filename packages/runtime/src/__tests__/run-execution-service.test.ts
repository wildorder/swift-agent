import { describe, it, expect, vi } from 'vitest';
import type { AgentRecord, ChatEvent, MessageRecord, RunRecord, SessionRecord } from '@swiftagent/shared';
import { isSwiftAgentError, SwiftAgentErrorCode } from '@swiftagent/shared';
import type { ModelProvider, ModelStreamChunk } from '@swiftagent/models';
import { ProviderRegistry } from '@swiftagent/models';
import { createRunExecutionService } from '../run-execution-service.js';
import type { AgentEngineDeps } from '../types.js';
import type { ToolExecutor } from '../tool-executor.js';

const SESSION_ID = 'ses_testxxxxxxxxxxxxxxxxx';

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    agentId: 'agt_testxxxxxxxxxxxxxxxxx',
    workspaceId: 'ws_testxxxxxxxxxxxxxxxxx',
    name: 'Test Agent',
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

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: SESSION_ID,
    agentId: 'agt_testxxxxxxxxxxxxxxxxx',
    userId: null,
    status: 'active',
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

interface Stores {
  runs: RunRecord[];
  messages: MessageRecord[];
}

/** Build execution-service deps backed by in-memory run/message stores. */
function createServiceDeps(
  provider: ModelProvider,
  opts: { session?: SessionRecord | null } = {},
): { deps: AgentEngineDeps; stores: Stores } {
  const stores: Stores = { runs: [], messages: [] };
  const session = opts.session === undefined ? makeSession() : opts.session;
  const agent = makeAgent();

  const registry = new ProviderRegistry();
  registry.register('openai', () => provider, { apiKey: 'test-key' });

  const toolExecutor: ToolExecutor = { execute: vi.fn(async () => ({ ok: true as const, output: 'ok' })) };

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
        complete: vi.fn(async (runId: string) => {
          const run = stores.runs.find((r) => r.runId === runId);
          if (run) run.status = 'completed';
          return run ?? null;
        }),
        fail: vi.fn(async (runId: string) => {
          const run = stores.runs.find((r) => r.runId === runId);
          if (run) run.status = 'failed';
          return run ?? null;
        }),
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
  };

  return { deps, stores };
}

function completingProvider(text = 'Hello'): ModelProvider {
  return {
    async *generate(): AsyncGenerator<ModelStreamChunk> {
      yield { type: 'token', text };
      yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    },
  };
}

/** Provider that blocks on `gate` before finishing, to hold a run in-flight. */
function gatedProvider(gate: Promise<void>): ModelProvider {
  return {
    async *generate(): AsyncGenerator<ModelStreamChunk> {
      yield { type: 'token', text: 'partial' };
      await gate;
      yield { type: 'finish', finishReason: 'stop', usage: {} };
    },
  };
}

describe('RunExecutionService', () => {
  it('creates exactly one run + one user message and reaches terminal completed (SC-11/SC-12)', async () => {
    const { deps, stores } = createServiceDeps(completingProvider());
    const service = createRunExecutionService(deps);

    const events: ChatEvent[] = [];
    const { runId } = await service.start(
      { sessionId: SESSION_ID, content: 'Hi there' },
      { onEvent: (e) => events.push(e) },
    );

    expect(runId).toMatch(/^run_/);
    // Exactly one run row, no duplicate ids.
    expect(stores.runs).toHaveLength(1);
    expect(stores.runs[0].runId).toBe(runId);
    expect(stores.runs[0].status).toBe('completed');

    // Exactly one user message, persisted once.
    const userMessages = stores.messages.filter((m) => m.role === 'user');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].content).toBe('Hi there');

    // Assistant message persisted + terminal events streamed.
    expect(stores.messages.some((m) => m.role === 'assistant')).toBe(true);
    expect(events.some((e) => e.type === 'message_started')).toBe(true);
    expect(events.at(-1)?.type).toBe('message_completed');
  });

  it('REST-style (no onEvent) execution persists the same shape as gateway-style (SC-12 parity)', async () => {
    // Gateway-style: onEvent, awaits completion.
    const gw = createServiceDeps(completingProvider('parity'));
    const gwService = createRunExecutionService(gw.deps);
    await gwService.start({ sessionId: SESSION_ID, content: 'same' }, { onEvent: () => {} });

    // REST-style: no onEvent, fire-and-forget. Poll the run to terminal state.
    const rest = createServiceDeps(completingProvider('parity'));
    const restService = createRunExecutionService(rest.deps);
    const { runId } = await restService.start({ sessionId: SESSION_ID, content: 'same' });

    await vi.waitFor(async () => {
      const run = await rest.deps.db.runs.getById(runId);
      expect(run?.status).toBe('completed');
    });

    const shape = (s: Stores) => ({
      runs: s.runs.length,
      userMessages: s.messages.filter((m) => m.role === 'user').length,
      assistantMessages: s.messages.filter((m) => m.role === 'assistant').length,
      terminalStatus: s.runs[0]?.status,
    });

    expect(shape(rest.stores)).toEqual(shape(gw.stores));
  });

  it('shares one session lock across entry points — concurrent run conflicts', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { deps } = createServiceDeps(gatedProvider(gate));
    const service = createRunExecutionService(deps);

    // First run: REST-style, returns while execution continues (lock held).
    await service.start({ sessionId: SESSION_ID, content: 'first' });

    // Second run on the same session conflicts, regardless of entry point.
    await expect(
      service.start({ sessionId: SESSION_ID, content: 'second' }, { onEvent: () => {} }),
    ).rejects.toSatisfy((err: unknown) => isSwiftAgentError(err) && err.code === SwiftAgentErrorCode.CONFLICT);

    release();
  });

  it('releases the lock after a run completes so the next run succeeds', async () => {
    const { deps } = createServiceDeps(completingProvider());
    const service = createRunExecutionService(deps);

    await service.start({ sessionId: SESSION_ID, content: 'first' }, { onEvent: () => {} });
    // A subsequent run on the same session must not conflict.
    await expect(
      service.start({ sessionId: SESSION_ID, content: 'second' }, { onEvent: () => {} }),
    ).resolves.toMatchObject({ runId: expect.stringMatching(/^run_/) });
  });

  it('requestCancel is idempotent and aborts the in-flight run', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { deps, stores } = createServiceDeps(gatedProvider(gate));
    const service = createRunExecutionService(deps);

    const { runId } = await service.start({ sessionId: SESSION_ID, content: 'cancel me' });

    // Repeated cancels all report accepted.
    await expect(service.requestCancel(runId)).resolves.toEqual({ requested: true });
    await expect(service.requestCancel(runId)).resolves.toEqual({ requested: true });

    // The aborted run reaches a terminal state and frees the session.
    await vi.waitFor(() => {
      expect(stores.runs[0]?.status).toBe('failed');
    });
    release();

    // A cancel after terminal state is still idempotent.
    await expect(service.requestCancel(runId)).resolves.toEqual({ requested: true });
  });

  it('does not create an orphan run when the session is invalid', async () => {
    const { deps, stores } = createServiceDeps(completingProvider(), { session: null });
    const service = createRunExecutionService(deps);

    await expect(
      service.start({ sessionId: SESSION_ID, content: 'no session' }),
    ).rejects.toThrow('not found');

    expect(stores.runs).toHaveLength(0);
    expect(stores.messages).toHaveLength(0);
  });
});
