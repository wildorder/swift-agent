import { pgTable, text, timestamp, jsonb, index, pgEnum } from 'drizzle-orm/pg-core';
import { runs } from './runs.js';

export const toolCallStatusEnum = pgEnum('tool_call_status', ['started', 'completed', 'failed']);

export const toolCalls = pgTable('tool_calls', {
  callId: text('call_id').primaryKey(),
  runId: text('run_id').notNull().references(() => runs.runId),
  toolName: text('tool_name').notNull(),
  input: jsonb('input').notNull(),
  output: jsonb('output'),
  status: toolCallStatusEnum('status').notNull().default('started'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('tool_calls_run_id_idx').on(table.runId),
]);
