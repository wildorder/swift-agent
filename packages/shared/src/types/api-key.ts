import { z } from 'zod';

export const ApiKeyRecordSchema = z.object({
  apiKeyId: z.string().startsWith('ak_'),
  workspaceId: z.string().startsWith('ws_'),
  keyHash: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.coerce.date(),
  revokedAt: z.coerce.date().nullable(),
}).strict();
export type ApiKeyRecord = z.infer<typeof ApiKeyRecordSchema>;
