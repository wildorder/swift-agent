import { eq } from 'drizzle-orm';
import type { ApiKeyRecord } from '@swiftagent/shared';
import type { Db } from '../client.js';
import { apiKeys } from '../schema/index.js';

export function createApiKeyRepo(db: Db) {
  return {
    async create(record: {
      apiKeyId: string;
      workspaceId: string;
      keyHash: string;
      name: string;
    }): Promise<ApiKeyRecord> {
      const rows = await db.insert(apiKeys).values(record).returning();
      const row = rows[0];
      if (!row) throw new Error('Failed to create api key');
      return toRecord(row);
    },

    async getByKeyHash(keyHash: string): Promise<ApiKeyRecord | null> {
      const [row] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash));
      return row ? toRecord(row) : null;
    },

    async listByWorkspace(workspaceId: string): Promise<ApiKeyRecord[]> {
      const rows = await db.select().from(apiKeys).where(eq(apiKeys.workspaceId, workspaceId));
      return rows.map(toRecord);
    },

    async revoke(apiKeyId: string): Promise<ApiKeyRecord | null> {
      const [row] = await db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(apiKeys.apiKeyId, apiKeyId))
        .returning();
      return row ? toRecord(row) : null;
    },
  };
}

function toRecord(row: typeof apiKeys.$inferSelect): ApiKeyRecord {
  return {
    apiKeyId: row.apiKeyId,
    workspaceId: row.workspaceId,
    keyHash: row.keyHash,
    name: row.name,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
  };
}

export type ApiKeyRepo = ReturnType<typeof createApiKeyRepo>;
