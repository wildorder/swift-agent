import { pgTable, text, timestamp, index, pgEnum } from 'drizzle-orm/pg-core';
import { sessions } from './sessions.js';
import { runs } from './runs.js';

export const messageRoleEnum = pgEnum('message_role', ['system', 'user', 'assistant', 'tool']);

export const messages = pgTable('messages', {
  messageId: text('message_id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => sessions.sessionId),
  runId: text('run_id').references(() => runs.runId),
  role: messageRoleEnum('role').notNull(),
  content: text('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('messages_session_id_created_at_idx').on(table.sessionId, table.createdAt),
  index('messages_run_id_idx').on(table.runId),
]);
