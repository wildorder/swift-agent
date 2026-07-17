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
  createUserRepo,
  type UserRepo,
  createUserWorkspaceRepo,
  type UserWorkspaceRepo,
} from './repositories/index.js';

// Migration status + drift-detection tooling (consumed by WS-29 integration tests)
export {
  queryAppliedMigrations,
  computeMigrationStatus,
  renderStatusTable,
  resolveLastAppliedIdx,
  type AppliedRow,
  type MigrationStatus,
  type MigrationStatusState,
} from './migration-status.js';
export {
  checkDrift,
  introspectLiveSchema,
  assembleLiveSchema,
  projectSnapshot,
  diffSchemas,
  renderDriftSummary,
  planPreflight,
  DRIFT_SKIP_WARNING,
  type DriftResult,
  type DriftDifference,
  type CanonicalSchema,
  type LiveSchema,
  type ExpectedSchema,
  type PreflightPlan,
} from './drift-check.js';
export { loadJournal, loadSnapshot, type Journal, type Snapshot } from './snapshot.js';
