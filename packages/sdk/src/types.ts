import { z } from 'zod';
import type { ZodType } from 'zod';
import type {
  AgentRecord,
  SessionRecord,
  MessageRecord,
  RunRecord,
} from '@swiftagent/shared';

// ── Tool context passed to execute handlers ─────────────────────────

export interface ToolContext {
  sessionId: string;
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
}

// ── Tool runner HTTP types ──────────────────────────────────────────

export const ToolRunnerRequestSchema = z.object({
  input: z.unknown(),
  context: z.object({
    sessionId: z.string(),
    userId: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ToolRunnerRequest = z.infer<typeof ToolRunnerRequestSchema>;

export interface ToolRunnerSuccessResponse {
  result: unknown;
}

export interface ToolRunnerErrorResponse {
  error: {
    code: string;
    message: string;
  };
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
