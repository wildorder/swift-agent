import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  generateWorkspaceId,
  generateAgentId,
} from '@swiftagent/shared';
import type { ModelConfig, MemoryConfig, ToolDefinition } from '@swiftagent/shared';
import {
  createDbClient,
  createWorkspaceRepo,
  createAgentRepo,
} from '@swiftagent/db';
import type { Db } from '@swiftagent/db';

let db: Db;
let close: () => Promise<void>;

const modelConfig: ModelConfig = { model: 'anthropic/claude-sonnet', temperature: 0.7 };
const memoryConfig: MemoryConfig = { strategy: 'last_n', maxMessages: 50 };

const t1: ToolDefinition = {
  name: 'lookupOrder',
  description: 'Look up an order by id',
  inputSchema: { type: 'object', properties: { orderId: { type: 'string' } } },
};
const t2: ToolDefinition = {
  name: 'cancelOrder',
  description: 'Cancel an order',
  inputSchema: { type: 'object', properties: { orderId: { type: 'string' } } },
};

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

async function seedWorkspace() {
  const repo = createWorkspaceRepo(db);
  return repo.create({ workspaceId: generateWorkspaceId(), name: `ws-${Date.now()}-${Math.random()}` });
}

describe('AgentRepo — persisted tool definitions', () => {
  it('create persists tools and getById returns them (SC-01)', async () => {
    const workspace = await seedWorkspace();
    const repo = createAgentRepo(db);

    const created = await repo.create({
      agentId: generateAgentId(),
      workspaceId: workspace.workspaceId,
      name: `tools-agent-${Date.now()}`,
      modelConfig,
      systemPrompt: 'You are helpful.',
      memoryConfig,
      tools: [t1, t2],
    });

    expect(created.tools).toEqual([t1, t2]);

    const fetched = await repo.getById(created.agentId);
    expect(fetched).not.toBeNull();
    expect(fetched!.tools).toEqual([t1, t2]);
  });

  it('create without tools defaults to an empty array', async () => {
    const workspace = await seedWorkspace();
    const repo = createAgentRepo(db);

    const created = await repo.create({
      agentId: generateAgentId(),
      workspaceId: workspace.workspaceId,
      name: `no-tools-agent-${Date.now()}`,
      modelConfig,
      systemPrompt: 'You are helpful.',
      memoryConfig,
    });

    expect(created.tools).toEqual([]);
  });

  it('legacy row inserted via raw SQL (column default) reads as [] (SC-02)', async () => {
    const workspace = await seedWorkspace();
    const repo = createAgentRepo(db);
    const agentId = generateAgentId();

    // Insert without touching the tools column — relies on the DEFAULT '[]'::jsonb.
    await db.execute(sql`
      INSERT INTO agents (agent_id, workspace_id, name, model_config, system_prompt, memory_config)
      VALUES (
        ${agentId},
        ${workspace.workspaceId},
        ${`legacy-agent-${Date.now()}`},
        ${JSON.stringify(modelConfig)}::jsonb,
        ${'You are helpful.'},
        ${JSON.stringify(memoryConfig)}::jsonb
      )
    `);

    const fetched = await repo.getById(agentId);
    expect(fetched).not.toBeNull();
    expect(fetched!.tools).toEqual([]);
  });

  it('update replaces the persisted tools', async () => {
    const workspace = await seedWorkspace();
    const repo = createAgentRepo(db);

    const created = await repo.create({
      agentId: generateAgentId(),
      workspaceId: workspace.workspaceId,
      name: `update-tools-agent-${Date.now()}`,
      modelConfig,
      systemPrompt: 'You are helpful.',
      memoryConfig,
      tools: [t1],
    });
    expect(created.tools).toEqual([t1]);

    const updated = await repo.update(created.agentId, { tools: [t2] });
    expect(updated!.tools).toEqual([t2]);

    const fetched = await repo.getById(created.agentId);
    expect(fetched!.tools).toEqual([t2]);
  });

  it('getByWorkspaceId and getByName return tools', async () => {
    const workspace = await seedWorkspace();
    const repo = createAgentRepo(db);
    const name = `named-tools-agent-${Date.now()}`;

    await repo.create({
      agentId: generateAgentId(),
      workspaceId: workspace.workspaceId,
      name,
      modelConfig,
      systemPrompt: 'You are helpful.',
      memoryConfig,
      tools: [t1],
    });

    const byWorkspace = await repo.getByWorkspaceId(workspace.workspaceId);
    expect(byWorkspace).toHaveLength(1);
    expect(byWorkspace[0]!.tools).toEqual([t1]);

    const byName = await repo.getByName(workspace.workspaceId, name);
    expect(byName!.tools).toEqual([t1]);
  });
});
