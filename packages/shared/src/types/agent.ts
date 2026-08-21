import { z } from 'zod';

export const MemoryStrategySchema = z.enum(['last_n', 'summary']);
export type MemoryStrategy = z.infer<typeof MemoryStrategySchema>;

export const MemoryConfigSchema = z.object({
  strategy: MemoryStrategySchema,
  maxMessages: z.number().int().positive().optional(),
}).strict();
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

export const ModelConfigSchema = z.object({
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
}).strict();
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export const ToolDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  inputSchema: z.record(z.unknown()),
}).strict();
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export const AgentConfigSchema = z.object({
  name: z.string().min(1),
  modelConfig: ModelConfigSchema,
  systemPrompt: z.string(),
  memoryConfig: MemoryConfigSchema.optional(),
  toolRunnerUrl: z.string().url().nullable().optional(),
  tools: z.array(ToolDefinitionSchema).optional(),
}).strict();
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const AgentRecordSchema = z.object({
  agentId: z.string().startsWith('agt_'),
  workspaceId: z.string().startsWith('ws_'),
  name: z.string().min(1),
  modelConfig: ModelConfigSchema,
  systemPrompt: z.string(),
  memoryConfig: MemoryConfigSchema,
  toolRunnerUrl: z.string().url().nullable(),
  tools: z.array(ToolDefinitionSchema).default([]),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
}).strict();
export type AgentRecord = z.infer<typeof AgentRecordSchema>;
