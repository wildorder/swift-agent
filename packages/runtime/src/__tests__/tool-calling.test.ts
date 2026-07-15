import { describe, it, expect, vi } from 'vitest';
import type { AgentRecord, MessageRecord } from '@swiftagent/shared';
import type { ModelProvider, ModelRequest, ModelStreamChunk } from '@swiftagent/models';
import { ProviderRegistry } from '@swiftagent/models';
import { runAgentLoop } from '../loop.js';
import { toModelToolSchemas, buildToolIndex } from '../tool-mapping.js';
import { validateToolCall } from '../tool-validation.js';
import type { AgentEngineDeps, RunContext } from '../types.js';
import type { ToolExecutor } from '../tool-executor.js';
import type { ChatEvent } from '@swiftagent/shared';

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
    tools: [],
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

/** Provider that yields a preset chunk sequence per call and records requests. */
function recordingProvider(callChunks: ModelStreamChunk[][]): {
  provider: ModelProvider;
  requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  let callIndex = 0;
  const provider: ModelProvider = {
    async *generate(request: ModelRequest) {
      requests.push(request);
      const idx = Math.min(callIndex, callChunks.length - 1);
      const chunks = callChunks[idx] ?? [];
      callIndex++;
      for (const chunk of chunks) yield chunk;
    },
  };
  return { provider, requests };
}

type MockDeps = AgentEngineDeps & { _messages: MessageRecord[] };

function createMockDeps(provider: ModelProvider, toolExecutor?: ToolExecutor): MockDeps {
  const messages: MessageRecord[] = [];
  const registry = new ProviderRegistry();
  registry.register('openai', () => provider, { apiKey: 'test-key' });

  const deps: MockDeps = {
    _messages: messages,
    db: {
      messages: {
        create: vi.fn(async (record: Partial<MessageRecord>) => {
          const msg = makeMessage({ ...record, createdAt: new Date() });
          messages.push(msg);
          return msg;
        }),
        createBatch: vi.fn(async () => []),
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
        complete: vi.fn(async () => null),
        fail: vi.fn(async () => null),
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
        updateResult: vi.fn(async () => null),
        fail: vi.fn(async () => null),
        listByRun: vi.fn(async () => []),
      },
      sessions: {
        create: vi.fn(async () => null),
        getById: vi.fn(async () => null),
        updateStatus: vi.fn(async () => null),
        listByAgent: vi.fn(async () => []),
        listByUser: vi.fn(async () => []),
      },
      agents: {
        create: vi.fn(async () => null),
        getById: vi.fn(async () => null),
        getByWorkspaceId: vi.fn(async () => []),
        getByName: vi.fn(async () => null),
        update: vi.fn(async () => null),
      },
    } as unknown as AgentEngineDeps['db'],
    modelRegistry: registry,
    // WS-21: the loop reads the executor from ctx (see makeCtx), not from deps.
    // This resolver only satisfies the deps type; runAgentLoop never calls it.
    toolExecutorResolver: {
      resolve: () =>
        toolExecutor ?? {
          execute: vi.fn(async () => ({ ok: true as const, output: { value: 42 } })),
        },
    },
  };
  return deps;
}

function makeCtx(agentConfig: AgentRecord, toolExecutor?: ToolExecutor): RunContext {
  return {
    sessionId: 'ses_testxxxxxxxxxxxxxxxxx',
    runId: 'run_testxxxxxxxxxxxxxxxxx',
    agentConfig,
    abortSignal: new AbortController().signal,
    iterationCount: 0,
    toolExecutor: toolExecutor ?? {
      execute: vi.fn(async () => ({ ok: true as const, output: { value: 42 } })),
    },
  };
}

