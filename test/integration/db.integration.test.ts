import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  generateWorkspaceId,
  generateApiKeyId,
  generateAgentId,
  generateSessionId,
  generateRunId,
  generateMessageId,
  generateToolCallId,
  generateUserId,
} from '@swiftagent/shared';
import type { ModelConfig, MemoryConfig, TokenUsage } from '@swiftagent/shared';
import {
  createDbClient,
  createWorkspaceRepo,
  createApiKeyRepo,
  createAgentRepo,
  createSessionRepo,
  createMessageRepo,
  createRunRepo,
  createToolCallRepo,
  createUserRepo,
  createUserWorkspaceRepo,
} from '@swiftagent/db';
import type { Db } from '@swiftagent/db';

let db: Db;
let close: () => Promise<void>;

// Shared test fixtures
const modelConfig: ModelConfig = { model: 'anthropic/claude-sonnet', temperature: 0.7 };
const memoryConfig: MemoryConfig = { strategy: 'last_n', maxMessages: 50 };

beforeAll(() => {
  const databaseUrl = process.env['DATABASE_URL'];
  expect(databaseUrl).toBeDefined();
  const client = createDbClient(databaseUrl!);
  db = client.db;
  close = client.close;
});

afterAll(async () => {
  await close();
});

// Helper to create prerequisite workspace
async function seedWorkspace() {
  const repo = createWorkspaceRepo(db);
  return repo.create({ workspaceId: generateWorkspaceId(), name: `ws-${Date.now()}` });
}

// Helper to create prerequisite agent
async function seedAgent(workspaceId: string) {
  const repo = createAgentRepo(db);
  return repo.create({
    agentId: generateAgentId(),
    workspaceId,
    name: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    modelConfig,
    systemPrompt: 'Test system prompt',
    memoryConfig,
  });
}

// Helper to create prerequisite session
async function seedSession(agentId: string) {
  const repo = createSessionRepo(db);
  return repo.create({
    sessionId: generateSessionId(),
    agentId,
    userId: 'test-user',
    metadata: { source: 'test' },
  });
}

// Helper to create prerequisite run
async function seedRun(sessionId: string) {
  const repo = createRunRepo(db);
  return repo.create({
    runId: generateRunId(),
    sessionId,
    model: 'anthropic/claude-sonnet',
  });
}

describe('WorkspaceRepo', () => {
  it('creates and retrieves a workspace by id', async () => {
    const repo = createWorkspaceRepo(db);
    const id = generateWorkspaceId();
    const created = await repo.create({ workspaceId: id, name: 'Test Workspace' });

    expect(created.workspaceId).toBe(id);
    expect(created.name).toBe('Test Workspace');
    expect(created.createdAt).toBeInstanceOf(Date);

    const fetched = await repo.getById(id);
    expect(fetched).not.toBeNull();
    expect(fetched!.workspaceId).toBe(id);
  });

  it('retrieves a workspace by name', async () => {
    const repo = createWorkspaceRepo(db);
    const name = `ws-name-${Date.now()}`;
    await repo.create({ workspaceId: generateWorkspaceId(), name });

    const fetched = await repo.getByName(name);
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe(name);
  });

  it('returns null for non-existent workspace', async () => {
    const repo = createWorkspaceRepo(db);
    const fetched = await repo.getById('ws_nonexistent');
    expect(fetched).toBeNull();
  });
});

describe('ApiKeyRepo', () => {
  it('creates and retrieves by key hash', async () => {
    const workspace = await seedWorkspace();
    const repo = createApiKeyRepo(db);
    const hash = `hash_${Date.now()}`;

    const created = await repo.create({
      apiKeyId: generateApiKeyId(),
      workspaceId: workspace.workspaceId,
      keyHash: hash,
      name: 'Test Key',
    });

    expect(created.keyHash).toBe(hash);
    expect(created.revokedAt).toBeNull();

    const fetched = await repo.getByKeyHash(hash);
    expect(fetched).not.toBeNull();
    expect(fetched!.workspaceId).toBe(workspace.workspaceId);
  });

  it('lists keys by workspace', async () => {
    const workspace = await seedWorkspace();
    const repo = createApiKeyRepo(db);

    await repo.create({
      apiKeyId: generateApiKeyId(),
      workspaceId: workspace.workspaceId,
      keyHash: `h1_${Date.now()}`,
      name: 'Key 1',
    });
    await repo.create({
      apiKeyId: generateApiKeyId(),
      workspaceId: workspace.workspaceId,
      keyHash: `h2_${Date.now()}`,
      name: 'Key 2',
    });

    const keys = await repo.listByWorkspace(workspace.workspaceId);
    expect(keys).toHaveLength(2);
  });

  it('revokes a key', async () => {
    const workspace = await seedWorkspace();
    const repo = createApiKeyRepo(db);
    const created = await repo.create({
      apiKeyId: generateApiKeyId(),
      workspaceId: workspace.workspaceId,
      keyHash: `revoke_${Date.now()}`,
      name: 'Revokable Key',
    });

    const revoked = await repo.revoke(created.apiKeyId);
    expect(revoked).not.toBeNull();
    expect(revoked!.revokedAt).toBeInstanceOf(Date);
  });
});

