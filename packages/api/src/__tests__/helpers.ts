import { createHash } from 'node:crypto';
import type { AgentRecord, ApiKeyRecord, SessionRecord, RunRecord, MessageRecord, ToolCallRecord, UserRecord, UserWorkspaceRecord, WorkspaceRecord } from '@swiftagent/shared';
import type { AgentRepo, ApiKeyRepo, SessionRepo, MessageRepo, RunRepo, ToolCallRepo, TraceRepo, TraceRecordRow, SpanRecordRow, UserRepo, UserWorkspaceRepo, WorkspaceRepo } from '@swiftagent/db';
import type { RunExecutionService } from '@swiftagent/runtime';
import { buildApp, type AppContext } from '../server.js';

/** Minimal no-op execution service for route tests that don't execute runs. */
export function createMockRunExecutionService(
  overrides: Partial<RunExecutionService> = {},
): RunExecutionService {
  return {
    start: async () => ({ runId: 'run_mockexec123456789' }),
    requestCancel: async () => ({ requested: true }),
    ...overrides,
  };
}

// ── Test API key ───────────────────────────────────────────────────
export const TEST_API_KEY = 'sk_test_1234567890abcdef';
export const TEST_API_KEY_HASH = createHash('sha256').update(TEST_API_KEY).digest('hex');
export const TEST_WORKSPACE_ID = 'ws_testworkspace123456';
export const TEST_API_KEY_ID = 'ak_testapikey12345678';
export const TEST_JWT_SECRET = 'test-jwt-secret-at-least-32-bytes-long';

// ── Seed data ──────────────────────────────────────────────────────
export const SEED_AGENT: AgentRecord = {
  agentId: 'agt_testagent1234567890',
  workspaceId: TEST_WORKSPACE_ID,
  name: 'test-agent',
  modelConfig: { model: 'openai/gpt-4' },
  systemPrompt: 'You are a test assistant.',
  memoryConfig: { strategy: 'last_n', maxMessages: 50 },
  tools: [],
  toolRunnerUrl: null,
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
};

export const SEED_SESSION: SessionRecord = {
  sessionId: 'ses_testsession123456',
  agentId: SEED_AGENT.agentId,
  userId: 'user_123',
  status: 'active',
  metadata: {},
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
};

export const SEED_RUN: RunRecord = {
  runId: 'run_testrun12345678901',
  sessionId: SEED_SESSION.sessionId,
  status: 'completed',
  model: 'openai/gpt-4',
  tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
};

export const SEED_MESSAGES: MessageRecord[] = [
  {
    messageId: 'msg_testmsg1234567890a',
    sessionId: SEED_SESSION.sessionId,
    runId: SEED_RUN.runId,
    role: 'user',
    content: 'Hello',
    createdAt: new Date('2025-01-01T00:00:00Z'),
  },
  {
    messageId: 'msg_testmsg1234567890b',
    sessionId: SEED_SESSION.sessionId,
    runId: SEED_RUN.runId,
    role: 'assistant',
    content: 'Hi there!',
    createdAt: new Date('2025-01-01T00:01:00Z'),
  },
];

export const SEED_TOOL_CALLS: ToolCallRecord[] = [
  {
    callId: 'tc_testtoolcall1234567',
    runId: SEED_RUN.runId,
    toolName: 'lookupOrder',
    input: { orderId: '123' },
    output: { order: { id: '123', status: 'shipped' } },
    status: 'completed',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
  },
];

// ── Mock repos ─────────────────────────────────────────────────────
export function createMockApiKeyRepo(): ApiKeyRepo {
  const validKey: ApiKeyRecord = {
    apiKeyId: TEST_API_KEY_ID,
    workspaceId: TEST_WORKSPACE_ID,
    keyHash: TEST_API_KEY_HASH,
    name: 'test-key',
    createdAt: new Date(),
    revokedAt: null,
  };

  return {
    create: async () => validKey,
    getByKeyHash: async (hash: string) => (hash === TEST_API_KEY_HASH ? validKey : null),
    listByWorkspace: async () => [validKey],
    revoke: async () => ({ ...validKey, revokedAt: new Date() }),
  };
}

