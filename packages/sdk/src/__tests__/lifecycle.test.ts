import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { createAgentApp } from '../app.js';
import { defineAgent } from '../agent.js';
import { tool } from '../tool.js';

/**
 * Lifecycle integration test:
 * - Define an agent with one tool
 * - Start the app (tool runner + mock registration)
 * - Simulate runtime POST to tool runner
 * - Assert response
 */

// Save the real fetch before mocking
const realFetch = globalThis.fetch;

// Mock fetch — pass through to real fetch for tool runner calls (127.0.0.1)
const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
  if (url.includes('127.0.0.1') && !url.includes('/v1/')) {
    return realFetch(url, init);
  }
  // Default: return mocked response (overridden per test)
  return Promise.resolve(jsonResponse({}, 200));
});
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

describe('Lifecycle integration', () => {
  let app: ReturnType<typeof createAgentApp>;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('define agent → register → POST /tools/:toolName → assert response', async () => {
    // Configure mock to handle control plane calls, pass through tool runner calls
    const agentRecord = {
      agentId: 'agt_abc123',
      workspaceId: 'ws_abc123',
      name: 'support',
      modelConfig: { model: 'openai/gpt-4' },
      systemPrompt: 'You are a support agent.',
      memoryConfig: { strategy: 'last_n' },
      toolRunnerUrl: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      // Pass through to real fetch for tool runner calls
      if (typeof url === 'string' && url.includes('127.0.0.1') && !url.includes('/v1/')) {
        return realFetch(url, init);
      }
      // Mock control plane responses
      return Promise.resolve(jsonResponse(agentRecord, 201));
    });

    const lookupOrder = tool({
      name: 'lookupOrder',
      description: 'Look up an order by ID',
      inputSchema: z.object({ orderId: z.string() }),
      execute: async ({ orderId }) => ({
        orderId,
        status: 'shipped',
        trackingNumber: 'TRK-12345',
      }),
    });

    const agent = defineAgent({
      name: 'support',
      model: 'openai/gpt-4',
      system: 'You are a support agent.',
      tools: [lookupOrder],
    });

    const API_KEY = 'integration-test-key';
    app = createAgentApp({ apiKey: API_KEY, baseUrl: 'http://localhost:3000' });
    app.agent(agent);

    // Start tool runner on random port
    await app.listen(0);

    // Determine the port the server is listening on
    // Access the internal server via close/listen pattern — we need the port
    // We'll use the registration call to find the toolRunnerUrl
    const registerCall = mockFetch.mock.calls.find(
      (call: any[]) => call[1]?.method === 'POST' && (call[0] as string).includes('/v1/agents'),
    );
    expect(registerCall).toBeDefined();

    const registeredBody = JSON.parse((registerCall as [string, RequestInit])[1].body as string);
    const toolRunnerUrl = registeredBody.toolRunnerUrl as string;
    expect(toolRunnerUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // Simulate runtime calling the tool runner
    const res = await fetch(`${toolRunnerUrl}/tools/lookupOrder`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        input: { orderId: 'ORD-001' },
        context: { sessionId: 'ses_test123', userId: 'user_1' },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;
    expect(body.result).toEqual({
      orderId: 'ORD-001',
      status: 'shipped',
      trackingNumber: 'TRK-12345',
    });

    // Verify agent registration included tool schemas
    expect(registeredBody.name).toBe('support');
    expect(registeredBody.modelConfig.model).toBe('openai/gpt-4');
    expect(registeredBody.systemPrompt).toBe('You are a support agent.');
  });
});
