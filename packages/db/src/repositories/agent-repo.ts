import { eq, and } from 'drizzle-orm';
import type { AgentRecord, ModelConfig, MemoryConfig } from '@swiftagent/shared';
import type { Db } from '../client.js';
import { agents } from '../schema/index.js';

export function createAgentRepo(db: Db) {
  return {
    async create(record: {
      agentId: string;
      workspaceId: string;
      name: string;
      modelConfig: ModelConfig;
      systemPrompt: string;
      memoryConfig: MemoryConfig;
      toolRunnerUrl?: string | null;
    }): Promise<AgentRecord> {
      const rows = await db.insert(agents).values({
        ...record,
        toolRunnerUrl: record.toolRunnerUrl ?? null,
      }).returning();
      const row = rows[0];
      if (!row) throw new Error('Failed to create agent');
      return toRecord(row);
    },

    async getById(agentId: string): Promise<AgentRecord | null> {
      const [row] = await db.select().from(agents).where(eq(agents.agentId, agentId));
      return row ? toRecord(row) : null;
    },

    async getByWorkspaceId(workspaceId: string): Promise<AgentRecord[]> {
      const rows = await db.select().from(agents).where(eq(agents.workspaceId, workspaceId));
      return rows.map(toRecord);
    },

    async getByName(workspaceId: string, name: string): Promise<AgentRecord | null> {
      const [row] = await db
        .select()
        .from(agents)
        .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, name)));
      return row ? toRecord(row) : null;
    },

    async update(
      agentId: string,
      updates: Partial<{
        name: string;
        modelConfig: ModelConfig;
        systemPrompt: string;
        memoryConfig: MemoryConfig;
        toolRunnerUrl: string | null;
      }>,
    ): Promise<AgentRecord | null> {
      const [row] = await db
        .update(agents)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(agents.agentId, agentId))
        .returning();
      return row ? toRecord(row) : null;
    },
  };
}

function toRecord(row: typeof agents.$inferSelect): AgentRecord {
  return {
    agentId: row.agentId,
    workspaceId: row.workspaceId,
    name: row.name,
    modelConfig: row.modelConfig as ModelConfig,
    systemPrompt: row.systemPrompt,
    memoryConfig: row.memoryConfig as MemoryConfig,
    toolRunnerUrl: row.toolRunnerUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export type AgentRepo = ReturnType<typeof createAgentRepo>;
