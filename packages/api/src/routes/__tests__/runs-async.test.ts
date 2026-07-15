import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { MessageRecord } from '@swiftagent/shared';
import type { MessageRepo } from '@swiftagent/db';
import { createRunExecutionService } from '@swiftagent/runtime';
import type { AgentEngineDeps } from '@swiftagent/runtime';
import { buildApp } from '../../server.js';
import {
  TEST_API_KEY,
  TEST_WORKSPACE_ID,
  SEED_SESSION,
  SEED_AGENT,
  createMockApiKeyRepo,
  createMockAgentRepo,
  createMockSessionRepo,
  createMockRunRepo,
  createMockToolCallRepo,
  createMockTraceRepo,
  createMockUserRepo,
  createMockUserWorkspaceRepo,
  createMockWorkspaceRepo,
  TEST_JWT_SECRET,
} from '../../__tests__/helpers.js';

const headers = { authorization: `Bearer ${TEST_API_KEY}` };

/** Stateful message repo so created messages are observable + queryable. */
function createStatefulMessageRepo(): { repo: MessageRepo; store: MessageRecord[] } {
  const store: MessageRecord[] = [];
  type CreateInput = { messageId: string; sessionId: string; runId?: string | null; role: MessageRecord['role']; content: string };
  const toRecord = (r: CreateInput): MessageRecord => ({
    messageId: r.messageId,
    sessionId: r.sessionId,
    runId: r.runId ?? null,
    role: r.role,
    content: r.content,
    createdAt: new Date(),
  });
  const repo = {
    create: async (record: CreateInput) => {
      const msg = toRecord(record);
      store.push(msg);
      return msg;
    },
    createBatch: async (records: CreateInput[]) => records.map(toRecord),
    listBySession: async (sessionId: string) => store.filter((m) => m.sessionId === sessionId),
    listByRun: async (runId: string) => store.filter((m) => m.runId === runId),
    getLastN: async (sessionId: string, n: number) => store.filter((m) => m.sessionId === sessionId).slice(-n),
  } as unknown as MessageRepo;
  return { repo, store };
}

type ProviderBehavior = { gate?: Promise<void> };

/** Fake model provider: streams one token then finishes, optionally blocking on
 *  a gate first (to hold a run in-flight for conflict/cancel tests). */
function fakeRegistry(behavior: ProviderBehavior = {}): AgentEngineDeps['modelRegistry'] {
  const provider = {
    async *generate() {
      yield { type: 'token', text: 'Hello' };
      if (behavior.gate) await behavior.gate;
      yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    },
  };
  return {
    resolveForModel: () => ({ provider, modelId: 'gpt-4' }),
  } as unknown as AgentEngineDeps['modelRegistry'];
}

interface Harness {
  app: FastifyInstance;
  messages: MessageRecord[];
  agentRepo: ReturnType<typeof createMockAgentRepo>;
  sessionRepo: ReturnType<typeof createMockSessionRepo>;
  runRepo: ReturnType<typeof createMockRunRepo>;
}

async function setup(behavior: ProviderBehavior = {}): Promise<Harness> {
  const apiKeyRepo = createMockApiKeyRepo();
  const agentRepo = createMockAgentRepo();
  const sessionRepo = createMockSessionRepo();
  const runRepo = createMockRunRepo();
  const toolCallRepo = createMockToolCallRepo();
  const traceRepo = createMockTraceRepo();
  const { repo: messageRepo, store: messages } = createStatefulMessageRepo();

  const deps: AgentEngineDeps = {
    db: {
      messages: messageRepo,
      runs: runRepo,
      toolCalls: toolCallRepo,
      sessions: sessionRepo,
      agents: agentRepo,
    },
    modelRegistry: fakeRegistry(behavior),
    toolExecutorResolver: {
      resolve: async () => ({ execute: async () => ({ ok: true as const, output: 'ok' }) }),
    },
  };

  const runExecutionService = createRunExecutionService(deps);

  const ctx = await buildApp({
    runExecutionService,
    repos: {
      apiKeyRepo,
      agentRepo,
      sessionRepo,
      messageRepo,
      runRepo,
      toolCallRepo,
      traceRepo,
      userRepo: createMockUserRepo(),
      userWorkspaceRepo: createMockUserWorkspaceRepo(),
      workspaceRepo: createMockWorkspaceRepo(),
    },
    jwtSecret: TEST_JWT_SECRET,
    logger: false,
  });

  return { app: ctx.app, messages, agentRepo, sessionRepo, runRepo };
}

