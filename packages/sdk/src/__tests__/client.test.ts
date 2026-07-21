import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isSwiftAgentError } from '@swiftagent/shared';
import { ControlPlaneClient } from '../client.js';
import { SdkHttpError } from '../types.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(
  body: unknown,
  status = 200,
  statusText = 'OK',
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
    headers: new Headers(headers),
  } as Response;
}

const validAgentRecord = {
  agentId: 'agt_abc123',
  workspaceId: 'ws_abc123',
  name: 'test-agent',
  modelConfig: { model: 'openai/gpt-4' },
  systemPrompt: 'hello',
  memoryConfig: { strategy: 'last_n' },
  toolRunnerUrl: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('ControlPlaneClient', () => {
  let client: ControlPlaneClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new ControlPlaneClient('test-api-key', 'http://localhost:3000');
  });

  describe('registerAgent', () => {
    it('sends POST /v1/agents with auth header and body', async () => {
      const agentRecord = {
        agentId: 'agt_abc123',
        workspaceId: 'ws_abc123',
        name: 'test-agent',
        modelConfig: { model: 'openai/gpt-4' },
        systemPrompt: 'hello',
        memoryConfig: { strategy: 'last_n' },
        toolRunnerUrl: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(agentRecord, 201));

      const result = await client.registerAgent({
        name: 'test-agent',
        modelConfig: { model: 'openai/gpt-4' },
        systemPrompt: 'hello',
      });

      expect(result.name).toBe('test-agent');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:3000/v1/agents');
      expect(opts.method).toBe('POST');
      expect(opts.headers.Authorization).toBe('Bearer test-api-key');
      expect(JSON.parse(opts.body as string).name).toBe('test-agent');
    });

    it('sends normalized tool definitions (inputSchema, no execute)', async () => {
      const agentRecord = {
        agentId: 'agt_abc123',
        workspaceId: 'ws_abc123',
        name: 'tools-agent',
        modelConfig: { model: 'openai/gpt-4' },
        systemPrompt: 'hello',
        memoryConfig: { strategy: 'last_n' },
        tools: [
          { name: 'lookupOrder', description: 'x', inputSchema: { type: 'object' } },
        ],
        toolRunnerUrl: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(agentRecord, 201));

      const result = await client.registerAgent({
        name: 'tools-agent',
        modelConfig: { model: 'openai/gpt-4' },
        systemPrompt: 'hello',
        tools: [
          { name: 'lookupOrder', description: 'x', inputSchema: { type: 'object' } },
        ],
      });

      expect(result.tools).toEqual([
        { name: 'lookupOrder', description: 'x', inputSchema: { type: 'object' } },
      ]);

      const [, opts] = mockFetch.mock.calls[0];
      const sentBody = JSON.parse(opts.body as string);
      expect(sentBody.tools).toHaveLength(1);
      expect(sentBody.tools[0]).toHaveProperty('inputSchema');
      expect(sentBody.tools[0]).not.toHaveProperty('parameters');
      expect(sentBody.tools[0]).not.toHaveProperty('execute');
    });
  });

  describe('createSession', () => {
    it('sends POST /v1/sessions and returns session result', async () => {
      const response = {
        sessionId: 'ses_abc123',
        clientToken: 'token_xyz',
        websocketUrl: 'ws://localhost/ws',
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(response, 201));

      const result = await client.createSession({
        agentName: 'test-agent',
        userId: 'user_1',
      });

      expect(result.sessionId).toBe('ses_abc123');
      expect(result.clientToken).toBe('token_xyz');
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:3000/v1/sessions');
      expect(JSON.parse(opts.body as string).agentName).toBe('test-agent');
    });
  });

  describe('getSession', () => {
    it('sends GET /v1/sessions/:id', async () => {
      const session = {
        sessionId: 'ses_abc123',
        agentId: 'agt_abc123',
        userId: null,
        status: 'active',
        metadata: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(session));

      const result = await client.getSession('ses_abc123');
      expect(result.sessionId).toBe('ses_abc123');
      expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3000/v1/sessions/ses_abc123');
    });
  });

  describe('listMessages', () => {
    it('sends GET /v1/sessions/:id/messages with query params', async () => {
      const response = {
        data: [
          {
            messageId: 'msg_abc123',
            sessionId: 'ses_abc123',
            runId: null,
            role: 'user',
            content: 'Hello',
            createdAt: new Date().toISOString(),
          },
        ],
        hasMore: false,
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(response));

      const result = await client.listMessages('ses_abc123', { limit: 10, cursor: 'c1' });
      expect(result.data).toHaveLength(1);
      expect(result.hasMore).toBe(false);
      expect(mockFetch.mock.calls[0][0]).toContain('limit=10');
      expect(mockFetch.mock.calls[0][0]).toContain('cursor=c1');
    });
  });

  describe('createRun', () => {
    it('sends POST /v1/sessions/:id/runs', async () => {
      const run = {
        runId: 'run_abc123',
        sessionId: 'ses_abc123',
        status: 'running',
        model: 'openai/gpt-4',
        tokenUsage: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(run, 201));

      const result = await client.createRun('ses_abc123', { content: 'Hello' });
      expect(result.runId).toBe('run_abc123');
      expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3000/v1/sessions/ses_abc123/runs');
    });
  });

  // ── Protocol compatibility (WS-37) ─────────────────────────────────

  describe('registerAgent — protocol compatibility', () => {
    it('passes on a matching x-swiftagent-protocol header', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(validAgentRecord, 201, 'Created', { 'x-swiftagent-protocol': '1' }),
      );

      const result = await client.registerAgent({
        name: 'test-agent',
        modelConfig: { model: 'openai/gpt-4' },
        systemPrompt: 'hello',
      });

      expect(result.agentId).toBe('agt_abc123');
    });

    it('throws INCOMPATIBLE_VERSION on a mismatched header, before body parsing', async () => {
      // Header says the server speaks protocol 2 (this SDK speaks 1) AND the body
      // is malformed — the version error must win, proving the assertion runs
      // before AgentRecordSchema.parse.
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ not: 'an agent record' }, 201, 'Created', {
          'x-swiftagent-protocol': '2',
        }),
      );

      let caught: unknown;
      try {
        await client.registerAgent({
          name: 'test-agent',
          modelConfig: { model: 'openai/gpt-4' },
          systemPrompt: 'hello',
        });
      } catch (e) {
        caught = e;
      }

      expect(isSwiftAgentError(caught)).toBe(true);
      if (!isSwiftAgentError(caught)) throw new Error('unreachable');
      expect(caught.code).toBe('INCOMPATIBLE_VERSION');
    });

    it('succeeds against a legacy server that omits the header (fail-open)', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(validAgentRecord, 201));

      const result = await client.registerAgent({
        name: 'test-agent',
        modelConfig: { model: 'openai/gpt-4' },
        systemPrompt: 'hello',
      });

      expect(result.agentId).toBe('agt_abc123');
    });
  });

  describe('createSession — surfaces serverProtocolVersion', () => {
    const sessionBody = {
      sessionId: 'ses_abc123',
      clientToken: 'token_xyz',
      websocketUrl: 'ws://localhost/ws',
    };

    it('folds the x-swiftagent-protocol header into the result (no assertion)', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(sessionBody, 201, 'Created', { 'x-swiftagent-protocol': '1' }),
      );

      const result = await client.createSession({ agentName: 'test-agent' });
      expect(result.sessionId).toBe('ses_abc123');
      expect(result.serverProtocolVersion).toBe('1');
    });

    it('leaves serverProtocolVersion undefined when the header is absent', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(sessionBody, 201));

      const result = await client.createSession({ agentName: 'test-agent' });
      expect(result.serverProtocolVersion).toBeUndefined();
    });

    it('does NOT throw even when the header would be incompatible (assert is client-side)', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(sessionBody, 201, 'Created', { 'x-swiftagent-protocol': '2' }),
      );

      const result = await client.createSession({ agentName: 'test-agent' });
      expect(result.serverProtocolVersion).toBe('2');
    });
  });

  // ── Typed error mapping (WS-41, SC-08) ─────────────────────────────

  describe('error handling', () => {
    async function catchError(fn: () => Promise<unknown>): Promise<unknown> {
      try {
        await fn();
      } catch (e) {
        return e;
      }
      throw new Error('expected the call to throw');
    }

    it('maps a 401 to UNAUTHORIZED, mentions the API key, preserves the SdkHttpError cause', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'bad key' } }, 401, 'Unauthorized'),
      );

      const err = await catchError(() => client.getSession('ses_1'));
      expect(isSwiftAgentError(err)).toBe(true);
      if (!isSwiftAgentError(err)) throw new Error('unreachable');
      expect(err.code).toBe('UNAUTHORIZED');
      expect(err.statusCode).toBe(401);
      expect(err.message).toMatch(/API key/i);
      expect(err.cause).toBeInstanceOf(SdkHttpError);
      expect((err.cause as InstanceType<typeof SdkHttpError>).status).toBe(401);
    });

    it.each([
      [404, 'NOT_FOUND'],
      [409, 'CONFLICT'],
      [429, 'RATE_LIMIT'],
      [500, 'INTERNAL'],
      [502, 'PROVIDER_ERROR'],
      [503, 'CONNECTION_ERROR'],
      [504, 'TIMEOUT'],
    ])('maps HTTP %i to %s with cause preserved', async (status, expectedCode) => {
      // A bare (non-structured) body so the status alone drives the mapping.
      mockFetch.mockResolvedValueOnce(jsonResponse(null, status, 'Err'));

      const err = await catchError(() => client.getSession('ses_1'));
      expect(isSwiftAgentError(err)).toBe(true);
      if (!isSwiftAgentError(err)) throw new Error('unreachable');
      expect(err.code).toBe(expectedCode);
      expect(err.statusCode).toBe(status);
      expect(err.cause).toBeInstanceOf(SdkHttpError);
    });

    it('honors a known structured server code over the status-derived one and includes the server message', async () => {
      // HTTP 403 but the server body says FORBIDDEN with a specific message.
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ code: 'FORBIDDEN', message: 'key lacks scope' }, 403, 'Forbidden'),
      );

      const err = await catchError(() => client.getSession('ses_1'));
      expect(isSwiftAgentError(err)).toBe(true);
      if (!isSwiftAgentError(err)) throw new Error('unreachable');
      expect(err.code).toBe('FORBIDDEN');
      expect(err.message).toContain('key lacks scope');
    });

    it('maps a network refusal to CONNECTION_ERROR naming the baseUrl, preserving the rejection', async () => {
      const rejection = new TypeError('fetch failed');
      mockFetch.mockRejectedValueOnce(rejection);

      const err = await catchError(() => client.getSession('ses_1'));
      expect(isSwiftAgentError(err)).toBe(true);
      if (!isSwiftAgentError(err)) throw new Error('unreachable');
      expect(err.code).toBe('CONNECTION_ERROR');
      expect(err.message).toContain('http://localhost:3000');
      expect(err.cause).toBe(rejection);
    });

    it('maps an aborted/timed-out fetch to TIMEOUT', async () => {
      const abort = new DOMException('The operation was aborted', 'AbortError');
      mockFetch.mockRejectedValueOnce(abort);

      const err = await catchError(() => client.getSession('ses_1'));
      expect(isSwiftAgentError(err)).toBe(true);
      if (!isSwiftAgentError(err)) throw new Error('unreachable');
      expect(err.code).toBe('TIMEOUT');
      expect(err.cause).toBe(abort);
    });

    it('never surfaces a bare SdkHttpError to the caller', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: { message: 'nope' } }, 404, 'Not Found'));
      const err = await catchError(() => client.getSession('ses_missing'));
      expect(err).not.toBeInstanceOf(SdkHttpError);
      expect(isSwiftAgentError(err)).toBe(true);
    });
  });
});
