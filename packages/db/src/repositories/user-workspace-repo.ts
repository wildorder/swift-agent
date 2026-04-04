import { eq, and, asc } from 'drizzle-orm';
import type { UserWorkspaceRecord } from '@swiftagent/shared';
import type { Db } from '../client.js';
import { userWorkspaces } from '../schema/index.js';

export function createUserWorkspaceRepo(db: Db) {
  return {
    async create(record: { userId: string; workspaceId: string; role: string }): Promise<UserWorkspaceRecord> {
      const rows = await db.insert(userWorkspaces).values(record).returning();
      const row = rows[0];
      if (!row) throw new Error('Failed to create user workspace');
      return toRecord(row);
    },
    async listByUserId(userId: string): Promise<UserWorkspaceRecord[]> {
      const rows = await db.select().from(userWorkspaces)
        .where(eq(userWorkspaces.userId, userId))
        .orderBy(asc(userWorkspaces.createdAt));
      return rows.map(toRecord);
    },
    async getByUserAndWorkspace(userId: string, workspaceId: string): Promise<UserWorkspaceRecord | null> {
      const [row] = await db.select().from(userWorkspaces)
        .where(and(eq(userWorkspaces.userId, userId), eq(userWorkspaces.workspaceId, workspaceId)));
      return row ? toRecord(row) : null;
    },
    async isMember(userId: string, workspaceId: string): Promise<boolean> {
      const rows = await db.select({ userId: userWorkspaces.userId }).from(userWorkspaces)
        .where(and(eq(userWorkspaces.userId, userId), eq(userWorkspaces.workspaceId, workspaceId)))
        .limit(1);
      return rows.length > 0;
    },
  };
}

function toRecord(row: typeof userWorkspaces.$inferSelect): UserWorkspaceRecord {
  return {
    userId: row.userId,
    workspaceId: row.workspaceId,
    role: row.role as 'owner' | 'member',
    createdAt: row.createdAt,
  };
}

export type UserWorkspaceRepo = ReturnType<typeof createUserWorkspaceRepo>;
