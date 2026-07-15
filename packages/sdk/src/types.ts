import { z } from 'zod';
import type { ZodType } from 'zod';
import {
  RunnerRequestSchema,
  type AgentRecord,
  type SessionRecord,
  type MessageRecord,
  type RunRecord,
} from '@swiftagent/shared';
import type { RunnerVerifyKey } from './runner-token.js';

// ── Tool context passed to execute handlers ─────────────────────────

export interface ToolContext {
  sessionId: string;
  /** Resolved agent id (WS-22) — matches the signed token's `agentId` claim. */
  agentId: string;
  /** Run id (WS-22) — invocation scope, matches the signed token's `runId` claim. */
  runId: string;
  /** Swift Agent tc_ call id (WS-22) — invocation identity + idempotency key. */
  callId: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

// ── Tool definition (developer-facing) ──────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ToolDefinition<TInput = any, TResult = any> {
  name: string;
  description: string;
  inputSchema: ZodType<TInput>;
  execute: (input: TInput, ctx: ToolContext) => Promise<TResult>;
}

// ── Serialized tool schema for API registration ─────────────────────

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// ── SDK agent config (developer-facing, ergonomic) ──────────────────

export const SdkAgentConfigSchema = z.object({
  name: z.string().min(1),
  model: z.string().min(1),
  system: z.string().optional(),
  tools: z.array(z.any()).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  memory: z.object({
    strategy: z.enum(['last_n', 'summary']),
    maxMessages: z.number().int().positive().optional(),
  }).strict().optional(),
}).strict();

export interface SdkAgentConfig {
  name: string;
  model: string;
  system?: string;
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  memory?: {
    strategy: 'last_n' | 'summary';
    maxMessages?: number;
  };
}

// ── Agent definition (serializable for API) ─────────────────────────

export interface AgentDefinition {
  readonly name: string;
  readonly modelConfig: {
    readonly model: string;
    readonly temperature?: number;
    readonly maxTokens?: number;
  };
  readonly systemPrompt: string;
  readonly memoryConfig?: {
    readonly strategy: 'last_n' | 'summary';
    readonly maxMessages?: number;
  };
  readonly toolSchemas: readonly ToolSchema[];
  readonly tools: readonly ToolDefinition[];
}

// ── CreateAgentApp config ───────────────────────────────────────────

export interface CreateAgentAppConfig {
  apiKey: string;
  baseUrl?: string;
  /**
   * Runner scoped-token verification (WS-22). Overrides the corresponding env
   * vars. `runnerPublicKey` is PEM (SPKI) or JWK JSON; `runnerAudience` defaults
   * to `TOOL_RUNNER_PUBLIC_URL`; `runnerWorkspaceId` is the runner's `ws_` id.
   */
  runnerPublicKey?: string;
  runnerAudience?: string;
  runnerWorkspaceId?: string;
}

// ── Tool runner HTTP types ──────────────────────────────────────────

// The wire contract is owned by @swiftagent/shared so both the runtime executor
// and this runner validate against one schema (WS-22). Re-exported under the
// legacy name for existing call sites.
export const ToolRunnerRequestSchema = RunnerRequestSchema;
export type ToolRunnerRequest = z.infer<typeof RunnerRequestSchema>;

export interface ToolRunnerSuccessResponse {
  result: unknown;
}

export interface ToolRunnerErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

// ── Runner auth config (WS-22) ──────────────────────────────────────

/**
 * Scoped-token verification configuration for a runner process. All fields are
 * known at startup, before any agent registers, so a token can be verified
 * against the runner's stable identity without needing agent ids in advance.
 */
export interface RunnerAuthConfig {
  /** Public verification key (imported PEM/JWK). */
  publicKey: RunnerVerifyKey;
  /** Required `aud` — the runner's stable public URL (RUNNER_AUDIENCE / TOOL_RUNNER_PUBLIC_URL). */
  expectedAudience: string;
  /** Required `workspaceId` claim — the runner's owning workspace (RUNNER_WORKSPACE_ID). */
  expectedWorkspaceId: string;
}

// ── SDK HTTP error ──────────────────────────────────────────────────

export class SdkHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'SdkHttpError';
  }
}

// ── Tool registry (internal) ────────────────────────────────────────

export type ToolRegistry = Map<string, ToolDefinition>;

// ── Re-export shared types used in the SDK public API ───────────────

export type {
  AgentRecord,
  SessionRecord,
  MessageRecord,
  RunRecord,
};

// ── API response types ──────────────────────────────────────────────

export interface CreateSessionOptions {
  agentName: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateSessionResult {
  sessionId: string;
  clientToken: string;
  websocketUrl: string;
}

export interface ListMessagesOptions {
  limit?: number;
  cursor?: string;
}

export interface ListMessagesResult {
  data: MessageRecord[];
  hasMore: boolean;
}

export interface CreateRunOptions {
  sessionId: string;
  content: string;
}
