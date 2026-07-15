import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ControlPlaneClient } from '../client.js';
import { SdkHttpError } from '../types.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
    headers: new Headers(),
  } as Response;
}

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

  describe('error handling', () => {
    it('throws SdkHttpError on non-OK response', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404, 'Not Found'),
      );

      await expect(client.getSession('ses_missing')).rejects.toThrow(SdkHttpError);
      try {
        await client.getSession('ses_missing');
      } catch {
        // Already threw above
      }
    });

    it('SdkHttpError includes status and body', async () => {
      const errorBody = { error: { code: 'NOT_FOUND', message: 'Not found' } };
      mockFetch.mockResolvedValueOnce(jsonResponse(errorBody, 404, 'Not Found'));

      try {
        await client.getSession('ses_missing');
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(SdkHttpError);
        const err = e as InstanceType<typeof SdkHttpError>;
        expect(err.status).toBe(404);
        expect(err.body).toEqual(errorBody);
      }
    });
  });
});
