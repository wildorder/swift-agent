import { eq } from 'drizzle-orm';
import type { WorkspaceRecord } from '@swiftagent/shared';
import type { Db } from '../client.js';
import { workspaces } from '../schema/index.js';

export function createWorkspaceRepo(db: Db) {
  return {
    async create(record: { workspaceId: string; name: string }): Promise<WorkspaceRecord> {
      const rows = await db.insert(workspaces).values(record).returning();
      const row = rows[0];
      if (!row) throw new Error('Failed to create workspace');
      return toRecord(row);
    },

    async getById(workspaceId: string): Promise<WorkspaceRecord | null> {
      const [row] = await db.select().from(workspaces).where(eq(workspaces.workspaceId, workspaceId));
      return row ? toRecord(row) : null;
    },

    async getByName(name: string): Promise<WorkspaceRecord | null> {
      const [row] = await db.select().from(workspaces).where(eq(workspaces.name, name));
      return row ? toRecord(row) : null;
    },
  };
}

function toRecord(row: typeof workspaces.$inferSelect): WorkspaceRecord {
  return {
    workspaceId: row.workspaceId,
    name: row.name,
    createdAt: row.createdAt,
  };
}

export type WorkspaceRepo = ReturnType<typeof createWorkspaceRepo>;
