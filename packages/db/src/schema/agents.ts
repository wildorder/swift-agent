import { pgTable, text, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces.js';

export const agents = pgTable('agents', {
  agentId: text('agent_id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.workspaceId),
  name: text('name').notNull(),
  modelConfig: jsonb('model_config').notNull(),
  systemPrompt: text('system_prompt').notNull(),
  memoryConfig: jsonb('memory_config').notNull(),
  toolRunnerUrl: text('tool_runner_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('agents_workspace_id_idx').on(table.workspaceId),
  uniqueIndex('agents_workspace_id_name_idx').on(table.workspaceId, table.name),
]);
