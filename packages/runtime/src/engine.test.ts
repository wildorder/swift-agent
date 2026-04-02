import { describe, it, expect, vi } from 'vitest';
import type { AgentRecord, MessageRecord, ChatEvent, SessionRecord } from '@swiftagent/shared';
import type { ModelProvider, ModelStreamChunk } from '@swiftagent/models';
import { ProviderRegistry } from '@swiftagent/models';
import { AgentEngine } from './engine.js';
import { SessionLock } from './session-lock.js';
import { ContextBuilder } from './context-builder.js';
import { LastNMemoryStrategy } from './memory/last-n.js';
import { SummaryMemoryStrategy } from './memory/summary.js';
import { createMemoryStrategy } from './memory/strategy.js';
import { runAgentLoop } from './loop.js';
import type { AgentEngineDeps } from './types.js';
import type { ToolExecutor, ToolCallResult } from './tool-executor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    agentId: 'agt_testxxxxxxxxxxxxxxxxx',
    workspaceId: 'ws_testxxxxxxxxxxxxxxxxx',
    name: 'Test Agent',
    modelConfig: { model: 'openai/gpt-4o' },
    systemPrompt: 'You are a helpful assistant.',
    memoryConfig: { strategy: 'last_n', maxMessages: 50 },
    toolRunnerUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: 'ses_testxxxxxxxxxxxxxxxxx',
    agentId: 'agt_testxxxxxxxxxxxxxxxxx',
    userId: null,
    status: 'active',
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeMessage(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    messageId: 'msg_testxxxxxxxxxxxxxxxxx',
    sessionId: 'ses_testxxxxxxxxxxxxxxxxx',
    runId: null,
    role: 'user',
    content: 'hello',
    createdAt: new Date(),
    ...overrides,
  };
}

