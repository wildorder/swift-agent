import { z } from 'zod';

export const ToolCallStatusSchema = z.enum(['started', 'completed', 'failed']);
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;

export const ToolCallRecordSchema = z.object({
  callId: z.string().startsWith('tc_'),
  runId: z.string().startsWith('run_'),
  toolName: z.string().min(1),
  input: z.unknown(),
  output: z.unknown().nullable(),
  status: ToolCallStatusSchema,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
}).strict();
export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>;
