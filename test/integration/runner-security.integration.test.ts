import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { generateKeyPair } from 'jose';
import {
  createRuntimeHarness,
  seededTool,
  type RuntimeHarness,
} from '../support/runtime-harness.js';
import { byTurn, textTurn, toolTurn } from '../support/fake-provider.js';
import { startFakeRunner, reserveFreePort, type FakeRunnerHandle } from '../support/fake-runner.js';

/**
 * WS-25 · Runner security (SC-08 scoped auth, SC-09 SSRF + payload bounds,
 * SC-10 replay-safe retry). Exercises the REAL remote executor ⇄ SDK runner HTTP
 * boundary; no mocks.
 */
describe('runner-security', () => {
  let harness: RuntimeHarness;
  const runners: FakeRunnerHandle[] = [];
  const servers: Server[] = [];

  beforeAll(async () => {
    harness = await createRuntimeHarness();
  });

  afterEach(async () => {
    while (runners.length) await runners.pop()!.teardown();
    while (servers.length) {
      await new Promise<void>((res) => servers.pop()!.close(() => res()));
    }
  });

  afterAll(async () => {
    await harness.teardown();
  });

  it('rejects a token the runner cannot verify → tool call fails 401 (SC-08)', async () => {
    const { workspaceId } = await harness.seedWorkspaceWithKey();

    // Start the runner with a DIFFERENT public key than the harness signs with,
    // so every minted token fails signature verification → 401 UNAUTHORIZED.
    const foreign = await generateKeyPair('EdDSA');
    const runner = await startFakeRunner({ publicKey: foreign.publicKey, workspaceId });
    runners.push(runner);

    const agent = await harness.seedAgent({
      workspaceId,
      tools: [seededTool('echo')],
      toolRunnerUrl: runner.url,
    });
    const session = await harness.seedSession(agent.agentId);

    // Cap iterations at 1 so a persistently-failing tool call terminates the run.
    const service = harness.createRunService({ maxToolIterations: 1 });
    harness.fake.setResponder(() => toolTurn('echo', { value: 'x' }));

    const { runId } = await service.start(
      { sessionId: session.sessionId, content: 'echo please' },
      { onEvent: () => {} },
    );

    const run = await harness.repos.runRepo.getById(runId);
    expect(run?.status).toBe('failed');

    const calls = await harness.repos.toolCallRepo.listByRun(runId);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.status).toBe('failed');
    expect(String(calls[0]!.output)).toMatch(/authorization|unauthorized|verification/i);
  });

  it('rejects an SSRF target and finalizes the run failed (SC-09)', async () => {
    const { workspaceId } = await harness.seedWorkspaceWithKey();

    // Cloud metadata endpoint — a link-local address the policy must block.
    const agent = await harness.seedAgent({
      workspaceId,
      tools: [seededTool('echo')],
      toolRunnerUrl: 'http://169.254.169.254/latest/meta-data',
    });
    const session = await harness.seedSession(agent.agentId);

    const service = harness.createRunService({ maxToolIterations: 1 });
    harness.fake.setResponder(() => toolTurn('echo', { value: 'x' }));

    const { runId } = await service.start(
      { sessionId: session.sessionId, content: 'reach metadata' },
      { onEvent: () => {} },
    );

    const run = await harness.repos.runRepo.getById(runId);
    expect(run?.status).toBe('failed');

    const calls = await harness.repos.toolCallRepo.listByRun(runId);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.status).toBe('failed');
    // The pre-send SSRF rejection message proves no request left for the target.
    expect(String(calls[0]!.output)).toMatch(/Disallowed runner target/i);
  });

  it('rejects oversized tool input before sending (SC-09)', async () => {
    const { workspaceId } = await harness.seedWorkspaceWithKey();
    const runner = await startFakeRunner({ publicKey: harness.keys.publicKey, workspaceId });
    runners.push(runner);

    const agent = await harness.seedAgent({
      workspaceId,
      tools: [seededTool('echo')],
      toolRunnerUrl: runner.url,
    });
    const session = await harness.seedSession(agent.agentId);

    const service = harness.createRunService({ maxToolIterations: 1 });
    // > 256 KiB input — bounded and rejected by the executor before any send.
    const huge = 'x'.repeat(300 * 1024);
    harness.fake.setResponder(() => toolTurn('echo', { data: huge }));

    const { runId } = await service.start(
      { sessionId: session.sessionId, content: 'too big' },
      { onEvent: () => {} },
    );

    const calls = await harness.repos.toolCallRepo.listByRun(runId);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.status).toBe('failed');
    expect(String(calls[0]!.output)).toMatch(/input exceeds limit/i);
    // Never dispatched — the runner was untouched.
    expect(runner.counter.value).toBe(0);
  });

  it('rejects an oversized runner response on parse (SC-09)', async () => {
    const { workspaceId } = await harness.seedWorkspaceWithKey();
    const runner = await startFakeRunner({ publicKey: harness.keys.publicKey, workspaceId });
    runners.push(runner);

    const agent = await harness.seedAgent({
      workspaceId,
      tools: [seededTool('big')],
      toolRunnerUrl: runner.url,
    });
    const session = await harness.seedSession(agent.agentId);

    const service = harness.createRunService({ maxToolIterations: 1 });
    harness.fake.setResponder(() => toolTurn('big', {}));

    const { runId } = await service.start(
      { sessionId: session.sessionId, content: 'send me a lot' },
      { onEvent: () => {} },
    );

    const calls = await harness.repos.toolCallRepo.listByRun(runId);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.status).toBe('failed');
    expect(String(calls[0]!.output)).toMatch(/response exceeds limit/i);
  });

  it('replays a retried tool call without re-executing it (SC-10)', async () => {
    const { workspaceId } = await harness.seedWorkspaceWithKey();

    // Reserve the proxy's port up front so the runner can scope its `aud` to the
    // proxy URL the agent registers (the token is minted for that URL).
    const proxyPort = await reserveFreePort();
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;

    const runner = await startFakeRunner({
      publicKey: harness.keys.publicKey,
      workspaceId,
      expectedAudience: proxyUrl,
    });
    runners.push(runner);

    // Fault-injecting proxy: attempt 1 forwards to the runner (which executes and
    // caches the result) but returns 500; attempt 2 (same idempotency key)
    // forwards again and the runner replays its CACHED result, which we pass
    // through. So the tool executes exactly once despite the transport retry.
    const runnerAddr = new URL(runner.url);
    let attempts = 0;
    const proxy = createHttpServer((clientReq, clientRes) => {
      const chunks: Buffer[] = [];
      clientReq.on('data', (c: Buffer) => chunks.push(c));
      clientReq.on('end', () => {
        const body = Buffer.concat(chunks);
        attempts += 1;
        const thisAttempt = attempts;
        const upstream = httpRequest(
          {
            hostname: runnerAddr.hostname,
            port: runnerAddr.port,
            path: clientReq.url,
            method: clientReq.method,
            headers: { ...clientReq.headers, host: runnerAddr.host },
          },
          (upRes) => {
            const upChunks: Buffer[] = [];
            upRes.on('data', (c: Buffer) => upChunks.push(c));
            upRes.on('end', () => {
              if (thisAttempt === 1) {
                // Runner already executed + cached; inject a retriable transport 500.
                clientRes.writeHead(500, { 'content-type': 'application/json' });
                clientRes.end(JSON.stringify({ version: '1', error: { code: 'INTERNAL', message: 'injected' } }));
              } else {
                clientRes.writeHead(upRes.statusCode ?? 200, { 'content-type': 'application/json' });
                clientRes.end(Buffer.concat(upChunks));
              }
            });
          },
        );
        upstream.on('error', () => {
          clientRes.writeHead(502).end();
        });
        upstream.end(body);
      });
    });
    await new Promise<void>((res) => proxy.listen(proxyPort, '127.0.0.1', () => res()));
    servers.push(proxy);

    const agent = await harness.seedAgent({
      workspaceId,
      tools: [seededTool('counter')],
      toolRunnerUrl: proxyUrl,
    });
    const session = await harness.seedSession(agent.agentId);

    const service = harness.createRunService();
    harness.fake.setResponder(byTurn(toolTurn('counter', {}), textTurn('counted')));

    const { runId } = await service.start(
      { sessionId: session.sessionId, content: 'count once' },
      { onEvent: () => {} },
    );

    const run = await harness.repos.runRepo.getById(runId);
    expect(run?.status).toBe('completed');

    // Two transport attempts, but the tool body executed exactly once.
    expect(attempts).toBe(2);
    expect(runner.counter.value).toBe(1);

    const calls = await harness.repos.toolCallRepo.listByRun(runId);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.status).toBe('completed');
    expect(calls[0]!.output).toEqual({ count: 1 });
  });
});