describe('AgentRepo', () => {
  it('creates and fetches by id', async () => {
    const workspace = await seedWorkspace();
    const repo = createAgentRepo(db);

    const created = await repo.create({
      agentId: generateAgentId(),
      workspaceId: workspace.workspaceId,
      name: 'test-agent',
      modelConfig,
      systemPrompt: 'You are helpful.',
      memoryConfig,
    });

    expect(created.modelConfig).toEqual(modelConfig);
    expect(created.memoryConfig).toEqual(memoryConfig);
    expect(created.toolRunnerUrl).toBeNull();

    const fetched = await repo.getById(created.agentId);
    expect(fetched).not.toBeNull();
    expect(fetched!.modelConfig).toEqual(modelConfig);
  });

  it('JSONB round-trip for modelConfig and memoryConfig', async () => {
    const workspace = await seedWorkspace();
    const repo = createAgentRepo(db);

    const config: ModelConfig = { model: 'openai/gpt-4', temperature: 0.5, maxTokens: 1000 };
    const mem: MemoryConfig = { strategy: 'summary' };

    const created = await repo.create({
      agentId: generateAgentId(),
      workspaceId: workspace.workspaceId,
      name: 'jsonb-test',
      modelConfig: config,
      systemPrompt: 'Test',
      memoryConfig: mem,
    });

    const fetched = await repo.getById(created.agentId);
    expect(fetched!.modelConfig).toEqual(config);
    expect(fetched!.memoryConfig).toEqual(mem);
  });

  it('toolRunnerUrl nullable round-trip', async () => {
    const workspace = await seedWorkspace();
    const repo = createAgentRepo(db);

    // Create with toolRunnerUrl
    const withUrl = await repo.create({
      agentId: generateAgentId(),
      workspaceId: workspace.workspaceId,
      name: 'with-url',
      modelConfig,
      systemPrompt: 'Test',
      memoryConfig,
      toolRunnerUrl: 'https://example.com/tools',
    });
    expect(withUrl.toolRunnerUrl).toBe('https://example.com/tools');

    // Update to null
    const updated = await repo.update(withUrl.agentId, { toolRunnerUrl: null });
    expect(updated!.toolRunnerUrl).toBeNull();

    // Verify persisted
    const fetched = await repo.getById(withUrl.agentId);
    expect(fetched!.toolRunnerUrl).toBeNull();
  });

  it('fetches by workspace and name', async () => {
    const workspace = await seedWorkspace();
    const repo = createAgentRepo(db);

    await repo.create({
      agentId: generateAgentId(),
      workspaceId: workspace.workspaceId,
      name: 'named-agent',
      modelConfig,
      systemPrompt: 'Test',
      memoryConfig,
    });

    const byWorkspace = await repo.getByWorkspaceId(workspace.workspaceId);
    expect(byWorkspace).toHaveLength(1);

    const byName = await repo.getByName(workspace.workspaceId, 'named-agent');
    expect(byName).not.toBeNull();
    expect(byName!.name).toBe('named-agent');
  });

  it('update modifies fields and bumps updatedAt', async () => {
    const workspace = await seedWorkspace();
    const repo = createAgentRepo(db);

    const created = await repo.create({
      agentId: generateAgentId(),
      workspaceId: workspace.workspaceId,
      name: 'update-test',
      modelConfig,
      systemPrompt: 'Original',
      memoryConfig,
    });

    const updated = await repo.update(created.agentId, {
      systemPrompt: 'Updated prompt',
    });

    expect(updated!.systemPrompt).toBe('Updated prompt');
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
  });
});

