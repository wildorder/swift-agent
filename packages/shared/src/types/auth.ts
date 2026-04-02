import { z } from 'zod';

export const ClientTokenClaimsSchema = z.object({
  sessionId: z.string().startsWith('ses_'),
  agentId: z.string().startsWith('agt_'),
  permissions: z.array(z.string()),
  exp: z.number(),
  iss: z.string().optional(),
  aud: z.string().optional(),
}).strict();
export type ClientTokenClaims = z.infer<typeof ClientTokenClaimsSchema>;
