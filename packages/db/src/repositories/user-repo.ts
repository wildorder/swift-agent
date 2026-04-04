import { eq } from 'drizzle-orm';
import type { UserRecord } from '@swiftagent/shared';
import type { Db } from '../client.js';
import { users } from '../schema/index.js';

export function createUserRepo(db: Db) {
  return {
    async create(record: { userId: string; cognitoSub: string; email: string }): Promise<UserRecord> {
      const rows = await db.insert(users).values(record).returning();
      const row = rows[0];
      if (!row) throw new Error('Failed to create user');
      return toRecord(row);
    },
    async getByCognitoSub(cognitoSub: string): Promise<UserRecord | null> {
      const [row] = await db.select().from(users).where(eq(users.cognitoSub, cognitoSub));
      return row ? toRecord(row) : null;
    },
    async getById(userId: string): Promise<UserRecord | null> {
      const [row] = await db.select().from(users).where(eq(users.userId, userId));
      return row ? toRecord(row) : null;
    },
  };
}

function toRecord(row: typeof users.$inferSelect): UserRecord {
  return {
    userId: row.userId,
    cognitoSub: row.cognitoSub,
    email: row.email,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export type UserRepo = ReturnType<typeof createUserRepo>;
