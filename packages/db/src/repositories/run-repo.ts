import { eq, desc } from 'drizzle-orm';
import type { RunRecord, TokenUsage, RunStatus } from '@swiftagent/shared';
import type { Db } from '../client.js';
import { runs } from '../schema/index.js';

export function createRunRepo(db: Db) {
  return {
    async create(record: {
      runId: string;
      sessionId: string;
      model: string;
    }): Promise<RunRecord> {
      const rows = await db
        .insert(runs)
        .values({
          runId: record.runId,
          sessionId: record.sessionId,
          model: record.model,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('Failed to create run');
      return toRecord(row);
    },

    async getById(runId: string): Promise<RunRecord | null> {
      const [row] = await db.select().from(runs).where(eq(runs.runId, runId));
      return row ? toRecord(row) : null;
    },

    async updateStatus(runId: string, status: RunStatus): Promise<RunRecord | null> {
      const [row] = await db
        .update(runs)
        .set({ status, updatedAt: new Date() })
        .where(eq(runs.runId, runId))
        .returning();
      return row ? toRecord(row) : null;
    },

    async complete(runId: string, tokenUsage: TokenUsage): Promise<RunRecord | null> {
      const [row] = await db
        .update(runs)
        .set({ status: 'completed', tokenUsage, updatedAt: new Date() })
        .where(eq(runs.runId, runId))
        .returning();
      return row ? toRecord(row) : null;
    },

    async fail(runId: string): Promise<RunRecord | null> {
      const [row] = await db
        .update(runs)
        .set({ status: 'failed', updatedAt: new Date() })
        .where(eq(runs.runId, runId))
        .returning();
      return row ? toRecord(row) : null;
    },

    async listBySession(sessionId: string): Promise<RunRecord[]> {
      const rows = await db
        .select()
        .from(runs)
        .where(eq(runs.sessionId, sessionId))
        .orderBy(desc(runs.createdAt));
      return rows.map(toRecord);
    },
  };
}

function toRecord(row: typeof runs.$inferSelect): RunRecord {
  return {
    runId: row.runId,
    sessionId: row.sessionId,
    status: row.status as RunStatus,
    model: row.model,
    tokenUsage: (row.tokenUsage as TokenUsage) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export type RunRepo = ReturnType<typeof createRunRepo>;
