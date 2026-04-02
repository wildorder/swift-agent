import { z } from 'zod';

export const WorkspaceRecordSchema = z.object({
  workspaceId: z.string().startsWith('ws_'),
  name: z.string().min(1),
  createdAt: z.coerce.date(),
}).strict();
export type WorkspaceRecord = z.infer<typeof WorkspaceRecordSchema>;
