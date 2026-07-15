import { describe, it, expect, vi } from 'vitest';
import type { AgentRecord, MessageRecord, ChatEvent, SwiftAgentError } from '@swiftagent/shared';
import { isSwiftAgentError } from '@swiftagent/shared';
import type { ModelProvider, ModelStreamChunk } from '@swiftagent/models';
import { ProviderRegistry } from '@swiftagent/models';
import { createToolExecutorResolver } from '../tool-executor-resolver.js';
import { LocalToolExecutor } from '../tool-executor-local.js';
import { RemoteToolExecutor } from '../tool-executor-remote.js';
import { AgentEngine } from '../engine.js';
import type { AgentEngineDeps } from '../types.js';
import type { ToolCall, ToolCallContext, ToolCallResult } from '../tool-executor.js';

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
    createdAt: new Date('2020-01-01'),
    updatedAt: new Date('2020-01-01'),
    ...overrides,
  };
}

const OK_CALL: ToolCall = { toolName: 'ping', callId: 'tc_1', arguments: {} };
const OK_CTX: ToolCallContext = { sessionId: 'ses_1', runId: 'run_1' };

/** A fetch mock that records every requested URL and returns a 200 result. */
function recordingFetch(): { fetchMock: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    urls.push(String(input));
    return {
      ok: true,
      status: 200,
      json: async () => ({ result: 'ok' }),
      text: async () => '',
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchMock, urls };
}

// ---------------------------------------------------------------------------
// Resolution rules (Tests 1–4, 6)
// ---------------------------------------------------------------------------

