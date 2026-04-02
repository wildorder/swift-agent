import { eq, asc } from 'drizzle-orm';
import type { ToolCallRecord, ToolCallStatus } from '@swiftagent/shared';
import type { Db } from '../client.js';
import { toolCalls } from '../schema/index.js';

export function createToolCallRepo(db: Db) {
  return {
    async create(record: {
      callId: string;
      runId: string;
      toolName: string;
      input: unknown;
    }): Promise<ToolCallRecord> {
      const rows = await db
        .insert(toolCalls)
        .values({
          callId: record.callId,
          runId: record.runId,
          toolName: record.toolName,
          input: record.input,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('Failed to create tool call');
      return toRecord(row);
    },

    async updateResult(
      callId: string,
      output: unknown,
      status: ToolCallStatus = 'completed',
    ): Promise<ToolCallRecord | null> {
      const [row] = await db
        .update(toolCalls)
        .set({ output, status, updatedAt: new Date() })
        .where(eq(toolCalls.callId, callId))
        .returning();
      return row ? toRecord(row) : null;
    },

    async fail(callId: string): Promise<ToolCallRecord | null> {
      const [row] = await db
        .update(toolCalls)
        .set({ status: 'failed', updatedAt: new Date() })
        .where(eq(toolCalls.callId, callId))
        .returning();
      return row ? toRecord(row) : null;
    },

    async listByRun(runId: string): Promise<ToolCallRecord[]> {
      const rows = await db
        .select()
        .from(toolCalls)
        .where(eq(toolCalls.runId, runId))
        .orderBy(asc(toolCalls.createdAt));
      return rows.map(toRecord);
    },
  };
}

function toRecord(row: typeof toolCalls.$inferSelect): ToolCallRecord {
  return {
    callId: row.callId,
    runId: row.runId,
    toolName: row.toolName,
    input: row.input,
    output: row.output ?? null,
    status: row.status as ToolCallStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export type ToolCallRepo = ReturnType<typeof createToolCallRepo>;