describe('SessionRepo', () => {
  it('creates and retrieves a session', async () => {
    const workspace = await seedWorkspace();
    const agent = await seedAgent(workspace.workspaceId);
    const repo = createSessionRepo(db);

    const created = await repo.create({
      sessionId: generateSessionId(),
      agentId: agent.agentId,
      userId: 'user-1',
      metadata: { org: 'test-org' },
    });

    expect(created.status).toBe('active');
    expect(created.metadata).toEqual({ org: 'test-org' });

    const fetched = await repo.getById(created.sessionId);
    expect(fetched).not.toBeNull();
    expect(fetched!.userId).toBe('user-1');
  });

  it('updates status', async () => {
    const workspace = await seedWorkspace();
    const agent = await seedAgent(workspace.workspaceId);
    const repo = createSessionRepo(db);

    const session = await repo.create({
      sessionId: generateSessionId(),
      agentId: agent.agentId,
    });

    const closed = await repo.updateStatus(session.sessionId, 'closed');
    expect(closed!.status).toBe('closed');
  });

  it('lists by agent with pagination', async () => {
    const workspace = await seedWorkspace();
    const agent = await seedAgent(workspace.workspaceId);
    const repo = createSessionRepo(db);

    for (let i = 0; i < 5; i++) {
      await repo.create({ sessionId: generateSessionId(), agentId: agent.agentId });
    }

    const all = await repo.listByAgent(agent.agentId);
    expect(all).toHaveLength(5);

    const page = await repo.listByAgent(agent.agentId, { limit: 2, offset: 0 });
    expect(page).toHaveLength(2);
  });

  it('lists by user', async () => {
    const workspace = await seedWorkspace();
    const agent = await seedAgent(workspace.workspaceId);
    const repo = createSessionRepo(db);
    const userId = `user-${Date.now()}`;

    await repo.create({ sessionId: generateSessionId(), agentId: agent.agentId, userId });
    await repo.create({ sessionId: generateSessionId(), agentId: agent.agentId, userId });

    const results = await repo.listByUser(userId);
    expect(results).toHaveLength(2);
  });
});

describe('MessageRepo', () => {
  it('creates a single message', async () => {
    const workspace = await seedWorkspace();
    const agent = await seedAgent(workspace.workspaceId);
    const session = await seedSession(agent.agentId);
    const repo = createMessageRepo(db);

    const msg = await repo.create({
      messageId: generateMessageId(),
      sessionId: session.sessionId,
      role: 'user',
      content: 'Hello!',
    });

    expect(msg.role).toBe('user');
    expect(msg.content).toBe('Hello!');
    expect(msg.runId).toBeNull();
  });

  it('createBatch atomically inserts multiple messages', async () => {
    const workspace = await seedWorkspace();
    const agent = await seedAgent(workspace.workspaceId);
    const session = await seedSession(agent.agentId);
    const repo = createMessageRepo(db);

    const batch = await repo.createBatch([
      { messageId: generateMessageId(), sessionId: session.sessionId, role: 'user', content: 'Q1' },
      { messageId: generateMessageId(), sessionId: session.sessionId, role: 'assistant', content: 'A1' },
      { messageId: generateMessageId(), sessionId: session.sessionId, role: 'user', content: 'Q2' },
    ]);

    expect(batch).toHaveLength(3);

    const all = await repo.listBySession(session.sessionId);
    expect(all).toHaveLength(3);
  });

  it('listBySession returns messages ordered by createdAt ascending', async () => {
    const workspace = await seedWorkspace();
    const agent = await seedAgent(workspace.workspaceId);
    const session = await seedSession(agent.agentId);
    const repo = createMessageRepo(db);

    // Insert messages with slight delay to ensure ordering
    for (let i = 0; i < 3; i++) {
      await repo.create({
        messageId: generateMessageId(),
        sessionId: session.sessionId,
        role: 'user',
        content: `msg-${i}`,
      });
    }

    const messages = await repo.listBySession(session.sessionId);
    expect(messages).toHaveLength(3);
    for (let i = 1; i < messages.length; i++) {
      expect(messages[i]!.createdAt.getTime()).toBeGreaterThanOrEqual(
        messages[i - 1]!.createdAt.getTime(),
      );
    }
  });

  it('getLastN returns correct slice in ascending order', async () => {
    const workspace = await seedWorkspace();
    const agent = await seedAgent(workspace.workspaceId);
    const session = await seedSession(agent.agentId);
    const repo = createMessageRepo(db);

    for (let i = 0; i < 5; i++) {
      await repo.create({
        messageId: generateMessageId(),
        sessionId: session.sessionId,
        role: 'user',
        content: `msg-${i}`,
      });
    }

    const last2 = await repo.getLastN(session.sessionId, 2);
    expect(last2).toHaveLength(2);
    expect(last2[0]!.content).toBe('msg-3');
    expect(last2[1]!.content).toBe('msg-4');
  });

  it('listByRun filters by runId', async () => {
    const workspace = await seedWorkspace();
    const agent = await seedAgent(workspace.workspaceId);
    const session = await seedSession(agent.agentId);
    const run = await seedRun(session.sessionId);
    const repo = createMessageRepo(db);

    await repo.create({
      messageId: generateMessageId(),
      sessionId: session.sessionId,
      runId: run.runId,
      role: 'assistant',
      content: 'Run message',
    });
    await repo.create({
      messageId: generateMessageId(),
      sessionId: session.sessionId,
      role: 'user',
      content: 'No run',
    });

    const runMessages = await repo.listByRun(run.runId);
    expect(runMessages).toHaveLength(1);
    expect(runMessages[0]!.content).toBe('Run message');
  });

  it('createBatch returns empty array for empty input', async () => {
    const repo = createMessageRepo(db);
    const result = await repo.createBatch([]);
    expect(result).toEqual([]);
  });
});

