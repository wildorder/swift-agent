import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ModelConfigSchema,
  MemoryConfigSchema,
  ToolDefinitionSchema,
} from '@swiftagent/shared';

// ── Authenticated request ──────────────────────────────────────────
export interface AuthenticatedRequest extends FastifyRequest {
  workspaceId: string;
  apiKeyId: string;
}

// ── Management (Cognito) authenticated request ────────────────────
export interface ManagementAuthenticatedRequest extends FastifyRequest {
  cognitoSub: string;
  email: string;
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
  tools: z.array(ToolDefinitionSchema).optional(),
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

// Async run acceptance body (202) — REST no longer returns a full RunRecord;
// execution is process-bound and observed via GET /runs/:runId.
export const AcceptedRunResponseSchema = z.object({
  runId: z.string(),
  status: z.string(),
}).strict();
export type AcceptedRunResponse = z.infer<typeof AcceptedRunResponseSchema>;

// ── Session creation response ──────────────────────────────────────
export const CreateSessionResponseSchema = z.object({
  sessionId: z.string(),
  clientToken: z.string(),
  websocketUrl: z.string(),
});
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;

// ── Management DTOs ───────────────────────────────────────────────

export const UserResponseSchema = z.object({
  userId: z.string(),
  cognitoSub: z.string(),
  email: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type UserResponse = z.infer<typeof UserResponseSchema>;

export const CreateWorkspaceBodySchema = z.object({
  name: z.string().min(1).max(100),
}).strict();
export type CreateWorkspaceBody = z.infer<typeof CreateWorkspaceBodySchema>;

export const WorkspaceResponseSchema = z.object({
  workspaceId: z.string(),
  name: z.string(),
  createdAt: z.coerce.date(),
});
export type WorkspaceResponse = z.infer<typeof WorkspaceResponseSchema>;

export const CreateApiKeyBodySchema = z.object({
  name: z.string().min(1).max(100),
}).strict();
export type CreateApiKeyBody = z.infer<typeof CreateApiKeyBodySchema>;

export const ApiKeyResponseSchema = z.object({
  apiKeyId: z.string(),
  name: z.string(),
  createdAt: z.coerce.date(),
  revokedAt: z.coerce.date().nullable(),
});
export type ApiKeyResponse = z.infer<typeof ApiKeyResponseSchema>;

export const CreateApiKeyResponseSchema = ApiKeyResponseSchema.extend({
  rawKey: z.string(),
});
export type CreateApiKeyResponse = z.infer<typeof CreateApiKeyResponseSchema>;
