import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { LocalToolExecutor } from './tool-executor-local.js';
import { RemoteToolExecutor } from './tool-executor-remote.js';
import type { RemoteToolExecutorOptions } from './tool-executor-remote.js';
import { createToolExecutor } from './tool-executor-factory.js';
import type { ToolCallContext } from './tool-executor.js';
import type { AgentRecord } from '@swiftagent/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ctx: ToolCallContext = {
  sessionId: 'ses_test123',
  runId: 'run_test456',
  userId: 'user_1',
};

function neverAbort(): AbortSignal {
  return new AbortController().signal;
}

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    agentId: 'agt_test',
    workspaceId: 'ws_test',
    name: 'Test Agent',
    modelConfig: { model: 'openai/gpt-4o' },
    systemPrompt: 'You are a test agent.',
    memoryConfig: { strategy: 'last_n', maxMessages: 50 },
    toolRunnerUrl: null,
    tools: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// LocalToolExecutor
// ---------------------------------------------------------------------------

describe('LocalToolExecutor', () => {
  it('happy path — returns handler output', async () => {
    const exec = new LocalToolExecutor();
    exec.registerTool('add', async (input) => {
      const { a, b } = input as { a: number; b: number };
      return a + b;
    });

    const result = await exec.execute(
      { toolName: 'add', callId: 'tc_1', arguments: { a: 2, b: 3 } },
      ctx,
      neverAbort(),
    );

    expect(result).toEqual({ ok: true, output: 5 });
  });

  it('passes context to handler', async () => {
    const exec = new LocalToolExecutor();
    const receivedCtx = vi.fn();

    exec.registerTool('echo', async (_input, c) => {
      receivedCtx(c);
      return 'ok';
    });

    await exec.execute(
      { toolName: 'echo', callId: 'tc_2', arguments: {} },
      ctx,
      neverAbort(),
    );

    expect(receivedCtx).toHaveBeenCalledWith(ctx);
    expect(receivedCtx.mock.calls[0][0].sessionId).toBe('ses_test123');
    expect(receivedCtx.mock.calls[0][0].runId).toBe('run_test456');
  });

  it('returns error for unregistered tool', async () => {
    const exec = new LocalToolExecutor();
    const result = await exec.execute(
      { toolName: 'missing', callId: 'tc_3', arguments: {} },
      ctx,
      neverAbort(),
    );

    expect(result).toEqual({ ok: false, error: 'Unknown tool: missing' });
  });

  it('catches handler throws', async () => {
    const exec = new LocalToolExecutor();
    exec.registerTool('fail', async () => {
      throw new Error('handler boom');
    });

    const result = await exec.execute(
      { toolName: 'fail', callId: 'tc_4', arguments: {} },
      ctx,
      neverAbort(),
    );

    expect(result).toEqual({ ok: false, error: 'handler boom' });
  });

  it('times out slow handlers', async () => {
    const exec = new LocalToolExecutor({ timeoutMs: 50 });
    exec.registerTool('slow', async () => {
      await new Promise((r) => setTimeout(r, 5_000));
      return 'late';
    });

    const result = await exec.execute(
      { toolName: 'slow', callId: 'tc_5', arguments: {} },
      ctx,
      neverAbort(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('timed out');
      expect(result.error).toContain('50');
    }
  });

  it('respects pre-aborted signal', async () => {
    const exec = new LocalToolExecutor();
    exec.registerTool('echo', async (input) => input);

    const ac = new AbortController();
    ac.abort();

    const result = await exec.execute(
      { toolName: 'echo', callId: 'tc_6', arguments: {} },
      ctx,
      ac.signal,
    );

    expect(result).toEqual({ ok: false, error: 'Aborted' });
  });

  it('throws on duplicate tool registration', () => {
    const exec = new LocalToolExecutor();
    exec.registerTool('dup', async () => 'first');
    expect(() => exec.registerTool('dup', async () => 'second')).toThrow(
      'Tool already registered: dup',
    );
  });
});

// ---------------------------------------------------------------------------
// RemoteToolExecutor (with real HTTP mock server) — WS-22 versioned protocol
// ---------------------------------------------------------------------------

// Loopback is only permitted in dev/test policy; production requires https and
// rejects loopback (covered in remote-runner-security.test.ts).
const LOCAL_POLICY = { requireHttps: false, allowLoopback: true } as const;

/** Versioned success/error bodies matching the shared runner protocol. */
function ok(result: unknown): string {
  return JSON.stringify({ version: '1', result });
}
function err(code: string, message: string): string {
  return JSON.stringify({ version: '1', error: { code, message } });
}

describe('RemoteToolExecutor', () => {
  let server: http.Server;
  let baseUrl: string;
  let handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => void;

  function remote(overrides: Partial<RemoteToolExecutorOptions> = {}) {
    return new RemoteToolExecutor({
      toolRunnerUrl: baseUrl,
      agentId: 'agt_test',
      policy: LOCAL_POLICY,
      mintToken: async () => 'scoped-token',
      ...overrides,
    });
  }

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        server = http.createServer((req, res) => handler(req, res));
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address() as AddressInfo;
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      }),
  );

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );

  it('success — returns result and sends the scoped bearer + versioned envelope', async () => {
    let capturedAuth = '';
    let capturedBody = '';
    handler = (req, res) => {
      capturedAuth = req.headers.authorization ?? '';
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        capturedBody = raw;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(ok({ temp: 72 }));
      });
    };

    const result = await remote().execute(
      { toolName: 'weather', callId: 'tc_7', arguments: { city: 'NYC' } },
      ctx,
      neverAbort(),
    );

    expect(result).toEqual({ ok: true, output: { temp: 72 } });
    expect(capturedAuth).toBe('Bearer scoped-token');
    const parsed = JSON.parse(capturedBody);
    expect(parsed.version).toBe('1');
    expect(parsed.idempotencyKey).toBe('tc_7');
    expect(parsed.context.agentId).toBe('agt_test');
    expect(parsed.context.callId).toBe('tc_7');
    expect(parsed.context.runId).toBe('run_test456');
  });

  it('error-shaped 200 response surfaces the handler message', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(err('EXECUTION_ERROR', 'not found'));
    };

    const result = await remote().execute(
      { toolName: 'lookup', callId: 'tc_8', arguments: {} },
      ctx,
      neverAbort(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('not found');
  });

  it('HTTP 400 — no retry', async () => {
    let requestCount = 0;
    handler = (_req, res) => {
      requestCount++;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(err('VALIDATION', 'bad input'));
    };

    const result = await remote({ maxRetries: 2 }).execute(
      { toolName: 'bad', callId: 'tc_9', arguments: {} },
      ctx,
      neverAbort(),
    );

    expect(requestCount).toBe(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('bad input');
  });

  it('retries on 500 then succeeds', async () => {
    let requestCount = 0;
    handler = (_req, res) => {
      requestCount++;
      if (requestCount === 1) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(err('INTERNAL', 'boom'));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(ok('recovered'));
      }
    };

    const result = await remote({ maxRetries: 1, retryDelayMs: 10 }).execute(
      { toolName: 'flaky', callId: 'tc_10', arguments: {} },
      ctx,
      neverAbort(),
    );

    expect(requestCount).toBe(2);
    expect(result).toEqual({ ok: true, output: 'recovered' });
  });

  it('retries exhausted on repeated 500', async () => {
    let requestCount = 0;
    handler = (_req, res) => {
      requestCount++;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(err('INTERNAL', 'Server Error'));
    };

    const result = await remote({ maxRetries: 1, retryDelayMs: 10 }).execute(
      { toolName: 'down', callId: 'tc_11', arguments: {} },
      ctx,
      neverAbort(),
    );

    expect(requestCount).toBe(2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('2 attempts');
    }
  });

  it('times out on hanging server', async () => {
    handler = () => {
      // Never respond
    };

    const result = await remote({ timeoutMs: 100, maxRetries: 0 }).execute(
      { toolName: 'hang', callId: 'tc_12', arguments: {} },
      ctx,
      neverAbort(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('timed out');
  });

  it('network failure — connection refused', async () => {
    const exec = new RemoteToolExecutor({
      toolRunnerUrl: 'http://127.0.0.1:1',
      agentId: 'agt_test',
      policy: LOCAL_POLICY,
      mintToken: async () => 'scoped-token',
      maxRetries: 0,
      timeoutMs: 2_000,
    });

    const result = await exec.execute(
      { toolName: 'unreachable', callId: 'tc_13', arguments: {} },
      ctx,
      neverAbort(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('1 attempts');
    }
  });
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

describe('createToolExecutor', () => {
  const factoryOpts = {
    policy: { requireHttps: false, allowLoopback: true },
    mintToken: async () => 'scoped-token',
  };

  it('returns RemoteToolExecutor when toolRunnerUrl is set', () => {
    const executor = createToolExecutor(
      makeAgent({ toolRunnerUrl: 'http://localhost:4000' }),
      factoryOpts,
    );
    expect(executor).toBeInstanceOf(RemoteToolExecutor);
  });

  it('returns LocalToolExecutor when toolRunnerUrl is null', () => {
    const executor = createToolExecutor(
      makeAgent({ toolRunnerUrl: null }),
      factoryOpts,
    );
    expect(executor).toBeInstanceOf(LocalToolExecutor);
  });
});
