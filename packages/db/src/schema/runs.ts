import { pgTable, text, timestamp, jsonb, index, varchar, pgEnum } from 'drizzle-orm/pg-core';
import { sessions } from './sessions.js';

export const runStatusEnum = pgEnum('run_status', ['running', 'completed', 'failed', 'cancelled', 'timed_out']);

export const runs = pgTable('runs', {
  runId: text('run_id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => sessions.sessionId),
  status: runStatusEnum('status').notNull().default('running'),
  model: varchar('model', { length: 255 }).notNull(),
  tokenUsage: jsonb('token_usage'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('runs_session_id_idx').on(table.sessionId),
]);
