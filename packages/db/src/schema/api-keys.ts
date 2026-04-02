import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces.js';

export const apiKeys = pgTable('api_keys', {
  apiKeyId: text('api_key_id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.workspaceId),
  keyHash: text('key_hash').notNull(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => [
  index('api_keys_key_hash_idx').on(table.keyHash),
  index('api_keys_workspace_id_idx').on(table.workspaceId),
]);
