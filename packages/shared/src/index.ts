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
  AgentConfigSchema,
  AgentRecordSchema,
} from './types/agent.js';
export type {
  MemoryStrategy,
  MemoryConfig,
  ModelConfig,
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