describe('RunRepo', () => {
  it('creates a run with default status running', async () => {
    const workspace = await seedWorkspace();
    const agent = await seedAgent(workspace.workspaceId);
    const session = await seedSession(agent.agentId);
    const repo = createRunRepo(db);

    const run = await repo.create({
      runId: generateRunId(),
      sessionId: session.sessionId,
      model: 'anthropic/claude-sonnet',
    });

    expect(run.status).toBe('running');
    expect(run.tokenUsage).toBeNull();
  });

  it('transitions running → completed with tokenUsage', async () => {
    const workspace = await seedWorkspace();
    const agent = await seedAgent(workspace.workspaceId);
    const session = await seedSession(agent.agentId);
    const repo = createRunRepo(db);

    const run = await repo.create({
      runId: generateRunId(),
      sessionId: session.sessionId,
      model: 'anthropic/claude-sonnet',
    });

    const usage: TokenUsage = { inputTokens: 100, outputTokens: 200, totalTokens: 300 };
    const completed = await repo.complete(run.runId, usage);
    expect(completed!.status).toBe('completed');
    expect(completed!.tokenUsage).toEqual(usage);

    // Verify JSONB round-trip
    const fetched = await repo.getById(run.runId);
    expect(fetched!.tokenUsage).toEqual(usage);
  });

  it('transitions running → failed', async () => {
    const workspace = await seedWorkspace();
    const agent = await seedAgent(workspace.workspaceId);
    const session = await seedSession(agent.agentId);
    const repo = createRunRepo(db);

    const run = await repo.create({
      runId: generateRunId(),
      sessionId: session.sessionId,
      model: 'openai/gpt-4',
    });

    const failed = await repo.fail(run.runId);
    expect(failed!.status).toBe('failed');
  });

  it('listBySession orders by createdAt desc', async () => {
    const workspace = await seedWorkspace();
    const agent = await seedAgent(workspace.workspaceId);
    const session = await seedSession(agent.agentId);
    const repo = createRunRepo(db);

    for (let i = 0; i < 3; i++) {
      await repo.create({
        runId: generateRunId(),
        sessionId: session.sessionId,
        model: `model-${i}`,
      });
    }

    const runs = await repo.listBySession(session.sessionId);
    expect(runs).toHaveLength(3);
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i]!.createdAt.getTime()).toBeLessThanOrEqual(runs[i - 1]!.createdAt.getTime());
    }
  });
});