async function pollRunStatus(app: FastifyInstance, runId: string, target: string, tries = 50): Promise<string> {
  for (let i = 0; i < tries; i++) {
    const res = await app.inject({ method: 'GET', url: `/v1/runs/${runId}`, headers });
    const status = res.json().status;
    if (status === target) return status;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Run ${runId} never reached ${target}`);
}

describe('Async run execution (WS-23)', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.map((a) => a.close()));
    apps.length = 0;
  });

  async function harness(behavior?: ProviderBehavior): Promise<Harness> {
    const h = await setup(behavior);
    apps.push(h.app);
    return h;
  }

  it('POST returns 202 and executes without a WebSocket, observable via GET (SC-11)', async () => {
    const { app, messages } = await harness();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${SEED_SESSION.sessionId}/runs`,
      headers,
      payload: { content: 'Hello, agent!' },
    });
    expect(res.statusCode).toBe(202);
    const { runId, status } = res.json();
    expect(runId).toMatch(/^run_/);
    expect(status).toBe('running');

    const terminal = await pollRunStatus(app, runId, 'completed');
    expect(terminal).toBe('completed');

    // An assistant message was persisted, without any WebSocket connection.
    expect(messages.some((m) => m.role === 'assistant' && m.runId === runId)).toBe(true);
  });

  it('creates exactly one run record + one user message per logical run (SC-12)', async () => {
    const { app, messages, runRepo } = await harness();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${SEED_SESSION.sessionId}/runs`,
      headers,
      payload: { content: 'unique-parity-content' },
    });
    const { runId } = res.json();
    await pollRunStatus(app, runId, 'completed');

    const userMsgs = messages.filter((m) => m.role === 'user' && m.content === 'unique-parity-content');
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0].runId).toBe(runId);

    const runsForSession = await runRepo.listBySession(SEED_SESSION.sessionId);
    expect(runsForSession.filter((r) => r.runId === runId)).toHaveLength(1);
  });

  it('GET /runs/:runId/tool-calls is observable after a run (SC-11)', async () => {
    const { app } = await harness();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${SEED_SESSION.sessionId}/runs`,
      headers,
      payload: { content: 'observe me' },
    });
    const { runId } = res.json();
    await pollRunStatus(app, runId, 'completed');

    const tc = await app.inject({ method: 'GET', url: `/v1/runs/${runId}/tool-calls`, headers });
    expect(tc.statusCode).toBe(200);
    expect(Array.isArray(tc.json().data)).toBe(true);
  });

  it('POST /runs/:runId/cancel is idempotent — repeated + post-terminal calls all 202 (SC-11)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { app } = await harness({ gate });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${SEED_SESSION.sessionId}/runs`,
      headers,
      payload: { content: 'cancel me' },
    });
    const { runId } = res.json();

    const c1 = await app.inject({ method: 'POST', url: `/v1/runs/${runId}/cancel`, headers });
    const c2 = await app.inject({ method: 'POST', url: `/v1/runs/${runId}/cancel`, headers });
    expect(c1.statusCode).toBe(202);
    expect(c2.statusCode).toBe(202);
    expect(c1.json()).toMatchObject({ runId, status: 'cancelling' });

    release();
    // WS-24: a cancelled run settles to the terminal `cancelled` state (SC-13),
    // no longer `failed`.
    await pollRunStatus(app, runId, 'cancelled');

    const c3 = await app.inject({ method: 'POST', url: `/v1/runs/${runId}/cancel`, headers });
    expect(c3.statusCode).toBe(202);
  });

  it('concurrent run on the same session returns 409 (shared session lock)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { app } = await harness({ gate });

    const first = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${SEED_SESSION.sessionId}/runs`,
      headers,
      payload: { content: 'first' },
    });
    expect(first.statusCode).toBe(202);

    const second = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${SEED_SESSION.sessionId}/runs`,
      headers,
      payload: { content: 'second' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('CONFLICT');

    release();
    await pollRunStatus(app, first.json().runId, 'completed');
  });

  describe('workspace ownership (returns 404 without leaking existence)', () => {
    async function seedForeignRun(h: Harness): Promise<string> {
      const foreignAgent = await h.agentRepo.create({
        agentId: 'agt_foreignxxxxxxxxxxxxx',
        workspaceId: 'ws_otherworkspacexxxxx',
        name: 'foreign',
        modelConfig: { model: 'openai/gpt-4' },
        systemPrompt: 'x',
        memoryConfig: SEED_AGENT.memoryConfig,
        tools: [],
        toolRunnerUrl: null,
      });
      const foreignSession = await h.sessionRepo.create({
        sessionId: 'ses_foreignxxxxxxxxxxxx',
        agentId: foreignAgent.agentId,
        userId: null,
        metadata: {},
      });
      const foreignRun = await h.runRepo.create({
        runId: 'run_foreignxxxxxxxxxxxx',
        sessionId: foreignSession.sessionId,
        model: 'openai/gpt-4',
      });
      return foreignRun.runId;
    }

    it('GET /runs/:runId → 404 for a run in another workspace', async () => {
      const h = await harness();
      const foreignRunId = await seedForeignRun(h);
      const res = await h.app.inject({ method: 'GET', url: `/v1/runs/${foreignRunId}`, headers });
      expect(res.statusCode).toBe(404);
    });

    it('GET /runs/:runId/tool-calls → 404 for a foreign run', async () => {
      const h = await harness();
      const foreignRunId = await seedForeignRun(h);
      const res = await h.app.inject({ method: 'GET', url: `/v1/runs/${foreignRunId}/tool-calls`, headers });
      expect(res.statusCode).toBe(404);
    });

    it('POST /runs/:runId/cancel → 404 for a foreign run', async () => {
      const h = await harness();
      const foreignRunId = await seedForeignRun(h);
      const res = await h.app.inject({ method: 'POST', url: `/v1/runs/${foreignRunId}/cancel`, headers });
      expect(res.statusCode).toBe(404);
    });

    it('GET /runs/:runId/trace → 404 for a foreign run', async () => {
      const h = await harness();
      const foreignRunId = await seedForeignRun(h);
      const res = await h.app.inject({ method: 'GET', url: `/v1/runs/${foreignRunId}/trace`, headers });
      expect(res.statusCode).toBe(404);
    });

    it('workspace-owned run reports current status (no leak, positive case)', async () => {
      const { app } = await harness();
      const res = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${SEED_SESSION.sessionId}/runs`,
        headers,
        payload: { content: 'mine' },
      });
      const { runId } = res.json();
      const get = await app.inject({ method: 'GET', url: `/v1/runs/${runId}`, headers });
      expect(get.statusCode).toBe(200);
      expect(get.json().runId).toBe(runId);
    });
  });

  it('does not leak: TEST workspace agent is the owner', () => {
    // Guard against accidental cross-wiring of the seed workspace id.
    expect(SEED_AGENT.workspaceId).toBe(TEST_WORKSPACE_ID);
  });
});
