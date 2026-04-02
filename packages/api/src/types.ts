import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ModelConfigSchema,
  MemoryConfigSchema,
} from '@swiftagent/shared';

// ── Authenticated request ──────────────────────────────────────────
export interface AuthenticatedRequest extends FastifyRequest {
  workspaceId: string;
  apiKeyId: string;
}

// ── Error response body ────────────────────────────────────────────
export const ErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

// ── Agent DTOs ─────────────────────────────────────────────────────
export const CreateAgentBodySchema = z.object({
  name: z.string().min(1),
  modelConfig: ModelConfigSchema,
  systemPrompt: z.string(),
  memoryConfig: MemoryConfigSchema.optional(),
  toolRunnerUrl: z.string().url().nullable().optional(),
}).strict();
export type CreateAgentBody = z.infer<typeof CreateAgentBodySchema>;

// ── Session DTOs ───────────────────────────────────────────────────
export const CreateSessionBodySchema = z.object({
  agentName: z.string().min(1),
  userId: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type CreateSessionBody = z.infer<typeof CreateSessionBodySchema>;

export const PatchSessionBodySchema = z.object({
  status: z.enum(['active', 'closed']).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type PatchSessionBody = z.infer<typeof PatchSessionBodySchema>;

// ── Message pagination ─────────────────────────────────────────────
export const ListMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
}).strict();
export type ListMessagesQuery = z.infer<typeof ListMessagesQuerySchema>;

// ── Run DTOs ───────────────────────────────────────────────────────
export const CreateRunBodySchema = z.object({
  content: z.string().min(1),
}).strict();
export type CreateRunBody = z.infer<typeof CreateRunBodySchema>;

// ── Session creation response ──────────────────────────────────────
export const CreateSessionResponseSchema = z.object({
  sessionId: z.string(),
  clientToken: z.string(),
  websocketUrl: z.string(),
});
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;