describe('ToolCallRepo', () => {
  it('creates a tool call with default status started', async () => {
    const workspace = await seedWorkspace();
    const agent = await seedAgent(workspace.workspaceId);
    const session = await seedSession(agent.agentId);
    const run = await seedRun(session.sessionId);
    const repo = createToolCallRepo(db);

    const tc = await repo.create({
      callId: generateToolCallId(),
      runId: run.runId,
      toolName: 'lookupOrder',
      input: { orderId: 'order_123' },
    });

    expect(tc.status).toBe('started');
    expect(tc.output).toBeNull();
    expect(tc.input).toEqual({ orderId: 'order_123' });
  });

  it('updateResult sets output and status', async () => {
    const workspace = await seedWorkspace();
    const agent = await seedAgent(workspace.workspaceId);
    const session = await seedSession(agent.agentId);
    const run = await seedRun(session.sessionId);
    const repo = createToolCallRepo(db);

    const tc = await repo.create({
      callId: generateToolCallId(),
      runId: run.runId,
      toolName: 'lookupOrder',
      input: { orderId: 'order_123' },
    });

    const result = { status: 'found', total: 99.99 };
    const updated = await repo.updateResult(tc.callId, result, 'completed');
    expect(updated!.status).toBe('completed');
    expect(updated!.output).toEqual(result);
  });

  it('fail sets status to failed', async () => {
    const workspace = await seedWorkspace();
    const agent = await seedAgent(workspace.workspaceId);
    const session = await seedSession(agent.agentId);
    const run = await seedRun(session.sessionId);
    const repo = createToolCallRepo(db);

    const tc = await repo.create({
      callId: generateToolCallId(),
      runId: run.runId,
      toolName: 'failingTool',
      input: {},
    });

    const failed = await repo.fail(tc.callId);
    expect(failed!.status).toBe('failed');
  });

  it('listByRun orders by createdAt ascending', async () => {
    const workspace = await seedWorkspace();
    const agent = await seedAgent(workspace.workspaceId);
    const session = await seedSession(agent.agentId);
    const run = await seedRun(session.sessionId);
    const repo = createToolCallRepo(db);

    for (let i = 0; i < 3; i++) {
      await repo.create({
        callId: generateToolCallId(),
        runId: run.runId,
        toolName: `tool-${i}`,
        input: { idx: i },
      });
    }

    const calls = await repo.listByRun(run.runId);
    expect(calls).toHaveLength(3);
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i]!.createdAt.getTime()).toBeGreaterThanOrEqual(
        calls[i - 1]!.createdAt.getTime(),
      );
    }
  });
});

describe('FK Integrity', () => {
  it('rejects agent creation with non-existent workspaceId', async () => {
    const repo = createAgentRepo(db);
    await expect(
      repo.create({
        agentId: generateAgentId(),
        workspaceId: 'ws_nonexistent',
        name: 'bad-agent',
        modelConfig,
        systemPrompt: 'Test',
        memoryConfig,
      }),
    ).rejects.toThrow();
  });

  it('rejects session creation with non-existent agentId', async () => {
    const repo = createSessionRepo(db);
    await expect(
      repo.create({
        sessionId: generateSessionId(),
        agentId: 'agt_nonexistent',
      }),
    ).rejects.toThrow();
  });

  it('rejects run creation with non-existent sessionId', async () => {
    const repo = createRunRepo(db);
    await expect(
      repo.create({
        runId: generateRunId(),
        sessionId: 'ses_nonexistent',
        model: 'test',
      }),
    ).rejects.toThrow();
  });

  it('rejects message creation with non-existent sessionId', async () => {
    const repo = createMessageRepo(db);
    await expect(
      repo.create({
        messageId: generateMessageId(),
        sessionId: 'ses_nonexistent',
        role: 'user',
        content: 'test',
      }),
    ).rejects.toThrow();
  });

  it('rejects tool call creation with non-existent runId', async () => {
    const repo = createToolCallRepo(db);
    await expect(
      repo.create({
        callId: generateToolCallId(),
        runId: 'run_nonexistent',
        toolName: 'test',
        input: {},
      }),
    ).rejects.toThrow();
  });
});

describe('UserRepo', () => {
  it('creates and retrieves a user by id', async () => {
    const repo = createUserRepo(db);
    const userId = generateUserId();
    const created = await repo.create({
      userId,
      cognitoSub: `sub-${Date.now()}`,
      email: `user-${Date.now()}@example.com`,
    });

    expect(created.userId).toBe(userId);
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);

    const fetched = await repo.getById(userId);
    expect(fetched).not.toBeNull();
    expect(fetched!.userId).toBe(userId);
  });

  it('retrieves a user by cognitoSub', async () => {
    const repo = createUserRepo(db);
    const sub = `sub-unique-${Date.now()}`;
    await repo.create({
      userId: generateUserId(),
      cognitoSub: sub,
      email: `user-${Date.now()}@example.com`,
    });

    const fetched = await repo.getByCognitoSub(sub);
    expect(fetched).not.toBeNull();
    expect(fetched!.cognitoSub).toBe(sub);
  });

  it('returns null for non-existent user', async () => {
    const repo = createUserRepo(db);
    const fetched = await repo.getById('usr_nonexistent');
    expect(fetched).toBeNull();
  });

  it('rejects duplicate cognitoSub', async () => {
    const repo = createUserRepo(db);
    const sub = `sub-dup-${Date.now()}`;
    await repo.create({
      userId: generateUserId(),
      cognitoSub: sub,
      email: 'first@example.com',
    });
    await expect(
      repo.create({
        userId: generateUserId(),
        cognitoSub: sub,
        email: 'second@example.com',
      }),
    ).rejects.toThrow();
  });
});

