import { pgTable, text, timestamp, jsonb, index, pgEnum } from 'drizzle-orm/pg-core';
import { agents } from './agents.js';

export const sessionStatusEnum = pgEnum('session_status', ['active', 'closed']);

export const sessions = pgTable('sessions', {
  sessionId: text('session_id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.agentId),
  userId: text('user_id'),
  status: sessionStatusEnum('status').notNull().default('active'),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('sessions_agent_id_idx').on(table.agentId),
  index('sessions_user_id_idx').on(table.userId),
]);
