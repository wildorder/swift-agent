import { z } from 'zod';

export const UserRecordSchema = z.object({
  userId: z.string().startsWith('usr_'),
  cognitoSub: z.string().min(1),
  email: z.string().email(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
}).strict();
export type UserRecord = z.infer<typeof UserRecordSchema>;
