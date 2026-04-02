# WS-03: Database & Data Access Layer

## Goal

Implement PostgreSQL persistence using Drizzle ORM for entities Agent, Session, Message, Run, and ToolCall: declarative schema, migrations via Drizzle Kit, a pooled database client, and typed repository classes with CRUD and list operations matching the shared data model—enabling the runtime and API to persist and query agent state reliably with correct indexes, foreign keys, and JSONB handling.

## Dependencies

- WS-01
- WS-02

## Package

`packages/db`

## Files Touched

- `packages/db/src/schema/workspaces.ts`
- `packages/db/src/schema/api-keys.ts`
- `packages/db/src/schema/agents.ts`
- `packages/db/src/schema/sessions.ts`
- `packages/db/src/schema/messages.ts`
- `packages/db/src/schema/runs.ts`
- `packages/db/src/schema/tool-calls.ts`
- `packages/db/src/schema/index.ts`
- `packages/db/src/repositories/workspace-repo.ts`
- `packages/db/src/repositories/api-key-repo.ts`
- `packages/db/src/repositories/agent-repo.ts`
- `packages/db/src/repositories/session-repo.ts`
- `packages/db/src/repositories/message-repo.ts`
- `packages/db/src/repositories/run-repo.ts`
- `packages/db/src/repositories/tool-call-repo.ts`
- `packages/db/src/repositories/index.ts`
- `packages/db/src/client.ts`
- `packages/db/src/migrate.ts`
- `packages/db/drizzle.config.ts`
- `packages/db/src/index.ts`
- `packages/db/src/seed.ts`
- `packages/db/package.json`

## Implementation Steps

1. **Dependencies**: Add `drizzle-orm`, `postgres` (postgres.js) or `pg` + `drizzle-orm/pg-core`, `drizzle-kit`, and peer/dev tooling; depend on `@swiftagent/shared` for type alignment.
2. **Drizzle config**: `drizzle.config.ts` with `schema` glob, `out` for migrations, `dialect: 'postgresql'`, `dbCredentials` from `process.env` (`DATABASE_URL`).
3. **Workspaces schema** (`schema/workspaces.ts`): Table `workspaces` with `workspaceId` text PK (root entity — agents belong to workspaces), `name` text not null, `createdAt`/`updatedAt` timestamptz with defaults.
4. **ApiKeys schema** (`schema/api-keys.ts`): Table `api_keys` with `apiKeyId` text PK, `workspaceId` text not null FK → `workspaces.workspaceId`, `keyHash` text not null (SHA-256 hash of the raw key), `name` text, `createdAt` timestamptz, `revokedAt` timestamptz nullable; index on `keyHash` for fast lookup; index on `workspaceId`.
5. **Agents schema** (`schema/agents.ts`): Table `agents` with `agentId` text PK (matches `agt_` or shared prefix), `workspaceId` text not null FK → `workspaces.workspaceId` indexed, `name` text, `modelConfig` jsonb not null, `systemPrompt` text, `memoryConfig` jsonb not null, `toolRunnerUrl` text nullable — URL where the customer's SDK tool runner listens (set during agent registration via SDK `app.listen()`), `createdAt`/`updatedAt` timestamptz with defaults; index `(workspaceId)`, optional unique `(workspaceId, name)` if product requires.
6. **Sessions schema** (`schema/sessions.ts`): `sessions` with `sessionId` PK, `agentId` FK → `agents.agentId` on delete restrict/cascade per product choice, `userId` text indexed, `status` pg enum or text check (`active`/`closed`), `metadata` jsonb, timestamps; index `(agentId)`, `(userId)`.
7. **Messages schema** (`schema/messages.ts`): `messages` with `messageId` PK, `sessionId` FK → `sessions`, `runId` nullable FK → `runs.runId` (define order: runs table before messages if FK requires—or defer FK to runs only from messages with `runId` nullable), `role` enum, `content` text, `createdAt` timestamptz indexed for session ordering; index `(sessionId, createdAt)`.
8. **Runs schema** (`schema/runs.ts`): `runs` with `runId` PK, `sessionId` FK, `status` enum (`running`/`completed`/`failed`), `model` varchar, `tokenUsage` jsonb nullable, timestamps; index `(sessionId)`.
9. **Tool calls schema** (`schema/tool-calls.ts`): `tool_calls` with `callId` PK, `runId` FK indexed, `toolName` text, `input` jsonb, `output` jsonb nullable, `status` enum (`started`/`completed`/`failed`), timestamps; index `(runId)`.
10. **Schema index**: Export merged `schema` object for Drizzle and migration generation; resolve FK ordering: **workspaces** → **api_keys** (FK to workspaces); **workspaces** → **agents** → **sessions** → **runs** → **messages**; **runs** → **tool_calls**. Create tables in migration order accordingly (workspaces first, then api_keys and agents in an order that satisfies FKs, then sessions → runs → messages, tool_calls after runs).
11. **Client** (`client.ts`): Export `createDbClient(connectionString: string)` returning `{ db, pool }` using `postgres.js` + `drizzle()` or `pg.Pool`; export type `Db = typeof db`; support graceful shutdown hook.
12. **Migrate** (`migrate.ts`): CLI entry that runs Drizzle migrator against `DATABASE_URL`; idempotent for CI.
13. **WorkspaceRepo** (`repositories/workspace-repo.ts`): `create`, `getById(workspaceId)`, `getByName(name)`.
14. **ApiKeyRepo** (`repositories/api-key-repo.ts`): `create`, `getByKeyHash(hash)` (used by auth middleware to resolve workspace), `listByWorkspace(workspaceId)`, `revoke(apiKeyId)`.
15. **AgentRepo** (`agent-repo.ts`): Class or factory `createAgentRepo(db: Db)` with methods: `create(record: Omit<AgentRecord, 'createdAt' | 'updatedAt'> & Partial<...>)`, `getById(agentId)`, `getByWorkspaceId(workspaceId)`, `getByName(workspaceId, name)` returning `AgentRecord` shapes mapped from rows; JSONB `modelConfig`/`memoryConfig` parsed; include `toolRunnerUrl` in create/update/read where shared types require it.
16. **SessionRepo**: `create`, `getById`, `updateStatus(sessionId, status)`, `listByAgent(agentId, pagination?)`, `listByUser(userId, pagination?)` with stable sort.
17. **MessageRepo**: `create`, `createBatch(messages[])` in transaction, `listBySession(sessionId)` ordered ascending by `createdAt`, `listByRun(runId)`, `getLastN(sessionId, n)` ordered desc then reversed or subquery for efficiency.
18. **RunRepo**: `create`, `updateStatus`, `complete(runId, tokenUsage)`, `fail(runId, error metadata if stored)`, `getById`, `listBySession(sessionId)` ordered by `createdAt` desc.
19. **ToolCallRepo**: `create`, `updateResult(callId, output, status)`, `fail(callId, error)`, `listByRun(runId)` ordered by creation time.
20. **Mappers**: Thin row ↔ `@swiftagent/shared` types in repos; centralize date handling (Date vs ISO).
21. **Seed script** (`seed.ts`): Insert minimal workspace/agent/session for local dev; guarded by env flag.
22. **Package exports** (`index.ts`): Export `createDbClient`, repos factories, schema types for advanced queries, and migration runner.

