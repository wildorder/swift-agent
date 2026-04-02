import { z } from 'zod';

export const SessionStatusSchema = z.enum(['active', 'closed']);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const CreateSessionRequestSchema = z.object({
  agentId: z.string().startsWith('agt_'),
  userId: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const SessionRecordSchema = z.object({
  sessionId: z.string().startsWith('ses_'),
  agentId: z.string().startsWith('agt_'),
  userId: z.string().nullable(),
  status: SessionStatusSchema,
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
}).strict();
export type SessionRecord = z.infer<typeof SessionRecordSchema>;
