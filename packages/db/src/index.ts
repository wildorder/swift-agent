// Client
export { createDbClient, type Db, type DbClient } from './client.js';

// Schema (for advanced queries and migration tooling)
export * from './schema/index.js';

// Repositories
export {
  createWorkspaceRepo,
  type WorkspaceRepo,
  createApiKeyRepo,
  type ApiKeyRepo,
  createAgentRepo,
  type AgentRepo,
  createSessionRepo,
  type SessionRepo,
  createMessageRepo,
  type MessageRepo,
  createRunRepo,
  type RunRepo,
  createToolCallRepo,
  type ToolCallRepo,
  createTraceRepo,
  type TraceRepo,
  type TraceRecordRow,
  type SpanRecordRow,
} from './repositories/index.js';
