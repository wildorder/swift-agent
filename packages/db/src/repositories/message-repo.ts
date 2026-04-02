import { eq, desc, asc } from 'drizzle-orm';
import type { MessageRecord } from '@swiftagent/shared';
import type { Db } from '../client.js';
import { messages } from '../schema/index.js';

export function createMessageRepo(db: Db) {
  return {
    async create(record: {
      messageId: string;
      sessionId: string;
      runId?: string | null;
      role: 'system' | 'user' | 'assistant' | 'tool';
      content: string;
    }): Promise<MessageRecord> {
      const rows = await db
        .insert(messages)
        .values({
          messageId: record.messageId,
          sessionId: record.sessionId,
          runId: record.runId ?? null,
          role: record.role,
          content: record.content,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('Failed to create message');
      return toRecord(row);
    },

    async createBatch(
      records: Array<{
        messageId: string;
        sessionId: string;
        runId?: string | null;
        role: 'system' | 'user' | 'assistant' | 'tool';
        content: string;
      }>,
    ): Promise<MessageRecord[]> {
      if (records.length === 0) return [];
      const values = records.map((r) => ({
        messageId: r.messageId,
        sessionId: r.sessionId,
        runId: r.runId ?? null,
        role: r.role,
        content: r.content,
      }));
      const rows = await db.insert(messages).values(values).returning();
      return rows.map(toRecord);
    },

    async listBySession(sessionId: string): Promise<MessageRecord[]> {
      const rows = await db
        .select()
        .from(messages)
        .where(eq(messages.sessionId, sessionId))
        .orderBy(asc(messages.createdAt));
      return rows.map(toRecord);
    },

    async listByRun(runId: string): Promise<MessageRecord[]> {
      const rows = await db
        .select()
        .from(messages)
        .where(eq(messages.runId, runId))
        .orderBy(asc(messages.createdAt));
      return rows.map(toRecord);
    },

    async getLastN(sessionId: string, n: number): Promise<MessageRecord[]> {
      const rows = await db
        .select()
        .from(messages)
        .where(eq(messages.sessionId, sessionId))
        .orderBy(desc(messages.createdAt))
        .limit(n);
      return rows.reverse().map(toRecord);
    },
  };
}

function toRecord(row: typeof messages.$inferSelect): MessageRecord {
  return {
    messageId: row.messageId,
    sessionId: row.sessionId,
    runId: row.runId,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt,
  };
}

export type MessageRepo = ReturnType<typeof createMessageRepo>;