/** Creates a mock model provider that yields the given chunks */
function mockProvider(chunks: ModelStreamChunk[]): ModelProvider {
  return {
    async *generate() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

/** Creates a mock model provider that yields different chunks per call */
function mockProviderSequence(callChunks: ModelStreamChunk[][]): ModelProvider {
  let callIndex = 0;
  return {
    async *generate() {
      const idx = Math.min(callIndex, callChunks.length - 1);
      const chunks = callChunks[idx] ?? [];
      callIndex++;
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

function createMockDeps(overrides?: {
  provider?: ModelProvider;
  toolExecutor?: ToolExecutor;
  session?: SessionRecord | null;
  agent?: AgentRecord | null;
}): AgentEngineDeps {
  const messages: MessageRecord[] = [];
  const provider = overrides?.provider ?? mockProvider([
    { type: 'token', text: 'Hello' },
    { type: 'token', text: ' world' },
    { type: 'finish', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
  ]);

  const registry = new ProviderRegistry();
  registry.register('openai', () => provider, { apiKey: 'test-key' });

  const session = overrides?.session !== undefined ? overrides.session : makeSession();
  const agent = overrides?.agent !== undefined ? overrides.agent : makeAgent();

  return {
    db: {
      messages: {
        create: vi.fn(async (record) => {
          const msg = makeMessage({ ...record, createdAt: new Date() });
          messages.push(msg);
          return msg;
        }),
        createBatch: vi.fn(async (records) => {
          return records.map((r: Partial<MessageRecord>) => makeMessage({ ...r, createdAt: new Date() }));
        }),
        listBySession: vi.fn(async () => [...messages]),
        listByRun: vi.fn(async () => []),
        getLastN: vi.fn(async (_sid: string, n: number) => messages.slice(-n)),
      },
      runs: {
        create: vi.fn(async (record) => ({
          ...record,
          status: 'running' as const,
          tokenUsage: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
        getById: vi.fn(async () => null),
        updateStatus: vi.fn(async () => null),
        complete: vi.fn(async (runId: string, tokenUsage: { inputTokens: number; outputTokens: number; totalTokens: number }) => ({
          runId,
          sessionId: 'ses_testxxxxxxxxxxxxxxxxx',
          status: 'completed' as const,
          model: 'openai/gpt-4o',
          tokenUsage,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
        fail: vi.fn(async (runId: string) => ({
          runId,
          sessionId: 'ses_testxxxxxxxxxxxxxxxxx',
          status: 'failed' as const,
          model: 'openai/gpt-4o',
          tokenUsage: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
        listBySession: vi.fn(async () => []),
      },
      toolCalls: {
        create: vi.fn(async (record) => ({
          ...record,
          output: null,
          status: 'started' as const,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
        updateResult: vi.fn(async (_callId: string, _output: unknown, _status?: string) => null),
        fail: vi.fn(async () => null),
        listByRun: vi.fn(async () => []),
      },
      sessions: {
        create: vi.fn(async () => session as SessionRecord),
        getById: vi.fn(async () => session),
        updateStatus: vi.fn(async () => session),
        listByAgent: vi.fn(async () => []),
        listByUser: vi.fn(async () => []),
      },
      agents: {
        create: vi.fn(async () => agent as AgentRecord),
        getById: vi.fn(async () => agent),
        getByWorkspaceId: vi.fn(async () => []),
        getByName: vi.fn(async () => null),
        update: vi.fn(async () => null),
      },
    },
    modelRegistry: registry,
    toolExecutor: overrides?.toolExecutor ?? {
      execute: vi.fn(async () => ({ ok: true, output: 'done' }) as ToolCallResult),
    },
  };
}

async function collectEvents(gen: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LastNMemoryStrategy', () => {
  it('returns all messages when under limit', () => {
    const strategy = new LastNMemoryStrategy({ maxMessages: 10 });
    const messages = Array.from({ length: 5 }, (_, i) =>
      makeMessage({ messageId: `msg_${String(i).padStart(21, '0')}`, role: 'user', content: `msg ${i}` }),
    );
    const result = strategy.trim(messages);
    expect(result).toHaveLength(5);
  });

  it('trims to last N messages', () => {
    const strategy = new LastNMemoryStrategy({ maxMessages: 10 });
    const messages = Array.from({ length: 100 }, (_, i) =>
      makeMessage({ messageId: `msg_${String(i).padStart(21, '0')}`, role: i % 2 === 0 ? 'user' : 'assistant', content: `msg ${i}` }),
    );
    const result = strategy.trim(messages);
    expect(result).toHaveLength(10);
    expect(result[0]).toHaveProperty('content', 'msg 90');
    expect(result[9]).toHaveProperty('content', 'msg 99');
  });

  it('excludes system messages from count', () => {
    const strategy = new LastNMemoryStrategy({ maxMessages: 3 });
    const messages = [
      makeMessage({ messageId: 'msg_000000000000000000001', role: 'system', content: 'system' }),
      makeMessage({ messageId: 'msg_000000000000000000002', role: 'user', content: 'u1' }),
      makeMessage({ messageId: 'msg_000000000000000000003', role: 'assistant', content: 'a1' }),
      makeMessage({ messageId: 'msg_000000000000000000004', role: 'user', content: 'u2' }),
      makeMessage({ messageId: 'msg_000000000000000000005', role: 'assistant', content: 'a2' }),
    ];
    const result = strategy.trim(messages);
    expect(result).toHaveLength(3);
    expect(result.some((m) => m.role === 'system')).toBe(false);
    expect(result[0]).toHaveProperty('content', 'a1');
  });

  it('uses default of 50 when no maxMessages provided', () => {
    const strategy = new LastNMemoryStrategy();
    const messages = Array.from({ length: 60 }, (_, i) =>
      makeMessage({ messageId: `msg_${String(i).padStart(21, '0')}`, role: 'user', content: `msg ${i}` }),
    );
    const result = strategy.trim(messages);
    expect(result).toHaveLength(50);
  });
});

describe('SummaryMemoryStrategy', () => {
  it('passes through unchanged with warning', () => {
    const strategy = new SummaryMemoryStrategy();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const messages = [
      makeMessage({ messageId: 'msg_000000000000000000001', role: 'user', content: 'hi' }),
      makeMessage({ messageId: 'msg_000000000000000000002', role: 'assistant', content: 'hello' }),
    ];
    const result = strategy.trim(messages);
    expect(result).toEqual(messages);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Summary memory strategy is not yet implemented'),
    );
    warnSpy.mockRestore();
  });
});

describe('createMemoryStrategy', () => {
  it('creates last_n strategy', () => {
    const strategy = createMemoryStrategy('last_n', { lastN: 20 });
    expect(strategy).toBeInstanceOf(LastNMemoryStrategy);
  });

  it('creates summary strategy', () => {
    const strategy = createMemoryStrategy('summary');
    expect(strategy).toBeInstanceOf(SummaryMemoryStrategy);
  });
});

describe('ContextBuilder', () => {
  it('injects system prompt first', () => {
    const agent = makeAgent({ systemPrompt: 'Be helpful' });
    const memory = new LastNMemoryStrategy({ maxMessages: 50 });
    const builder = new ContextBuilder(agent, memory);

    const history = [
      makeMessage({ messageId: 'msg_000000000000000000001', role: 'user', content: 'hi' }),
    ];

    const result = builder.build(history);
    expect(result[0]).toEqual({ role: 'system', content: 'Be helpful' });
    expect(result[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('skips system prompt when empty', () => {
    const agent = makeAgent({ systemPrompt: '' });
    const memory = new LastNMemoryStrategy({ maxMessages: 50 });
    const builder = new ContextBuilder(agent, memory);

    const result = builder.build([
      makeMessage({ messageId: 'msg_000000000000000000001', role: 'user', content: 'hi' }),
    ]);
    expect(result[0]).toHaveProperty('role', 'user');
  });

  it('maps tool messages with toolCallId', () => {
    const agent = makeAgent();
    const memory = new LastNMemoryStrategy({ maxMessages: 50 });
    const builder = new ContextBuilder(agent, memory);

    const toolContent = JSON.stringify({ toolCallId: 'tc_abc', result: '42' });
    const history = [
      makeMessage({ messageId: 'msg_000000000000000000001', role: 'tool', content: toolContent }),
    ];

    const result = builder.build(history);
    const toolMsg = result.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg).toHaveProperty('toolCallId', 'tc_abc');
    expect(toolMsg).toHaveProperty('content', '42');
  });

  it('maps assistant messages with tool calls', () => {
    const agent = makeAgent();
    const memory = new LastNMemoryStrategy({ maxMessages: 50 });
    const builder = new ContextBuilder(agent, memory);

    const assistantContent = JSON.stringify({
      text: 'Let me look that up',
      toolCalls: [{ callId: 'tc_123', toolName: 'search', arguments: { q: 'test' } }],
    });

    const result = builder.build([
      makeMessage({ messageId: 'msg_000000000000000000001', role: 'assistant', content: assistantContent }),
    ]);

    const assistantMsg = result.find((m) => m.role === 'assistant');
    expect(assistantMsg).toHaveProperty('content', 'Let me look that up');
    expect(assistantMsg?.toolCalls).toHaveLength(1);
    expect(assistantMsg?.toolCalls?.[0]).toHaveProperty('toolName', 'search');
  });

  it('preserves ordering after trim', () => {
    const agent = makeAgent();
    const memory = new LastNMemoryStrategy({ maxMessages: 3 });
    const builder = new ContextBuilder(agent, memory);

    const history = Array.from({ length: 6 }, (_, i) =>
      makeMessage({
        messageId: `msg_${String(i).padStart(21, '0')}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `msg ${i}`,
        createdAt: new Date(Date.now() + i * 1000),
      }),
    );

    const result = builder.build(history);
    // system + 3 trimmed messages
    expect(result).toHaveLength(4);
    expect(result[1]).toHaveProperty('content', 'msg 3');
    expect(result[2]).toHaveProperty('content', 'msg 4');
    expect(result[3]).toHaveProperty('content', 'msg 5');
  });
});

describe('SessionLock', () => {
  it('acquires and releases lock', () => {
    const lock = new SessionLock();
    lock.acquire('ses_1', 'run_1');
    expect(lock.isActive('ses_1')).toBe(true);
    lock.release('ses_1', 'run_1');
    expect(lock.isActive('ses_1')).toBe(false);
  });

  it('rejects concurrent run on same session', () => {
    const lock = new SessionLock();
    lock.acquire('ses_1', 'run_1');
    expect(() => lock.acquire('ses_1', 'run_2')).toThrow('already has an active run');
  });

  it('release is idempotent for mismatched runId', () => {
    const lock = new SessionLock();
    lock.acquire('ses_1', 'run_1');
    lock.release('ses_1', 'run_wrong');
    expect(lock.isActive('ses_1')).toBe(true);
  });

  it('allows concurrent runs on different sessions', () => {
    const lock = new SessionLock();
    lock.acquire('ses_1', 'run_1');
    lock.acquire('ses_2', 'run_2');
    expect(lock.isActive('ses_1')).toBe(true);
    expect(lock.isActive('ses_2')).toBe(true);
  });

  it('allows new run after release', () => {
    const lock = new SessionLock();
    lock.acquire('ses_1', 'run_1');
    lock.release('ses_1', 'run_1');
    lock.acquire('ses_1', 'run_2');
    expect(lock.isActive('ses_1')).toBe(true);
  });
});

describe('runAgentLoop', () => {
  it('happy path — no tool calls', async () => {
    const deps = createMockDeps();
    const ctx = {
      sessionId: 'ses_testxxxxxxxxxxxxxxxxx',
      runId: 'run_testxxxxxxxxxxxxxxxxx',
      agentConfig: makeAgent(),
      abortSignal: new AbortController().signal,
      iterationCount: 0,
    };

    const events = await collectEvents(runAgentLoop(ctx, deps, 'Hello'));

    expect(events[0]).toHaveProperty('type', 'message_started');
    const tokenEvents = events.filter((e) => e.type === 'token');
    expect(tokenEvents).toHaveLength(2);
    expect(events.at(-1)).toHaveProperty('type', 'message_completed');

    expect(deps.db.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user', content: 'Hello' }),
    );
    expect(deps.db.runs.create).toHaveBeenCalled();
    expect(deps.db.runs.complete).toHaveBeenCalled();
    expect(deps.db.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'assistant', content: 'Hello world' }),
    );
  });

  it('single tool round-trip', async () => {
    const provider = mockProviderSequence([
      [
        { type: 'token', text: 'Let me check' },
        { type: 'tool_call', toolName: 'lookup', callId: 'tc_001xxxxxxxxxxxxxxxxxxxx', arguments: { id: 1 } },
        { type: 'finish', finishReason: 'tool_calls', usage: { inputTokens: 10, outputTokens: 5 } },
      ],
      [
        { type: 'token', text: 'The answer is 42' },
        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } },
      ],
    ]);

    const toolExecutor: ToolExecutor = {
      execute: vi.fn(async () => ({ ok: true as const, output: { value: 42 } })),
    };

    const deps = createMockDeps({ provider, toolExecutor });
    const ctx = {
      sessionId: 'ses_testxxxxxxxxxxxxxxxxx',
      runId: 'run_testxxxxxxxxxxxxxxxxx',
      agentConfig: makeAgent(),
      abortSignal: new AbortController().signal,
      iterationCount: 0,
    };

    const events = await collectEvents(runAgentLoop(ctx, deps, 'What is the answer?'));

    const types = events.map((e) => e.type);
    expect(types).toContain('message_started');
    expect(types).toContain('tool_call_started');
    expect(types).toContain('tool_call_completed');
    expect(types).toContain('token');
    expect(types).toContain('message_completed');

    expect(deps.db.toolCalls.create).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'lookup', callId: 'tc_001xxxxxxxxxxxxxxxxxxxx' }),
    );
    expect(toolExecutor.execute).toHaveBeenCalled();
    expect(deps.db.toolCalls.updateResult).toHaveBeenCalledWith(
      'tc_001xxxxxxxxxxxxxxxxxxxx',
      { value: 42 },
      'completed',
    );
  });

  it('multiple sequential tools across iterations', async () => {
    const provider = mockProviderSequence([
      [
        { type: 'tool_call', toolName: 'step1', callId: 'tc_step1xxxxxxxxxxxxxxxxxx', arguments: {} },
        { type: 'finish', finishReason: 'tool_calls', usage: {} },
      ],
      [
        { type: 'tool_call', toolName: 'step2', callId: 'tc_step2xxxxxxxxxxxxxxxxxx', arguments: {} },
        { type: 'finish', finishReason: 'tool_calls', usage: {} },
      ],
      [
        { type: 'token', text: 'Done!' },
        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 30, outputTokens: 5, totalTokens: 35 } },
      ],
    ]);

    const deps = createMockDeps({ provider });
    const ctx = {
      sessionId: 'ses_testxxxxxxxxxxxxxxxxx',
      runId: 'run_testxxxxxxxxxxxxxxxxx',
      agentConfig: makeAgent(),
      abortSignal: new AbortController().signal,
      iterationCount: 0,
    };

    const events = await collectEvents(runAgentLoop(ctx, deps, 'Do both steps'));

    const toolStarted = events.filter((e) => e.type === 'tool_call_started');
    const toolCompleted = events.filter((e) => e.type === 'tool_call_completed');
    expect(toolStarted).toHaveLength(2);
    expect(toolCompleted).toHaveLength(2);
    expect(events.at(-1)).toHaveProperty('type', 'message_completed');

    expect(deps.db.toolCalls.create).toHaveBeenCalledTimes(2);
  });

  it('tool failure — run continues with failed status', async () => {
    const provider = mockProviderSequence([
      [
        { type: 'tool_call', toolName: 'bad_tool', callId: 'tc_failxxxxxxxxxxxxxxxxxx', arguments: {} },
        { type: 'finish', finishReason: 'tool_calls', usage: {} },
      ],
      [
        { type: 'token', text: 'Tool failed, sorry' },
        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
      ],
    ]);

    const toolExecutor: ToolExecutor = {
      execute: vi.fn(async () => ({ ok: false as const, error: 'Not found' })),
    };

    const deps = createMockDeps({ provider, toolExecutor });
    const ctx = {
      sessionId: 'ses_testxxxxxxxxxxxxxxxxx',
      runId: 'run_testxxxxxxxxxxxxxxxxx',
      agentConfig: makeAgent(),
      abortSignal: new AbortController().signal,
      iterationCount: 0,
    };

    const events = await collectEvents(runAgentLoop(ctx, deps, 'Try the bad tool'));

    const toolCompleted = events.find((e) => e.type === 'tool_call_completed');
    expect(toolCompleted).toBeDefined();
    expect(toolCompleted).toHaveProperty('status', 'failed');

    expect(deps.db.toolCalls.updateResult).toHaveBeenCalledWith(
      'tc_failxxxxxxxxxxxxxxxxxx',
      'Not found',
      'failed',
    );

    // Run still completes (model continues after tool failure)
    expect(events.at(-1)).toHaveProperty('type', 'message_completed');
  });

  it('max iterations — loop stops with run_failed', async () => {
    const provider: ModelProvider = {
      async *generate() {
        yield { type: 'tool_call' as const, toolName: 'infinite', callId: `tc_inf${String(Math.random()).slice(2, 23)}`, arguments: {} };
        yield { type: 'finish' as const, finishReason: 'tool_calls', usage: {} };
      },
    };

    const deps = createMockDeps({ provider });
    const ctx = {
      sessionId: 'ses_testxxxxxxxxxxxxxxxxx',
      runId: 'run_testxxxxxxxxxxxxxxxxx',
      agentConfig: makeAgent(),
      abortSignal: new AbortController().signal,
      iterationCount: 0,
    };

    const events = await collectEvents(
      runAgentLoop(ctx, deps, 'Loop forever', { maxToolIterations: 3 }),
    );

    const lastEvent = events.at(-1);
    expect(lastEvent).toHaveProperty('type', 'run_failed');
    expect(lastEvent).toHaveProperty('code', 'MAX_ITERATIONS');
    expect(deps.db.runs.fail).toHaveBeenCalled();
  });

  it('cancellation — abort signal mid-stream', async () => {
    const controller = new AbortController();

    const provider: ModelProvider = {
      async *generate() {
        yield { type: 'token' as const, text: 'Part 1' };
        // Abort mid-stream
        controller.abort();
        yield { type: 'token' as const, text: 'Part 2' };
        yield { type: 'finish' as const, finishReason: 'stop', usage: {} };
      },
    };

    const deps = createMockDeps({ provider });
    const ctx = {
      sessionId: 'ses_testxxxxxxxxxxxxxxxxx',
      runId: 'run_testxxxxxxxxxxxxxxxxx',
      agentConfig: makeAgent(),
      abortSignal: controller.signal,
      iterationCount: 0,
    };

    const events = await collectEvents(runAgentLoop(ctx, deps, 'Cancel me'));

    const lastEvent = events.at(-1);
    expect(lastEvent).toHaveProperty('type', 'run_failed');
    expect(lastEvent).toHaveProperty('code', 'CANCELLED');
    expect(deps.db.runs.fail).toHaveBeenCalled();
  });
});

describe('AgentEngine', () => {
  it('happy path — full run through engine', async () => {
    const deps = createMockDeps();
    const engine = new AgentEngine(deps);

    const events = await collectEvents(
      engine.run('ses_testxxxxxxxxxxxxxxxxx', 'Hello'),
    );

    expect(events[0]).toHaveProperty('type', 'message_started');
    expect(events.at(-1)).toHaveProperty('type', 'message_completed');
  });

  it('session not found — throws NOT_FOUND', async () => {
    const deps = createMockDeps({ session: null });
    const engine = new AgentEngine(deps);

    await expect(
      collectEvents(engine.run('ses_nonexistent0000000000', 'Hello')),
    ).rejects.toThrow('not found');
  });

  it('closed session — throws VALIDATION', async () => {
    const deps = createMockDeps({
      session: makeSession({ status: 'closed' }),
    });
    const engine = new AgentEngine(deps);

    await expect(
      collectEvents(engine.run('ses_testxxxxxxxxxxxxxxxxx', 'Hello')),
    ).rejects.toThrow('not active');
  });

  it('concurrent rejection — second run throws CONFLICT', async () => {
    const provider: ModelProvider = {
      async *generate() {
        await new Promise((r) => setTimeout(r, 100));
        yield { type: 'token' as const, text: 'hi' };
        yield { type: 'finish' as const, finishReason: 'stop', usage: {} };
      },
    };

    const deps = createMockDeps({ provider });
    const engine = new AgentEngine(deps);

    const gen1 = engine.run('ses_testxxxxxxxxxxxxxxxxx', 'First');
    await gen1.next();

    await expect(
      collectEvents(engine.run('ses_testxxxxxxxxxxxxxxxxx', 'Second')),
    ).rejects.toThrow('already has an active run');

    await gen1.return(undefined);
  });

  it('release on success — subsequent run succeeds', async () => {
    const deps = createMockDeps();
    const engine = new AgentEngine(deps);

    await collectEvents(engine.run('ses_testxxxxxxxxxxxxxxxxx', 'First'));
    const events = await collectEvents(
      engine.run('ses_testxxxxxxxxxxxxxxxxx', 'Second'),
    );
    expect(events.at(-1)).toHaveProperty('type', 'message_completed');
  });

  it('release on failure — lock freed after error', async () => {
    const failProvider: ModelProvider = {
      // eslint-disable-next-line require-yield
      async *generate(): AsyncGenerator<ModelStreamChunk, void, undefined> {
        throw new Error('Model exploded');
      },
    };

    const deps = createMockDeps({ provider: failProvider });
    const engine = new AgentEngine(deps);

    const events1 = await collectEvents(
      engine.run('ses_testxxxxxxxxxxxxxxxxx', 'Explode'),
    );
    expect(events1.at(-1)).toHaveProperty('type', 'run_failed');

    const goodProvider = mockProvider([
      { type: 'token', text: 'ok' },
      { type: 'finish', finishReason: 'stop', usage: {} },
    ]);
    const goodRegistry = new ProviderRegistry();
    goodRegistry.register('openai', () => goodProvider, { apiKey: 'test-key' });
    (deps as { modelRegistry: ProviderRegistry }).modelRegistry = goodRegistry;

    const events2 = await collectEvents(
      engine.run('ses_testxxxxxxxxxxxxxxxxx', 'Try again'),
    );
    expect(events2.at(-1)).toHaveProperty('type', 'message_completed');
  });

  it('cross-session independence — concurrent runs on different sessions', async () => {
    const session1 = makeSession({ sessionId: 'ses_session1xxxxxxxxxxxxx' });
    const session2 = makeSession({ sessionId: 'ses_session2xxxxxxxxxxxxx' });

    const provider = mockProvider([
      { type: 'token', text: 'hello' },
      { type: 'finish', finishReason: 'stop', usage: {} },
    ]);

    const deps = createMockDeps({ provider });
    (deps.db.sessions.getById as ReturnType<typeof vi.fn>).mockImplementation(
      async (id: string) => {
        if (id === session1.sessionId) return session1;
        if (id === session2.sessionId) return session2;
        return null;
      },
    );

    const engine = new AgentEngine(deps);

    const [events1, events2] = await Promise.all([
      collectEvents(engine.run('ses_session1xxxxxxxxxxxxx', 'Hi from 1')),
      collectEvents(engine.run('ses_session2xxxxxxxxxxxxx', 'Hi from 2')),
    ]);

    expect(events1.at(-1)).toHaveProperty('type', 'message_completed');
    expect(events2.at(-1)).toHaveProperty('type', 'message_completed');
  });
});
