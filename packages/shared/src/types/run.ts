import { z } from 'zod';

export const RunStatusSchema = z.enum(['running', 'completed', 'failed', 'cancelled', 'timed_out']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const TokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
}).strict();
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const RunRecordSchema = z.object({
  runId: z.string().startsWith('run_'),
  sessionId: z.string().startsWith('ses_'),
  status: RunStatusSchema,
  model: z.string().min(1),
  tokenUsage: TokenUsageSchema.nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
}).strict();
export type RunRecord = z.infer<typeof RunRecordSchema>;
