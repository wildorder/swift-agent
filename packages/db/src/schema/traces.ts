import { pgTable, text, timestamp, integer, jsonb, index, uniqueIndex, pgEnum } from 'drizzle-orm/pg-core';
import { runs } from './runs.js';

export const spanTypeEnum = pgEnum('span_type', ['run_span', 'model_call_span', 'tool_call_span']);
export const spanStatusEnum = pgEnum('span_status', ['ok', 'error']);

export const traces = pgTable('traces', {
  traceId: text('trace_id').primaryKey(),
  runId: text('run_id').notNull().references(() => runs.runId),
  rootSpanId: text('root_span_id').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  totalDurationMs: integer('total_duration_ms'),
}, (table) => [
  uniqueIndex('traces_run_id_idx').on(table.runId),
]);

export const traceSpans = pgTable('trace_spans', {
  spanId: text('span_id').primaryKey(),
  traceId: text('trace_id').notNull().references(() => traces.traceId),
  parentSpanId: text('parent_span_id'),
  type: spanTypeEnum('type').notNull(),
  name: text('name').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  durationMs: integer('duration_ms'),
  metadata: jsonb('metadata').notNull().default({}),
  status: spanStatusEnum('status').notNull().default('ok'),
  error: jsonb('error'),
}, (table) => [
  index('trace_spans_trace_id_idx').on(table.traceId),
]);