describe('createToolExecutorResolver — resolution rules', () => {
  it('resolves a RemoteToolExecutor whose calls hit the agent runner URL', async () => {
    const { fetchMock, urls } = recordingFetch();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      const resolver = createToolExecutorResolver({
        resolveAuthToken: () => 'interim-token',
      });
      const agent = makeAgent({ toolRunnerUrl: 'https://runner.a' });

      const executor = await resolver.resolve(agent);
      expect(executor).toBeInstanceOf(RemoteToolExecutor);

      await executor.execute(OK_CALL, OK_CTX, new AbortController().signal);
      expect(urls).toEqual(['https://runner.a/tools/ping']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('passes the resolved auth token to the remote executor', async () => {
    const { fetchMock } = recordingFetch();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      const resolveAuthToken = vi.fn(async () => 'secret-token');
      const resolver = createToolExecutorResolver({ resolveAuthToken });
      const agent = makeAgent({ toolRunnerUrl: 'https://runner.a' });

      const executor = await resolver.resolve(agent);
      await executor.execute(OK_CALL, OK_CTX, new AbortController().signal);

      expect(resolveAuthToken).toHaveBeenCalledWith(agent);
      const headers = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]
        .headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer secret-token');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('resolves a LocalToolExecutor when internal tools are explicitly registered', async () => {
    const handler = vi.fn(async () => ({ value: 99 }));
    const resolver = createToolExecutorResolver({
      resolveAuthToken: () => 'unused',
      registerLocalTools: (_agent, local) => {
        local.registerTool('ping', handler);
        return 1;
      },
    });
    const agent = makeAgent({
      tools: [{ name: 'ping', description: 'Ping', inputSchema: { type: 'object' } }],
    });

    const executor = await resolver.resolve(agent);
    expect(executor).toBeInstanceOf(LocalToolExecutor);

    const result = await executor.execute(OK_CALL, OK_CTX, new AbortController().signal);
    expect(result).toEqual({ ok: true, output: { value: 99 } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('fails fast for a tool-bearing agent with no execution configuration', async () => {
    const resolver = createToolExecutorResolver({
      resolveAuthToken: () => 'unused',
      // registerLocalTools registers nothing → count 0 → not explicit local.
      registerLocalTools: () => 0,
    });
    const agent = makeAgent({
      tools: [{ name: 'ping', description: 'Ping', inputSchema: { type: 'object' } }],
    });

    let error: unknown;
    try {
      await resolver.resolve(agent);
    } catch (err) {
      error = err;
    }
    expect(isSwiftAgentError(error)).toBe(true);
    expect((error as SwiftAgentError).code).toBe('VALIDATION');
    expect((error as SwiftAgentError).message).toContain(agent.agentId);
  });

  it('fails fast when no registerLocalTools callback is provided', async () => {
    const resolver = createToolExecutorResolver({ resolveAuthToken: () => 'unused' });
    const agent = makeAgent({
      tools: [{ name: 'ping', description: 'Ping', inputSchema: { type: 'object' } }],
    });

    let error: unknown;
    try {
      await resolver.resolve(agent);
    } catch (err) {
      error = err;
    }
    expect(isSwiftAgentError(error)).toBe(true);
    expect((error as SwiftAgentError).code).toBe('VALIDATION');
  });

  it('resolves a no-op executor for a tool-less agent without throwing', async () => {
    const resolver = createToolExecutorResolver({ resolveAuthToken: () => 'unused' });
    const agent = makeAgent({ tools: [], toolRunnerUrl: null });

    const executor = await resolver.resolve(agent);
    expect(executor).toBeInstanceOf(LocalToolExecutor);
    // Nothing is registered — an actual call would report an unknown tool, but
    // for a tool-less agent this path is never reached in the loop.
    const result = await executor.execute(OK_CALL, OK_CTX, new AbortController().signal);
    expect(result).toEqual({ ok: false, error: 'Unknown tool: ping' });
  });

  it('re-registration under a new runner URL yields a different executor', async () => {
    const { fetchMock, urls } = recordingFetch();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      const resolver = createToolExecutorResolver({ resolveAuthToken: () => 'token' });
      const agentId = 'agt_reregisterxxxxxxxxx';

      const first = await resolver.resolve(makeAgent({ agentId, toolRunnerUrl: 'https://runner.a' }));
      const second = await resolver.resolve(makeAgent({ agentId, toolRunnerUrl: 'https://runner.b' }));

      expect(first).not.toBe(second);

      await first.execute(OK_CALL, OK_CTX, new AbortController().signal);
      await second.execute(OK_CALL, OK_CTX, new AbortController().signal);
      expect(urls).toEqual(['https://runner.a/tools/ping', 'https://runner.b/tools/ping']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('memoizes the executor for a stable (agentId, runnerUrl)', async () => {
    const resolveAuthToken = vi.fn(() => 'token');
    const resolver = createToolExecutorResolver({ resolveAuthToken });
    const agent = makeAgent({ toolRunnerUrl: 'https://runner.a' });

    const a = await resolver.resolve(agent);
    const b = await resolver.resolve(agent);
    expect(a).toBe(b);
    // Auth token only fetched once — the second resolve returns the cached executor.
    expect(resolveAuthToken).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// No cross-routing (Test 5, SC-07)
// ---------------------------------------------------------------------------

describe('createToolExecutorResolver — no cross-routing (SC-07)', () => {
  it('keeps two agents bound to their own runners under interleaved execution', async () => {
    const { fetchMock, urls } = recordingFetch();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      const resolver = createToolExecutorResolver({ resolveAuthToken: () => 'token' });
      const agentA = makeAgent({ agentId: 'agt_aaaaaaaaaaaaaaaaaaa', toolRunnerUrl: 'https://runner.a' });
      const agentB = makeAgent({ agentId: 'agt_bbbbbbbbbbbbbbbbbbb', toolRunnerUrl: 'https://runner.b' });

      const execA = await resolver.resolve(agentA);
      const execB = await resolver.resolve(agentB);

      const signal = new AbortController().signal;
      // Interleave calls across both executors.
      await execA.execute({ ...OK_CALL, toolName: 'a1' }, OK_CTX, signal);
      await execB.execute({ ...OK_CALL, toolName: 'b1' }, OK_CTX, signal);
      await execA.execute({ ...OK_CALL, toolName: 'a2' }, OK_CTX, signal);
      await execB.execute({ ...OK_CALL, toolName: 'b2' }, OK_CTX, signal);

      const aUrls = urls.filter((u) => u.startsWith('https://runner.a'));
      const bUrls = urls.filter((u) => u.startsWith('https://runner.b'));
      expect(aUrls).toEqual(['https://runner.a/tools/a1', 'https://runner.a/tools/a2']);
      expect(bUrls).toEqual(['https://runner.b/tools/b1', 'https://runner.b/tools/b2']);
      // Neither executor ever touched the other's runner.
      expect(urls.every((u) => u.startsWith('https://runner.a') || u.startsWith('https://runner.b'))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Engine wiring (Test 7)
// ---------------------------------------------------------------------------

const FINISH_TOOLS: ModelStreamChunk = { type: 'finish', finishReason: 'tool_calls', usage: {} };
const FINISH_STOP: ModelStreamChunk = {
  type: 'finish',
  finishReason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};

/** Provider that emits a single tool call on the first turn, then stops. */
function toolThenStopProvider(): ModelProvider {
  let call = 0;
  return {
    async *generate() {
      if (call++ === 0) {
        yield { type: 'tool_call', toolName: 'ping', callId: 'call_p', arguments: {} };
        yield FINISH_TOOLS;
      } else {
        yield { type: 'token', text: 'done' };
        yield FINISH_STOP;
      }
    },
  };
}

function makeEngineDeps(agent: AgentRecord, resolver: AgentEngineDeps['toolExecutorResolver']): AgentEngineDeps {
  const messages: MessageRecord[] = [];
  const registry = new ProviderRegistry();
  registry.register('openai', () => toolThenStopProvider(), { apiKey: 'test-key' });

  return {
    db: {
      messages: {
        create: vi.fn(async (record: Partial<MessageRecord>) => {
          const msg = { messageId: 'msg_x', sessionId: 'ses_x', runId: null, role: 'user', content: '', createdAt: new Date('2020-01-01'), ...record } as MessageRecord;
          messages.push(msg);
          return msg;
        }),
        createBatch: vi.fn(async () => []),
        listBySession: vi.fn(async () => [...messages]),
        listByRun: vi.fn(async () => []),
        getLastN: vi.fn(async (_sid: string, n: number) => messages.slice(-n)),
      },
      runs: {
        create: vi.fn(async (record) => ({ ...record, status: 'running', tokenUsage: null, createdAt: new Date('2020-01-01'), updatedAt: new Date('2020-01-01') })),
        getById: vi.fn(async () => null),
        updateStatus: vi.fn(async () => null),
        complete: vi.fn(async () => null),
        fail: vi.fn(async () => null),
        listBySession: vi.fn(async () => []),
      },
      toolCalls: {
        create: vi.fn(async (record) => ({ ...record, output: null, status: 'started', createdAt: new Date('2020-01-01'), updatedAt: new Date('2020-01-01') })),
        updateResult: vi.fn(async () => null),
        fail: vi.fn(async () => null),
        listByRun: vi.fn(async () => []),
      },
      sessions: {
        create: vi.fn(async () => null),
        getById: vi.fn(async () => ({
          sessionId: 'ses_enginexxxxxxxxxxxxx',
          agentId: agent.agentId,
          status: 'active',
          createdAt: new Date('2020-01-01'),
          updatedAt: new Date('2020-01-01'),
        })),
        updateStatus: vi.fn(async () => null),
        listByAgent: vi.fn(async () => []),
        listByUser: vi.fn(async () => []),
      },
      agents: {
        create: vi.fn(async () => null),
        getById: vi.fn(async () => agent),
        getByWorkspaceId: vi.fn(async () => []),
        getByName: vi.fn(async () => null),
        update: vi.fn(async () => null),
      },
    } as unknown as AgentEngineDeps['db'],
    modelRegistry: registry,
    toolExecutorResolver: resolver,
  };
}

describe('AgentEngine — executor resolution wiring (Test 7)', () => {
  it('resolves the executor from the run agent and the loop invokes it with the run id', async () => {
    const agent = makeAgent({
      agentId: 'agt_enginexxxxxxxxxxxxxx',
      tools: [{ name: 'ping', description: 'Ping', inputSchema: { type: 'object' } }],
    });

    const execute = vi.fn(
      async (_call: ToolCall, _ctx: ToolCallContext): Promise<ToolCallResult> => ({
        ok: true,
        output: { pong: true },
      }),
    );
    const resolve = vi.fn(async () => ({ execute }));
    const resolver = { resolve };

    const deps = makeEngineDeps(agent, resolver);
    const engine = new AgentEngine(deps);

    const events: ChatEvent[] = [];
    for await (const ev of engine.run('ses_enginexxxxxxxxxxxxx', 'go')) events.push(ev);

    // Resolver was consulted with the run's agent.
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(agent);

    // The loop used the resolved executor, carrying the run's id in the context.
    expect(execute).toHaveBeenCalledTimes(1);
    const [call, ctx] = execute.mock.calls[0];
    expect(call.toolName).toBe('ping');
    expect(ctx.runId).toMatch(/^run_/);
    expect(ctx.sessionId).toBe('ses_enginexxxxxxxxxxxxx');
  });
});