export function createMockAgentRepo(): AgentRepo {
  const agents = new Map<string, AgentRecord>();
  agents.set(SEED_AGENT.agentId, SEED_AGENT);

  return {
    create: async (record) => {
      const agent: AgentRecord = {
        agentId: record.agentId,
        workspaceId: record.workspaceId,
        name: record.name,
        modelConfig: record.modelConfig,
        systemPrompt: record.systemPrompt,
        memoryConfig: record.memoryConfig,
        tools: record.tools ?? [],
        toolRunnerUrl: record.toolRunnerUrl ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      agents.set(agent.agentId, agent);
      return agent;
    },
    getById: async (id) => agents.get(id) ?? null,
    getByWorkspaceId: async (wsId) => [...agents.values()].filter((a) => a.workspaceId === wsId),
    getByName: async (wsId, name) =>
      [...agents.values()].find((a) => a.workspaceId === wsId && a.name === name) ?? null,
    update: async (id, updates) => {
      const existing = agents.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...updates, updatedAt: new Date() };
      agents.set(id, updated);
      return updated;
    },
  };
}

export function createMockSessionRepo(): SessionRepo {
  const sessionsMap = new Map<string, SessionRecord>();
  sessionsMap.set(SEED_SESSION.sessionId, SEED_SESSION);

  return {
    create: async (record) => {
      const session: SessionRecord = {
        sessionId: record.sessionId,
        agentId: record.agentId,
        userId: record.userId ?? null,
        status: 'active',
        metadata: record.metadata ?? {},
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      sessionsMap.set(session.sessionId, session);
      return session;
    },
    getById: async (id) => sessionsMap.get(id) ?? null,
    updateStatus: async (id, status) => {
      const s = sessionsMap.get(id);
      if (!s) return null;
      const updated = { ...s, status, updatedAt: new Date() };
      sessionsMap.set(id, updated);
      return updated;
    },
    listByAgent: async () => [...sessionsMap.values()],
    listByUser: async () => [...sessionsMap.values()],
  };
}

export function createMockMessageRepo(): MessageRepo {
  return {
    create: async (record) => ({
      messageId: record.messageId,
      sessionId: record.sessionId,
      runId: record.runId ?? null,
      role: record.role,
      content: record.content,
      createdAt: new Date(),
    }),
    createBatch: async (records) =>
      records.map((r) => ({
        messageId: r.messageId,
        sessionId: r.sessionId,
        runId: r.runId ?? null,
        role: r.role,
        content: r.content,
        createdAt: new Date(),
      })),
    listBySession: async (sessionId) =>
      SEED_MESSAGES.filter((m) => m.sessionId === sessionId),
    listByRun: async (runId) =>
      SEED_MESSAGES.filter((m) => m.runId === runId),
    getLastN: async (sessionId, n) =>
      SEED_MESSAGES.filter((m) => m.sessionId === sessionId).slice(-n),
  };
}

export function createMockRunRepo(): RunRepo {
  const runsMap = new Map<string, RunRecord>();
  runsMap.set(SEED_RUN.runId, SEED_RUN);

  return {
    create: async (record) => {
      const run: RunRecord = {
        runId: record.runId,
        sessionId: record.sessionId,
        status: 'running',
        model: record.model,
        tokenUsage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      runsMap.set(run.runId, run);
      return run;
    },
    getById: async (id) => runsMap.get(id) ?? null,
    updateStatus: async (id, status) => {
      const r = runsMap.get(id);
      if (!r) return null;
      const updated = { ...r, status, updatedAt: new Date() };
      runsMap.set(id, updated);
      return updated;
    },
    complete: async (id, tokenUsage) => {
      const r = runsMap.get(id);
      if (!r) return null;
      const updated = { ...r, status: 'completed' as const, tokenUsage, updatedAt: new Date() };
      runsMap.set(id, updated);
      return updated;
    },
    fail: async (id) => {
      const r = runsMap.get(id);
      if (!r) return null;
      const updated = { ...r, status: 'failed' as const, updatedAt: new Date() };
      runsMap.set(id, updated);
      return updated;
    },
    cancel: async (id) => {
      const r = runsMap.get(id);
      if (!r) return null;
      const updated = { ...r, status: 'cancelled' as const, updatedAt: new Date() };
      runsMap.set(id, updated);
      return updated;
    },
    timeout: async (id) => {
      const r = runsMap.get(id);
      if (!r) return null;
      const updated = { ...r, status: 'timed_out' as const, updatedAt: new Date() };
      runsMap.set(id, updated);
      return updated;
    },
    listBySession: async (sessionId) =>
      [...runsMap.values()].filter((r) => r.sessionId === sessionId),
  };
}

export function createMockToolCallRepo(): ToolCallRepo {
  return {
    create: async (record) => ({
      callId: record.callId,
      runId: record.runId,
      toolName: record.toolName,
      input: record.input,
      output: null,
      status: 'started' as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    updateResult: async (callId, output, status = 'completed') => ({
      callId,
      runId: 'run_test',
      toolName: 'test',
      input: {},
      output,
      status,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    fail: async (callId) => ({
      callId,
      runId: 'run_test',
      toolName: 'test',
      input: {},
      output: null,
      status: 'failed' as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    listByRun: async (runId) =>
      SEED_TOOL_CALLS.filter((tc) => tc.runId === runId),
  };
}

export function createMockTraceRepo(): TraceRepo {
  const tracesMap = new Map<string, TraceRecordRow>();
  const spansMap = new Map<string, SpanRecordRow[]>();

  return {
    saveTrace: async (trace) => {
      tracesMap.set(trace.traceId, trace);
    },
    saveSpans: async (spans) => {
      if (spans.length === 0) return;
      const traceId = spans[0]?.traceId;
      if (!traceId) return;
      const existing = spansMap.get(traceId) ?? [];
      spansMap.set(traceId, [...existing, ...spans]);
    },
    saveTraceWithSpans: async (trace, spans) => {
      tracesMap.set(trace.traceId, trace);
      if (spans.length > 0) {
        const existing = spansMap.get(trace.traceId) ?? [];
        spansMap.set(trace.traceId, [...existing, ...spans]);
      }
    },
    getTraceByRunId: async (runId) => {
      for (const trace of tracesMap.values()) {
        if (trace.runId === runId) return trace;
      }
      return null;
    },
    getTraceById: async (traceId) => tracesMap.get(traceId) ?? null,
    listSpansByTraceId: async (traceId) => {
      const spans = spansMap.get(traceId) ?? [];
      return spans.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    },
  };
}

export function createMockUserRepo(): UserRepo {
  const users = new Map<string, UserRecord>();

  return {
    create: async (record) => {
      const user: UserRecord = {
        userId: record.userId,
        cognitoSub: record.cognitoSub,
        email: record.email,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      users.set(record.cognitoSub, user);
      return user;
    },
    getByCognitoSub: async (cognitoSub) => users.get(cognitoSub) ?? null,
    getById: async (userId) =>
      [...users.values()].find((u) => u.userId === userId) ?? null,
  };
}

export function createMockUserWorkspaceRepo(): UserWorkspaceRepo {
  const memberships: UserWorkspaceRecord[] = [];

  return {
    create: async (record) => {
      const membership: UserWorkspaceRecord = {
        userId: record.userId,
        workspaceId: record.workspaceId,
        role: record.role as 'owner' | 'member',
        createdAt: new Date(),
      };
      memberships.push(membership);
      return membership;
    },
    listByUserId: async (userId) =>
      memberships.filter((m) => m.userId === userId),
    getByUserAndWorkspace: async (userId, workspaceId) =>
      memberships.find((m) => m.userId === userId && m.workspaceId === workspaceId) ?? null,
    isMember: async (userId, workspaceId) =>
      memberships.some((m) => m.userId === userId && m.workspaceId === workspaceId),
  };
}

export function createMockWorkspaceRepo(): WorkspaceRepo {
  const workspaces = new Map<string, WorkspaceRecord>();

  return {
    create: async (record) => {
      const workspace: WorkspaceRecord = {
        workspaceId: record.workspaceId,
        name: record.name,
        createdAt: new Date(),
      };
      workspaces.set(record.workspaceId, workspace);
      return workspace;
    },
    getById: async (id) => workspaces.get(id) ?? null,
    getByName: async (name) =>
      [...workspaces.values()].find((w) => w.name === name) ?? null,
  };
}

// ── Build test app ─────────────────────────────────────────────────
export async function buildTestApp(
  runExecutionService: RunExecutionService = createMockRunExecutionService(),
): Promise<AppContext> {
  return buildApp({
    runExecutionService,
    repos: {
      apiKeyRepo: createMockApiKeyRepo(),
      agentRepo: createMockAgentRepo(),
      sessionRepo: createMockSessionRepo(),
      messageRepo: createMockMessageRepo(),
      runRepo: createMockRunRepo(),
      toolCallRepo: createMockToolCallRepo(),
      traceRepo: createMockTraceRepo(),
      userRepo: createMockUserRepo(),
      userWorkspaceRepo: createMockUserWorkspaceRepo(),
      workspaceRepo: createMockWorkspaceRepo(),
    },
    jwtSecret: TEST_JWT_SECRET,
    publicWebsocketUrl: 'ws://localhost:3001',
    logger: false,
  });
}
