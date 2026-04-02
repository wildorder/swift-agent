import { z } from 'zod';

export const MessageRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const MessageRecordSchema = z.object({
  messageId: z.string().startsWith('msg_'),
  sessionId: z.string().startsWith('ses_'),
  runId: z.string().startsWith('run_').nullable(),
  role: MessageRoleSchema,
  content: z.string(),
  createdAt: z.coerce.date(),
}).strict();
export type MessageRecord = z.infer<typeof MessageRecordSchema>;