## Tests

1. **Migrations apply**: Against ephemeral Postgres (Testcontainers `postgres` image or local CI service), `drizzle-kit migrate` (or push in dev only) creates tables matching Drizzle schema introspection.
2. **WorkspaceRepo**: Create, get by id, get by name; FK relationships satisfied when creating dependent rows.
3. **ApiKeyRepo**: Create, list by workspace, revoke; `getByKeyHash` returns row with correct `workspaceId` for auth lookup.
4. **AgentRepo**: Create and fetch by id/workspace/name; JSONB round-trip for `modelConfig` and `memoryConfig`; `toolRunnerUrl` nullable round-trip on create/update/read.
5. **SessionRepo**: Create, update status, list by agent and user with expected counts.
6. **MessageRepo**: `createBatch` atomicity; `listBySession` order matches insertion order by `createdAt`; `getLastN` returns correct slice; nullable `runId` behavior.
7. **RunRepo**: Transitions `running` → `completed`/`failed`; `tokenUsage` JSONB serialization; list ordering by session.
8. **ToolCallRepo**: `updateResult`/`fail` transitions; `listByRun` order.
9. **FK integrity**: Deleting or violating FKs behaves as specified (test expected constraint errors).
10. **Concurrency**: Optional smoke test for two parallel inserts into same session (if product requires ordering guarantees).

## Acceptance Criteria

1. All repositories pass integration tests against a real PostgreSQL instance (Testcontainers or equivalent); no mocked DB in acceptance path.
2. Migrations run cleanly from empty database to latest schema without manual SQL edits.
3. Schema matches the data model spec: columns, enums, indexes, and FKs as listed; JSONB fields deserialize to plain objects identical to write path.
4. Query ordering guarantees: session messages by `createdAt`, runs listed per session, tool calls per run as specified in repo methods.
5. `packages/db` exports a single documented way to obtain `db` and repository instances for `runtime` and `api` consumers.
6. Workspace and ApiKey repositories pass integration tests; API key hash lookup resolves to correct `workspaceId`.
7. Agent registration supports `toolRunnerUrl` field for tool runner callback.
