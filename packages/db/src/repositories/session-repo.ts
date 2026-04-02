import { eq, desc } from 'drizzle-orm';
import type { SessionRecord, SessionStatus } from '@swiftagent/shared';
import type { Db } from '../client.js';
import { sessions } from '../schema/index.js';

export function createSessionRepo(db: Db) {
  return {
    async create(record: {
      sessionId: string;
      agentId: string;
      userId?: string | null;
      metadata?: Record<string, unknown>;
    }): Promise<SessionRecord> {
      const rows = await db
        .insert(sessions)
        .values({
          sessionId: record.sessionId,
          agentId: record.agentId,
          userId: record.userId ?? null,
          metadata: record.metadata ?? {},
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('Failed to create session');
      return toRecord(row);
    },

    async getById(sessionId: string): Promise<SessionRecord | null> {
      const [row] = await db.select().from(sessions).where(eq(sessions.sessionId, sessionId));
      return row ? toRecord(row) : null;
    },

    async updateStatus(sessionId: string, status: SessionStatus): Promise<SessionRecord | null> {
      const [row] = await db
        .update(sessions)
        .set({ status, updatedAt: new Date() })
        .where(eq(sessions.sessionId, sessionId))
        .returning();
      return row ? toRecord(row) : null;
    },

    async listByAgent(
      agentId: string,
      opts: { limit?: number; offset?: number } = {},
    ): Promise<SessionRecord[]> {
      const { limit = 50, offset = 0 } = opts;
      const rows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.agentId, agentId))
        .orderBy(desc(sessions.createdAt))
        .limit(limit)
        .offset(offset);
      return rows.map(toRecord);
    },

    async listByUser(
      userId: string,
      opts: { limit?: number; offset?: number } = {},
    ): Promise<SessionRecord[]> {
      const { limit = 50, offset = 0 } = opts;
      const rows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.userId, userId))
        .orderBy(desc(sessions.createdAt))
        .limit(limit)
        .offset(offset);
      return rows.map(toRecord);
    },
  };
}

function toRecord(row: typeof sessions.$inferSelect): SessionRecord {
  return {
    sessionId: row.sessionId,
    agentId: row.agentId,
    userId: row.userId,
    status: row.status as SessionStatus,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export type SessionRepo = ReturnType<typeof createSessionRepo>;