async function collectEvents(gen: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

const FINISH_TOOLS: ModelStreamChunk = { type: 'finish', finishReason: 'tool_calls', usage: {} };
const FINISH_STOP: ModelStreamChunk = {
  type: 'finish',
  finishReason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};

// ---------------------------------------------------------------------------
// tool-mapping
// ---------------------------------------------------------------------------

describe('toModelToolSchemas', () => {
  it('maps ToolDefinition[] → ToolSchema[]', () => {
    const result = toModelToolSchemas([
      { name: 'search', description: 'Search things', inputSchema: { type: 'object' } },
    ]);
    expect(result).toEqual([
      { name: 'search', description: 'Search things', parameters: { type: 'object' } },
    ]);
  });

  it('returns an empty array for no tools', () => {
    expect(toModelToolSchemas([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validateToolCall
// ---------------------------------------------------------------------------

describe('validateToolCall', () => {
  const index = buildToolIndex([
    {
      name: 'lookup',
      description: 'Look up by id',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'number' } },
        required: ['id'],
      },
    },
  ]);

  it('rejects an unregistered tool with UNKNOWN_TOOL', () => {
    const res = validateToolCall(index, 'not_a_tool', { id: 1 });
    expect(res.ok).toBe(false);
    expect(res).toHaveProperty('code', 'UNKNOWN_TOOL');
  });

  it('rejects invalid arguments with INVALID_ARGUMENTS', () => {
    const res = validateToolCall(index, 'lookup', {});
    expect(res.ok).toBe(false);
    expect(res).toHaveProperty('code', 'INVALID_ARGUMENTS');
  });

  it('accepts valid arguments', () => {
    const res = validateToolCall(index, 'lookup', { id: 7 });
    expect(res).toEqual({ ok: true });
  });

  it('validates nested/enum schemas (OpenAPI-style)', () => {
    const nested = buildToolIndex([
      {
        name: 'complex',
        description: 'Complex input',
        inputSchema: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['a', 'b'] },
            items: { type: 'array', items: { type: 'number' } },
          },
          required: ['mode'],
        },
      },
    ]);
    expect(validateToolCall(nested, 'complex', { mode: 'a', items: [1, 2] })).toEqual({ ok: true });
    expect(validateToolCall(nested, 'complex', { mode: 'z' })).toHaveProperty('code', 'INVALID_ARGUMENTS');
  });
});

describe('buildToolIndex', () => {
  it('rejects calls to a tool whose schema fails to compile', () => {
    // `type: 'nonsense'` is not a valid JSON-schema type → compile error.
    const index = buildToolIndex([
      { name: 'broken', description: 'Broken schema', inputSchema: { type: 'nonsense' } },
    ]);
    const res = validateToolCall(index, 'broken', { anything: true });
    expect(res.ok).toBe(false);
    expect(res).toHaveProperty('code', 'INVALID_ARGUMENTS');
  });
});

// ---------------------------------------------------------------------------
// Loop — tool passing (SC-03)
// ---------------------------------------------------------------------------

describe('runAgentLoop — tool passing (SC-03)', () => {
  it('passes registered tools to the provider on the model turn', async () => {
    const { provider, requests } = recordingProvider([[{ type: 'token', text: 'hi' }, FINISH_STOP]]);
    const deps = createMockDeps(provider);
    const agent = makeAgent({
      tools: [
        { name: 'alpha', description: 'A', inputSchema: { type: 'object' } },
        { name: 'beta', description: 'B', inputSchema: { type: 'object' } },
      ],
    });

    await collectEvents(runAgentLoop(makeCtx(agent), deps, 'go'));

    expect(requests).toHaveLength(1);
    expect(requests[0].tools).toEqual([
      { name: 'alpha', description: 'A', parameters: { type: 'object' } },
      { name: 'beta', description: 'B', parameters: { type: 'object' } },
    ]);
  });

  it('sends tools: undefined for a tool-less agent', async () => {
    const { provider, requests } = recordingProvider([[{ type: 'token', text: 'hi' }, FINISH_STOP]]);
    const deps = createMockDeps(provider);

    await collectEvents(runAgentLoop(makeCtx(makeAgent({ tools: [] })), deps, 'go'));

    expect(requests[0].tools).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Loop — allowlist + argument validation (SC-04)
// ---------------------------------------------------------------------------

describe('runAgentLoop — validation (SC-04)', () => {
  it('rejects an unregistered tool without calling the executor', async () => {
    const { provider } = recordingProvider([
      [{ type: 'tool_call', toolName: 'ghost', callId: 'call_x', arguments: {} }, FINISH_TOOLS],
      [{ type: 'token', text: 'recovered' }, FINISH_STOP],
    ]);
    const execute = vi.fn(async () => ({ ok: true as const, output: 'x' }));
    const deps = createMockDeps(provider, { execute });

    // Agent registers a DIFFERENT tool, so `ghost` is not on the allowlist.
    const agent = makeAgent({ tools: [{ name: 'real', description: 'R', inputSchema: { type: 'object' } }] });
    const events = await collectEvents(runAgentLoop(makeCtx(agent, { execute }), deps, 'go'));

    expect(execute).not.toHaveBeenCalled();
    const completed = events.find((e) => e.type === 'tool_call_completed');
    expect(completed).toHaveProperty('status', 'failed');
    // A failed ToolCall was still persisted (observable).
    expect(deps.db.toolCalls.create).toHaveBeenCalled();
    expect(deps.db.toolCalls.updateResult).toHaveBeenCalledWith(
      expect.stringMatching(/^tc_/),
      expect.stringContaining('UNKNOWN_TOOL'),
      'failed',
    );
  });

  it('rejects invalid arguments before execution', async () => {
    const { provider } = recordingProvider([
      [{ type: 'tool_call', toolName: 'lookup', callId: 'call_y', arguments: {} }, FINISH_TOOLS],
      [{ type: 'token', text: 'recovered' }, FINISH_STOP],
    ]);
    const execute = vi.fn(async () => ({ ok: true as const, output: 'x' }));
    const deps = createMockDeps(provider, { execute });

    const agent = makeAgent({
      tools: [
        {
          name: 'lookup',
          description: 'Look up',
          inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
        },
      ],
    });
    const events = await collectEvents(runAgentLoop(makeCtx(agent, { execute }), deps, 'go'));

    expect(execute).not.toHaveBeenCalled();
    const completed = events.find((e) => e.type === 'tool_call_completed');
    expect(completed).toHaveProperty('status', 'failed');
    expect(deps.db.toolCalls.updateResult).toHaveBeenCalledWith(
      expect.stringMatching(/^tc_/),
      expect.stringContaining('INVALID_ARGUMENTS'),
      'failed',
    );
  });

  it('executes a valid call exactly once', async () => {
    const { provider } = recordingProvider([
      [{ type: 'tool_call', toolName: 'lookup', callId: 'call_z', arguments: { id: 5 } }, FINISH_TOOLS],
      [{ type: 'token', text: 'done' }, FINISH_STOP],
    ]);
    const execute = vi.fn(async () => ({ ok: true as const, output: { value: 99 } }));
    const deps = createMockDeps(provider, { execute });

    const agent = makeAgent({
      tools: [
        {
          name: 'lookup',
          description: 'Look up',
          inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
        },
      ],
    });
    await collectEvents(runAgentLoop(makeCtx(agent, { execute }), deps, 'go'));

    expect(execute).toHaveBeenCalledTimes(1);
    const created = (deps.db.toolCalls.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(created.callId).toMatch(/^tc_/);
    expect(created.toolName).toBe('lookup');
  });
});

// ---------------------------------------------------------------------------
// Loop — id separation + correlation persistence (SC-05)
// ---------------------------------------------------------------------------

describe('runAgentLoop — id separation (SC-05)', () => {
  it('persists a tc_ id while retaining the provider id and tool name', async () => {
    const { provider } = recordingProvider([
      [{ type: 'tool_call', toolName: 'lookup', callId: 'call_abc', arguments: { id: 1 } }, FINISH_TOOLS],
      [{ type: 'token', text: 'done' }, FINISH_STOP],
    ]);
    const deps = createMockDeps(provider, {
      execute: vi.fn(async () => ({ ok: true as const, output: { ok: true } })),
    });
    const agent = makeAgent({ tools: [{ name: 'lookup', description: 'L', inputSchema: { type: 'object' } }] });

    const events = await collectEvents(runAgentLoop(makeCtx(agent), deps, 'go'));

    // Persisted ToolCall uses a tc_ id, not the provider id.
    const created = (deps.db.toolCalls.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(created.callId).toMatch(/^tc_/);
    expect(created.callId).not.toBe('call_abc');

    // Events use the tc_ id.
    const started = events.find((e) => e.type === 'tool_call_started') as Extract<ChatEvent, { type: 'tool_call_started' }>;
    expect(started.callId).toBe(created.callId);

    // The persisted tool-result message carries providerCallId + toolName.
    const toolMsg = deps._messages.find((m) => m.role === 'tool');
    if (!toolMsg) throw new Error('expected a persisted tool message');
    const parsed = JSON.parse(toolMsg.content) as { swiftCallId: string; providerCallId: string; toolName: string };
    expect(parsed.providerCallId).toBe('call_abc');
    expect(parsed.toolName).toBe('lookup');
    expect(parsed.swiftCallId).toBe(created.callId);
  });

  it('gives rejected calls a tc_ id and uses it in events (id before validation)', async () => {
    const { provider } = recordingProvider([
      [{ type: 'tool_call', toolName: 'ghost', callId: 'call_bad', arguments: {} }, FINISH_TOOLS],
      [{ type: 'token', text: 'recovered' }, FINISH_STOP],
    ]);
    const deps = createMockDeps(provider);
    const agent = makeAgent({ tools: [{ name: 'real', description: 'R', inputSchema: { type: 'object' } }] });

    const events = await collectEvents(runAgentLoop(makeCtx(agent), deps, 'go'));

    const created = (deps.db.toolCalls.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(created.callId).toMatch(/^tc_/);
    const started = events.find((e) => e.type === 'tool_call_started') as Extract<ChatEvent, { type: 'tool_call_started' }>;
    const completed = events.find((e) => e.type === 'tool_call_completed') as Extract<ChatEvent, { type: 'tool_call_completed' }>;
    expect(started.callId).toBe(created.callId);
    expect(completed.callId).toBe(created.callId);
    expect(completed.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// Loop — iteration accounting
// ---------------------------------------------------------------------------

describe('runAgentLoop — iteration accounting', () => {
  it('counts a three-tool turn as a single iteration', async () => {
    const { provider } = recordingProvider([
      [
        { type: 'tool_call', toolName: 't', callId: 'c1', arguments: {} },
        { type: 'tool_call', toolName: 't', callId: 'c2', arguments: {} },
        { type: 'tool_call', toolName: 't', callId: 'c3', arguments: {} },
        FINISH_TOOLS,
      ],
      [{ type: 'token', text: 'done' }, FINISH_STOP],
    ]);
    const deps = createMockDeps(provider, {
      execute: vi.fn(async () => ({ ok: true as const, output: 'ok' })),
    });
    const agent = makeAgent({ tools: [{ name: 't', description: 'T', inputSchema: { type: 'object' } }] });
    const ctx = makeCtx(agent);

    await collectEvents(runAgentLoop(ctx, deps, 'go'));

    // Three tools ran, but only one model round occurred.
    expect(ctx.iterationCount).toBe(1);
  });

  it('hits MAX_ITERATIONS after alternating model→tools up to the cap', async () => {
    // Always emits a tool call → never terminates on its own.
    const provider: ModelProvider = {
      async *generate() {
        yield { type: 'tool_call', toolName: 't', callId: 'c', arguments: {} };
        yield FINISH_TOOLS;
      },
    };
    const deps = createMockDeps(provider, {
      execute: vi.fn(async () => ({ ok: true as const, output: 'ok' })),
    });
    const agent = makeAgent({ tools: [{ name: 't', description: 'T', inputSchema: { type: 'object' } }] });
    const ctx = makeCtx(agent);

    const events = await collectEvents(
      runAgentLoop(ctx, deps, 'go', { maxToolIterations: 10 }),
    );

    expect(ctx.iterationCount).toBe(10);
    const last = events.at(-1);
    expect(last).toHaveProperty('type', 'run_failed');
    expect(last).toHaveProperty('code', 'MAX_ITERATIONS');
  });
});
