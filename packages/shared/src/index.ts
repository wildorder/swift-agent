export const PACKAGE_NAME = 'shared' as const;

// Redis client
export { createRedisClient } from './redis-client.js';

// Constants
export {
  PREFIX_SESSION,
  PREFIX_MESSAGE,
  PREFIX_RUN,
  PREFIX_TOOL_CALL,
  PREFIX_AGENT,
  PREFIX_WORKSPACE,
  PREFIX_API_KEY,
  PREFIX_TRACE,
  PREFIX_SPAN,
  PREFIX_USER,
  EVENT_MESSAGE_STARTED,
  EVENT_TOKEN,
  EVENT_TOOL_CALL_STARTED,
  EVENT_TOOL_CALL_COMPLETED,
  EVENT_MESSAGE_COMPLETED,
  EVENT_RUN_FAILED,
  DEFAULT_NANOID_LENGTH,
  DEFAULT_MAX_MESSAGES,
} from './constants.js';

// ID utilities
export {
  generateSessionId,
  generateMessageId,
  generateRunId,
  generateToolCallId,
  generateAgentId,
  generateWorkspaceId,
  generateApiKeyId,
  generateTraceId,
  generateSpanId,
  generateUserId,
  parsePrefix,
} from './utils/id.js';

// Time utilities
export { now, toIso, clampTtl } from './utils/time.js';

// Config
export { ENV_KEYS, loadConfig } from './config.js';
export type { AppConfig } from './config.js';

// Agent types
export {
  MemoryStrategySchema,
  MemoryConfigSchema,
  ModelConfigSchema,
  ToolDefinitionSchema,
  AgentConfigSchema,
  AgentRecordSchema,
} from './types/agent.js';
export type {
  MemoryStrategy,
  MemoryConfig,
  ModelConfig,
  ToolDefinition,
  AgentConfig,
  AgentRecord,
} from './types/agent.js';

// Session types
export {
  SessionStatusSchema,
  CreateSessionRequestSchema,
  SessionRecordSchema,
} from './types/session.js';
export type {
  SessionStatus,
  CreateSessionRequest,
  SessionRecord,
} from './types/session.js';

// Message types
export { MessageRoleSchema, MessageRecordSchema } from './types/message.js';
export type { MessageRole, MessageRecord } from './types/message.js';

// Run types
export {
  RunStatusSchema,
  TokenUsageSchema,
  RunRecordSchema,
} from './types/run.js';
export type { RunStatus, TokenUsage, RunRecord } from './types/run.js';

// Tool call types
export { ToolCallStatusSchema, ToolCallRecordSchema } from './types/tool-call.js';
export type { ToolCallStatus, ToolCallRecord } from './types/tool-call.js';

// Runner protocol (WS-22) — versioned, bounded remote tool-runner wire contract
export {
  RUNNER_PROTOCOL_VERSION,
  RUNNER_MAX_INPUT_BYTES,
  RUNNER_MAX_OUTPUT_BYTES,
  RUNNER_MAX_ERROR_BYTES,
  RunnerRequestContextSchema,
  RunnerRequestSchema,
  RunnerSuccessResponseSchema,
  RunnerErrorResponseSchema,
} from './types/runner-protocol.js';
export type {
  RunnerRequestContext,
  RunnerRequest,
  RunnerSuccessResponse,
  RunnerErrorResponse,
  RunnerResponse,
} from './types/runner-protocol.js';

// Protocol versioning & compatibility (WS-37) — control-plane + stream contract
export {
  API_PROTOCOL_VERSION,
  SDK_MIN_SERVER_PROTOCOL,
  PROTOCOL_HEADER,
  PROTOCOL,
  assertProtocolCompatible,
} from './types/protocol.js';

// Stream events
export {
  MessageStartedEventSchema,
  TokenEventSchema,
  ToolCallStartedEventSchema,
  ToolCallCompletedEventSchema,
  MessageCompletedEventSchema,
  RunFailedEventSchema,
  ChatEventSchema,
} from './types/events.js';
export type {
  MessageStartedEvent,
  TokenEvent,
  ToolCallStartedEvent,
  ToolCallCompletedEvent,
  MessageCompletedEvent,
  RunFailedEvent,
  ChatEvent,
} from './types/events.js';

// Errors
export {
  SwiftAgentErrorCode,
  SwiftAgentError,
  isSwiftAgentError,
} from './types/errors.js';

// Workspace types
export { WorkspaceRecordSchema } from './types/workspace.js';
export type { WorkspaceRecord } from './types/workspace.js';

// API key types
export { ApiKeyRecordSchema } from './types/api-key.js';
export type { ApiKeyRecord } from './types/api-key.js';

// Auth types
export { ClientTokenClaimsSchema } from './types/auth.js';
export type { ClientTokenClaims } from './types/auth.js';

// User types
export { UserRecordSchema } from './types/user.js';
export type { UserRecord } from './types/user.js';

// User workspace types
export { UserWorkspaceRecordSchema } from './types/user-workspace.js';
export type { UserWorkspaceRecord } from './types/user-workspace.js';
