import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { createAgentApp } from '../app.js';
import { defineAgent } from '../agent.js';
import { tool } from '../tool.js';

// Mock fetch for control-plane client calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: async () => body,
    headers: new Headers(),
  } as Response;
}

const agentRecord = {
  agentId: 'agt_abc123',
  workspaceId: 'ws_abc123',
  name: 'test-agent',
  modelConfig: { model: 'openai/gpt-4' },
  systemPrompt: 'You are helpful.',
  memoryConfig: { strategy: 'last_n' },
  toolRunnerUrl: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('AgentApp', () => {
  let app: ReturnType<typeof createAgentApp>;

  beforeEach(() => {
    mockFetch.mockReset();
    app = createAgentApp({ apiKey: 'test-key', baseUrl: 'http://localhost:3000' });
  });

  afterEach(async () => {
    await app.close();
  });

  it('throws if apiKey is missing', () => {
    expect(() => createAgentApp({ apiKey: '' })).toThrow('apiKey is required');
  });

  it('registers agents and throws on duplicate tool names', () => {
    const t1 = tool({
      name: 'same',
      description: 'First',
      inputSchema: z.object({}),
      execute: async () => ({}),
    });
    const t2 = tool({
      name: 'same',
      description: 'Second',
      inputSchema: z.object({}),
      execute: async () => ({}),
    });

    const agent1 = defineAgent({ name: 'a1', model: 'openai/gpt-4', tools: [t1] });
    const agent2 = defineAgent({ name: 'a2', model: 'openai/gpt-4', tools: [t2] });

    app.agent(agent1);
    expect(() => app.agent(agent2)).toThrow('Duplicate tool name "same"');
  });

  it('listen() starts tool runner and registers agents via POST /agents', async () => {
    mockFetch.mockResolvedValue(jsonResponse(agentRecord, 201));

    const weatherTool = tool({
      name: 'weather',
      description: 'Get weather',
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ temp: 72, city }),
    });

    const agent = defineAgent({
      name: 'test-agent',
      model: 'openai/gpt-4',
      system: 'You are helpful.',
      tools: [weatherTool],
    });

    app.agent(agent);
    await app.listen(0); // Random port

    // Should have called POST /v1/agents to register the agent
    const postCalls = mockFetch.mock.calls.filter(
      (call: any[]) => call[1]?.method === 'POST' && (call[0] as string).includes('/v1/agents'),
    );
    expect(postCalls.length).toBe(1);

    const body = JSON.parse(postCalls[0][1].body as string);
    expect(body.name).toBe('test-agent');
    expect(body.modelConfig.model).toBe('openai/gpt-4');
    expect(body.systemPrompt).toBe('You are helpful.');
    expect(body.toolRunnerUrl).toBeDefined();

    // Normalized tool definitions are sent with inputSchema (not parameters/execute)
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].name).toBe('weather');
    expect(body.tools[0]).toHaveProperty('inputSchema');
    expect(body.tools[0]).not.toHaveProperty('parameters');
    expect(body.tools[0]).not.toHaveProperty('execute');
  });

  describe('sessions', () => {
    it('sessions.create sends correct path and body', async () => {
      const response = {
        sessionId: 'ses_abc',
        clientToken: 'tok',
        websocketUrl: 'ws://test',
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(response, 201));

      const result = await app.sessions.create({
        agentName: 'my-agent',
        userId: 'u1',
        metadata: { org: 'acme' },
      });

      expect(result.sessionId).toBe('ses_abc');
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('/v1/sessions');
      expect(opts.method).toBe('POST');
      const body = JSON.parse(opts.body as string);
      expect(body.agentName).toBe('my-agent');
      expect(body.userId).toBe('u1');
    });

    it('sessions.get sends correct path', async () => {
      const session = {
        sessionId: 'ses_abc',
        agentId: 'agt_abc',
        userId: null,
        status: 'active',
        metadata: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(session));

      const result = await app.sessions.get('ses_abc');
      expect(result.sessionId).toBe('ses_abc');
    });

    it('sessions.messages.list sends correct path', async () => {
      const response = {
        data: [],
        hasMore: false,
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(response));

      const result = await app.sessions.messages.list('ses_abc', { limit: 10 });
      expect(result.data).toHaveLength(0);
      expect(result.hasMore).toBe(false);
    });
  });

  describe('runs', () => {
    it('runs.create sends correct path and body', async () => {
      const run = {
        runId: 'run_abc',
        sessionId: 'ses_abc',
        status: 'running',
        model: 'openai/gpt-4',
        tokenUsage: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(run, 201));

      const result = await app.runs.create({
        sessionId: 'ses_abc',
        content: 'Hello!',
      });

      expect(result.runId).toBe('run_abc');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.content).toBe('Hello!');
    });
  });
});
