import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { ZodError } from 'zod';
import { generateKeyPair, exportSPKI } from 'jose';
import { isSwiftAgentError } from '@swiftagent/shared';
import { createAgentApp } from '../app.js';
import { defineAgent } from '../agent.js';
import { tool } from '../tool.js';

/** Assert a thrown value is a SwiftAgentError(VALIDATION) whose message matches. */
function expectValidationError(fn: () => unknown, contains: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(isSwiftAgentError(caught)).toBe(true);
  if (!isSwiftAgentError(caught)) throw new Error('unreachable');
  expect(caught.code).toBe('VALIDATION');
  expect(caught.message).toContain(contains);
}

let publicKeyPem: string;

beforeAll(async () => {
  const { publicKey } = await generateKeyPair('EdDSA');
  publicKeyPem = await exportSPKI(publicKey);
});

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

  it('throws a SwiftAgentError(VALIDATION) naming apiKey when it is missing', () => {
    expectValidationError(() => createAgentApp({ apiKey: '' }), 'apiKey');
  });

  it('registers agents and throws a SwiftAgentError(VALIDATION) on duplicate tool names', () => {
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
    expectValidationError(() => app.agent(agent2), 'Duplicate tool name "same"');
  });

  // ── Setup errors (WS-41, SC-07) ────────────────────────────────────

  describe('listen() runner-verification setup errors', () => {
    beforeEach(() => {
      // Isolate from any ambient runner env so the option-vs-env branches are
      // exercised. An empty string is falsy, so the "missing key/workspace"
      // guards fire exactly as they would with the var unset.
      vi.stubEnv('RUNNER_TOKEN_PUBLIC_KEY', '');
      vi.stubEnv('RUNNER_WORKSPACE_ID', '');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('throws VALIDATION naming RUNNER_TOKEN_PUBLIC_KEY when no key is provided', async () => {
      const runnerApp = createAgentApp({ apiKey: 'test-key', baseUrl: 'http://localhost:3000' });
      await expect(runnerApp.listen(0)).rejects.toMatchObject({
        name: 'SwiftAgentError',
        code: 'VALIDATION',
      });
      await expect(runnerApp.listen(0)).rejects.toThrow('RUNNER_TOKEN_PUBLIC_KEY');
    });

    it('throws VALIDATION naming RUNNER_WORKSPACE_ID when the key is present but no workspace id', async () => {
      const runnerApp = createAgentApp({
        apiKey: 'test-key',
        baseUrl: 'http://localhost:3000',
        runnerPublicKey: publicKeyPem,
      });
      await expect(runnerApp.listen(0)).rejects.toMatchObject({
        name: 'SwiftAgentError',
        code: 'VALIDATION',
      });
      await expect(runnerApp.listen(0)).rejects.toThrow('RUNNER_WORKSPACE_ID');
    });
  });

  // ── Malformed agent config (WS-41, SC-07) ──────────────────────────

  describe('defineAgent malformed config', () => {
    it('throws VALIDATION naming the failing field with the ZodError as cause', () => {
      let caught: unknown;
      try {
        // temperature out of the [0, 2] range → Zod rejects it.
        defineAgent({ name: 'bad', model: 'openai/gpt-4', temperature: 5 });
      } catch (e) {
        caught = e;
      }
      expect(isSwiftAgentError(caught)).toBe(true);
      if (!isSwiftAgentError(caught)) throw new Error('unreachable');
      expect(caught.code).toBe('VALIDATION');
      expect(caught.message).toContain('temperature');
      expect(caught.cause).toBeInstanceOf(ZodError);
    });

    it('throws VALIDATION naming an empty name field', () => {
      expectValidationError(
        () => defineAgent({ name: '', model: 'openai/gpt-4' }),
        'name',
      );
    });
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

    // A runner needs its verification public key + owning workspace to start (WS-22).
    const runnerApp = createAgentApp({
      apiKey: 'test-key',
      baseUrl: 'http://localhost:3000',
      runnerPublicKey: publicKeyPem,
      runnerWorkspaceId: 'ws_abc123',
    });
    runnerApp.agent(agent);
    await runnerApp.listen(0); // Random port

    // Should have called POST /v1/agents to register the agent
    const registerCalls = mockFetch.mock.calls.filter(
      (call: any[]) => call[1]?.method === 'POST' && (call[0] as string).includes('/v1/agents'),
    );
    expect(registerCalls.length).toBe(1);
    const registerBody = JSON.parse(registerCalls[0][1].body as string);
    expect(registerBody.name).toBe('test-agent');
    expect(registerBody.modelConfig.model).toBe('openai/gpt-4');
    expect(registerBody.systemPrompt).toBe('You are helpful.');
    expect(registerBody.toolRunnerUrl).toBeDefined();
    expect(registerBody.tools).toHaveLength(1);
    expect(registerBody.tools[0].name).toBe('weather');
    expect(registerBody.tools[0]).toHaveProperty('inputSchema');
    expect(registerBody.tools[0]).not.toHaveProperty('parameters');
    expect(registerBody.tools[0]).not.toHaveProperty('execute');

    await runnerApp.close();
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
