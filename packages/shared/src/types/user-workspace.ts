import { z } from 'zod';

export const UserWorkspaceRecordSchema = z.object({
  userId: z.string().startsWith('usr_'),
  workspaceId: z.string().startsWith('ws_'),
  role: z.enum(['owner', 'member']),
  createdAt: z.coerce.date(),
}).strict();
export type UserWorkspaceRecord = z.infer<typeof UserWorkspaceRecordSchema>;
