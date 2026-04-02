import { z } from 'zod';

// ---------------------------------------------------------------------------
// ToolSchema — JSON Schema subset compatible with OpenAI, Anthropic, Google
// ---------------------------------------------------------------------------

export const ToolSchemaSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  parameters: z.record(z.unknown()),
}).strict();
export type ToolSchema = z.infer<typeof ToolSchemaSchema>;

// ---------------------------------------------------------------------------
// ToolCallMessage — assistant message with parallel tool calls
// ---------------------------------------------------------------------------

export const ToolCallMessageSchema = z.object({
  callId: z.string().min(1),
  toolName: z.string().min(1),
  arguments: z.unknown(),
}).strict();
export type ToolCallMessage = z.infer<typeof ToolCallMessageSchema>;

// ---------------------------------------------------------------------------
// ModelMessage — unified message format across providers
// ---------------------------------------------------------------------------

export const ModelMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  toolCallId: z.string().optional(),
  toolCalls: z.array(ToolCallMessageSchema).optional(),
}).strict();
export type ModelMessage = z.infer<typeof ModelMessageSchema>;

// ---------------------------------------------------------------------------
// ModelRequest — input to ModelProvider.generate()
// ---------------------------------------------------------------------------

export const ModelRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(ModelMessageSchema).min(1),
  tools: z.array(ToolSchemaSchema).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  // signal is runtime-only, not validated by Zod
}).strict();
export type ModelRequest = z.infer<typeof ModelRequestSchema> & {
  signal?: AbortSignal;
};

// ---------------------------------------------------------------------------
// TokenUsage — aligned with WS-02's TokenUsage
// ---------------------------------------------------------------------------

export const TokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
}).strict();
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

// ---------------------------------------------------------------------------
// ModelStreamChunk — discriminated union for streaming responses
// ---------------------------------------------------------------------------

export const TokenChunkSchema = z.object({
  type: z.literal('token'),
  text: z.string(),
}).strict();

export const ToolCallChunkSchema = z.object({
  type: z.literal('tool_call'),
  toolName: z.string().min(1),
  callId: z.string().min(1),
  arguments: z.unknown(),
}).strict();

export const FinishChunkSchema = z.object({
  type: z.literal('finish'),
  finishReason: z.string(),
  usage: TokenUsageSchema,
}).strict();

export const ModelStreamChunkSchema = z.discriminatedUnion('type', [
  TokenChunkSchema,
  ToolCallChunkSchema,
  FinishChunkSchema,
]);
export type ModelStreamChunk = z.infer<typeof ModelStreamChunkSchema>;

// ---------------------------------------------------------------------------
// ProviderConfig — passed to provider factories
// ---------------------------------------------------------------------------

export const ProviderConfigSchema = z.object({
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
  defaultModel: z.string().optional(),
  timeout: z.number().int().positive().optional(),
}).strict();
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

// ---------------------------------------------------------------------------
// ModelError — unified error type for model layer
// ---------------------------------------------------------------------------

export class ModelError extends Error {
  public readonly provider: string;
  public readonly statusCode?: number;
  public readonly retryable: boolean;

  constructor(
    message: string,
    provider: string,
    options?: { statusCode?: number; retryable?: boolean; cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'ModelError';
    this.provider = provider;
    this.statusCode = options?.statusCode;
    this.retryable = options?.retryable ?? false;
  }
}

/** HTTP status codes that indicate a retryable error. */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/**
 * Wraps any thrown value into a ModelError with consistent shape.
 * Provider implementations use this to normalize SDK-specific errors.
 */
export function normalizeError(e: unknown, provider: string): ModelError {
  if (e instanceof ModelError) return e;

  const statusCode =
    e instanceof Object && 'status' in e && typeof (e as Record<string, unknown>).status === 'number'
      ? (e as Record<string, unknown>).status as number
      : e instanceof Object && 'statusCode' in e && typeof (e as Record<string, unknown>).statusCode === 'number'
        ? (e as Record<string, unknown>).statusCode as number
        : undefined;

  const retryable = statusCode !== undefined && RETRYABLE_STATUS_CODES.has(statusCode);

  const message = e instanceof Error ? e.message : String(e);

  return new ModelError(message, provider, {
    statusCode,
    retryable,
    cause: e,
  });
}
