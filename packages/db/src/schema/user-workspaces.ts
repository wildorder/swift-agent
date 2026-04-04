import { pgTable, text, timestamp, primaryKey } from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { workspaces } from './workspaces.js';

export const userWorkspaces = pgTable('user_workspaces', {
  userId: text('user_id').notNull().references(() => users.userId, { onDelete: 'restrict' }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.workspaceId, { onDelete: 'restrict' }),
  role: text('role').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.workspaceId] }),
]);