describe('UserWorkspaceRepo', () => {
  async function seedUser() {
    const repo = createUserRepo(db);
    return repo.create({
      userId: generateUserId(),
      cognitoSub: `sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      email: `user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    });
  }

  it('creates a membership and retrieves it', async () => {
    const user = await seedUser();
    const workspace = await seedWorkspace();
    const repo = createUserWorkspaceRepo(db);

    const created = await repo.create({
      userId: user.userId,
      workspaceId: workspace.workspaceId,
      role: 'owner',
    });

    expect(created.userId).toBe(user.userId);
    expect(created.workspaceId).toBe(workspace.workspaceId);
    expect(created.role).toBe('owner');
    expect(created.createdAt).toBeInstanceOf(Date);

    const fetched = await repo.getByUserAndWorkspace(user.userId, workspace.workspaceId);
    expect(fetched).not.toBeNull();
    expect(fetched!.role).toBe('owner');
  });

  it('listByUserId returns memberships ordered by createdAt asc', async () => {
    const user = await seedUser();
    const ws1 = await seedWorkspace();
    const ws2 = await seedWorkspace();
    const repo = createUserWorkspaceRepo(db);

    await repo.create({ userId: user.userId, workspaceId: ws1.workspaceId, role: 'owner' });
    await repo.create({ userId: user.userId, workspaceId: ws2.workspaceId, role: 'member' });

    const memberships = await repo.listByUserId(user.userId);
    expect(memberships).toHaveLength(2);
    expect(memberships[0]!.createdAt.getTime()).toBeLessThanOrEqual(memberships[1]!.createdAt.getTime());
  });

  it('isMember returns true for existing membership', async () => {
    const user = await seedUser();
    const workspace = await seedWorkspace();
    const repo = createUserWorkspaceRepo(db);

    await repo.create({ userId: user.userId, workspaceId: workspace.workspaceId, role: 'member' });

    const result = await repo.isMember(user.userId, workspace.workspaceId);
    expect(result).toBe(true);
  });

  it('isMember returns false for non-existing membership', async () => {
    const user = await seedUser();
    const workspace = await seedWorkspace();
    const repo = createUserWorkspaceRepo(db);

    const result = await repo.isMember(user.userId, workspace.workspaceId);
    expect(result).toBe(false);
  });

  it('rejects duplicate (userId, workspaceId) insert (composite PK)', async () => {
    const user = await seedUser();
    const workspace = await seedWorkspace();
    const repo = createUserWorkspaceRepo(db);

    await repo.create({ userId: user.userId, workspaceId: workspace.workspaceId, role: 'owner' });
    await expect(
      repo.create({ userId: user.userId, workspaceId: workspace.workspaceId, role: 'member' }),
    ).rejects.toThrow();
  });

  it('rejects membership with non-existent userId', async () => {
    const workspace = await seedWorkspace();
    const repo = createUserWorkspaceRepo(db);
    await expect(
      repo.create({ userId: 'usr_nonexistent', workspaceId: workspace.workspaceId, role: 'member' }),
    ).rejects.toThrow();
  });

  it('rejects membership with non-existent workspaceId', async () => {
    const user = await seedUser();
    const repo = createUserWorkspaceRepo(db);
    await expect(
      repo.create({ userId: user.userId, workspaceId: 'ws_nonexistent', role: 'member' }),
    ).rejects.toThrow();
  });
});

describe('Concurrency', () => {
  it('handles parallel inserts into same session', async () => {
    const workspace = await seedWorkspace();
    const agent = await seedAgent(workspace.workspaceId);
    const session = await seedSession(agent.agentId);
    const repo = createMessageRepo(db);

    const inserts = Array.from({ length: 10 }, (_, i) =>
      repo.create({
        messageId: generateMessageId(),
        sessionId: session.sessionId,
        role: 'user',
        content: `concurrent-${i}`,
      }),
    );

    const results = await Promise.all(inserts);
    expect(results).toHaveLength(10);

    const all = await repo.listBySession(session.sessionId);
    expect(all).toHaveLength(10);
  });
});
