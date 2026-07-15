# WS-19: Persisted Tool Definition Contract

## Goal

Introduce a normalized, persisted tool-definition contract so that tools declared through the SDK survive agent registration all the way into the database and back out through the control-plane API. This adds a `ToolDefinition` schema to `@swiftagent/shared`, a `tools` column on the `agents` table with a backward-compatible migration, tool-aware repository create/update/read operations, tool-aware agent registration in `@swiftagent/api`, and SDK registration that actually sends tool schemas. Execution handlers are never serialized — only `name`, `description`, and JSON input schema are persisted. Existing agents without persisted tools remain valid and default to an empty tool list.

## Traceability

- **SC-01** — SDK registration persists the normalized name, description, and input schema for every declared tool without persisting execution handlers.
- **SC-02** — Existing agents without persisted tools remain readable and behave as agents with an empty tool list.

## Dependencies

- **db-migration-baseline WS-01** — the Drizzle greenfield baseline migration (`0000_baseline.sql` + `meta/0000_snapshot.json` + one-entry `_journal.json`). This established `migrate` as the single source of truth: `test/setup-db.ts` now applies real migrations (no hand-written DDL), `packages/db` exposes `db:generate` (`tsc && drizzle-kit generate`, schema read from `dist/schema/*.js`) and `migrate` (`node dist/migrate.js`) scripts, and new schema changes are introduced as **generated incremental migrations** on top of the baseline — never hand-written `IF NOT EXISTS` DDL or edits to the test bootstrap.
- **product-x WS-02** — shared entity Zod schemas (`AgentConfigSchema`, `AgentRecordSchema`, `ModelConfigSchema`).
- **product-x WS-03** — Drizzle `agents` table and `createAgentRepo`.
- **product-x WS-07** — control-plane API agent routes (`POST /v1/agents`) and `CreateAgentBodySchema`.
- **product-x WS-08** — server SDK (`defineAgent`, `tool`, `ControlPlaneClient.registerAgent`).

## Context Files (Agent MUST read before implementing)

- `c:\dev\swift-agent\CLAUDE.md` — conventions (ESM `.js` import specifiers, Zod as source of truth, `z.infer<>`, factory repos, pinned versions).
- `c:\dev\swift-agent\packages\shared\src\types\agent.ts` — where the tool schema and agent schemas live.
- `c:\dev\swift-agent\packages\shared\src\index.ts` — shared barrel; add new exports here.
- `c:\dev\swift-agent\packages\db\src\schema\agents.ts` — Drizzle `agents` table to extend (source of truth; `db:generate` diffs this against the baseline snapshot).
- `c:\dev\swift-agent\packages\db\src\repositories\agent-repo.ts` — repo create/update/read to make tool-aware.
- `c:\dev\swift-agent\packages\db\drizzle\0000_baseline.sql` — the greenfield baseline (all tables/enums/indexes/FKs) from db-migration-baseline WS-01; the new `tools` migration layers on top of this.
- `c:\dev\swift-agent\packages\db\drizzle\meta\_journal.json` + `meta\0000_snapshot.json` — migration journal + baseline snapshot; **managed by `drizzle-kit generate`** — do NOT hand-edit.
- `c:\dev\swift-agent\packages\db\drizzle.config.ts` + `packages\db\package.json` — `schema` points at `./dist/schema/*.js`; run migrations via the `db:generate` script (`tsc && drizzle-kit generate`).
- `c:\dev\swift-agent\test\setup-db.ts` — Testcontainers globalSetup; it now applies the real Drizzle migrations (via the migrator) — the `tools` column appears automatically once the generated migration is committed. **Do NOT hand-edit its schema.**
- `c:\dev\swift-agent\test\integration\db.integration.test.ts` — existing root integration test to mirror for structure/naming.
- `c:\dev\swift-agent\packages\api\src\types.ts` — `CreateAgentBodySchema`.
- `c:\dev\swift-agent\packages\api\src\services\agent-service.ts` — `registerOrUpdateAgent`.
- `c:\dev\swift-agent\packages\sdk\src\agent.ts` — `defineAgent` computes `toolSchemas`.
- `c:\dev\swift-agent\packages\sdk\src\tool.ts` — `tool()` and `toolToJsonSchema`.
- `c:\dev\swift-agent\packages\sdk\src\client.ts` — `ControlPlaneClient.registerAgent` (currently omits tools).

## Package

`packages/shared`, `packages/db`, `packages/api`, `packages/sdk`

## Files Touched

- `packages/shared/src/types/agent.ts` **(MODIFY)** — add `ToolDefinitionSchema` + `ToolDefinition`; add `tools` to `AgentConfigSchema` and `AgentRecordSchema`.
- `packages/shared/src/index.ts` **(MODIFY)** — export `ToolDefinitionSchema` and `ToolDefinition`.
- `packages/db/src/schema/agents.ts` **(MODIFY)** — add `tools jsonb not null default '[]'::jsonb` (source of truth for the generated migration).
- `packages/db/src/repositories/agent-repo.ts` **(MODIFY)** — accept/return `tools` in `create`, `update`, and all reads.
- `packages/db/drizzle/0001_<generated_name>.sql` **(NEW, generated)** — the incremental migration adding the `tools` column, produced by `pnpm --filter @swiftagent/db db:generate` (do NOT hand-write it).
- `packages/db/drizzle/meta/0001_snapshot.json` **(NEW, generated)** — snapshot emitted by `db:generate`.
- `packages/db/drizzle/meta/_journal.json` **(MODIFY, generated)** — the new `idx: 1` entry is appended by `db:generate` (do NOT hand-edit).
- `packages/api/src/types.ts` **(MODIFY)** — add optional `tools` to `CreateAgentBodySchema`.
- `packages/api/src/services/agent-service.ts` **(MODIFY)** — thread `tools` through create/update with `[]` default.
- `packages/sdk/src/client.ts` **(MODIFY)** — send `tools` in `registerAgent` body.
- `packages/sdk/src/app.ts` **(MODIFY)** — pass each agent's normalized tool definitions into `client.registerAgent`.
- `packages/shared/src/__tests__/agent-tools.test.ts` **(NEW)** — schema/backward-compat contract tests (unit; no DB).
- `packages/api/src/routes/__tests__/agents-tools.test.ts` **(NEW)** — registration round-trip tests (`inject()`, mocked repo — unit).
- `test/integration/agent-repo-tools.integration.test.ts` **(NEW)** — repo persistence tests using the real Testcontainers DB (schema materialized by the migrator in `test/setup-db.ts`, which now applies the committed migrations including this workstream's `0001`). **Must** live at the repo root under `test/integration/` with the `.integration.test.ts` suffix so it is discovered by `pnpm test:integration` (root `test/vitest.integration.config.ts` + `test/setup-db.ts` globalSetup) and is NOT picked up as a unit test by `packages/db`'s default `*.test.ts` glob (which runs without a database).

> **No `test/setup-db.ts` change.** As of db-migration-baseline WS-01, the test bootstrap runs the real Drizzle migrator, so the `tools` column is created automatically once the generated `0001` migration is committed — do not hand-edit the test schema.

## Existing Interfaces to Consume

**Shared agent schemas today** (`packages/shared/src/types/agent.ts`):

```typescript
export const ModelConfigSchema = z.object({
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
}).strict();

export const AgentConfigSchema = z.object({
  name: z.string().min(1),
  modelConfig: ModelConfigSchema,
  systemPrompt: z.string(),
  memoryConfig: MemoryConfigSchema.optional(),
  toolRunnerUrl: z.string().url().nullable().optional(),
}).strict();

export const AgentRecordSchema = z.object({
  agentId: z.string().startsWith('agt_'),
  workspaceId: z.string().startsWith('ws_'),
  name: z.string().min(1),
  modelConfig: ModelConfigSchema,
  systemPrompt: z.string(),
  memoryConfig: MemoryConfigSchema,
  toolRunnerUrl: z.string().url().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
}).strict();
export type AgentRecord = z.infer<typeof AgentRecordSchema>;
```

**Drizzle `agents` table today** (`packages/db/src/schema/agents.ts`):

```typescript
export const agents = pgTable('agents', {
  agentId: text('agent_id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.workspaceId),
  name: text('name').notNull(),
  modelConfig: jsonb('model_config').notNull(),
  systemPrompt: text('system_prompt').notNull(),
  memoryConfig: jsonb('memory_config').notNull(),
  toolRunnerUrl: text('tool_runner_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('agents_workspace_id_idx').on(table.workspaceId),
  uniqueIndex('agents_workspace_id_name_idx').on(table.workspaceId, table.name),
]);
```

**`createAgentRepo` today** (`packages/db/src/repositories/agent-repo.ts`) — `create` accepts `{ agentId, workspaceId, name, modelConfig, systemPrompt, memoryConfig, toolRunnerUrl? }`; `update` accepts `Partial<{ name, modelConfig, systemPrompt, memoryConfig, toolRunnerUrl }>`; reads: `getById`, `getByWorkspaceId`, `getByName`. All return `AgentRecord`.

**API `CreateAgentBodySchema` today** (`packages/api/src/types.ts`):

```typescript
export const CreateAgentBodySchema = z.object({
  name: z.string().min(1),
  modelConfig: ModelConfigSchema,
  systemPrompt: z.string(),
  memoryConfig: MemoryConfigSchema.optional(),
  toolRunnerUrl: z.string().url().nullable().optional(),
}).strict();
```

**`agentService.registerOrUpdateAgent` today** (`packages/api/src/services/agent-service.ts`) — upserts by `(workspaceId, name)`; on existing calls `agentRepo.update(...)`, otherwise `agentRepo.create({ ..., memoryConfig: parsed.memoryConfig ?? DEFAULT_MEMORY_CONFIG, toolRunnerUrl: parsed.toolRunnerUrl ?? null })`.

**SDK `defineAgent` output** (`packages/sdk/src/agent.ts`) already computes `toolSchemas` via `tools.map(toolToJsonSchema)`. `toolToJsonSchema` (in `packages/sdk/src/tool.ts`) converts a `ToolDefinition` (Zod `inputSchema`) into a `ToolSchema` of shape `{ name, description, parameters }` where `parameters` is a JSON Schema object. `AgentDefinition.toolSchemas: readonly ToolSchema[]`.

**SDK `ControlPlaneClient.registerAgent` today** (`packages/sdk/src/client.ts`) sends only `{ name, modelConfig, systemPrompt, memoryConfig?, toolRunnerUrl? }` — **no tools**. `app.listen()` calls `client.registerAgent(...)` per agent without tool schemas.

## Normalized Tool Definition Contract

Add to `packages/shared/src/types/agent.ts`. The persisted field is `inputSchema` (a JSON Schema object). This is the single source of truth that WS-20 translates into provider-specific `ToolSchema.parameters`.

```typescript
export const ToolDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  inputSchema: z.record(z.unknown()),
}).strict();
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
```

Then extend the agent schemas:

- `AgentConfigSchema`: add `tools: z.array(ToolDefinitionSchema).optional()`.
- `AgentRecordSchema`: add `tools: z.array(ToolDefinitionSchema).default([])` so rows that predate the column (or return SQL `NULL`/absent) parse as `[]`.

## Implementation Steps

1. **Shared — tool schema (`packages/shared/src/types/agent.ts`)**: Add `ToolDefinitionSchema` and `ToolDefinition` exactly as above. Place it above `AgentConfigSchema`. Do not add an `execute` field — handlers are never serialized.

2. **Shared — extend agent schemas (same file)**: Add `tools` to `AgentConfigSchema` (optional array) and to `AgentRecordSchema` with `.default([])`. Keep `.strict()`. Because `AgentRecord` now has a defaulted field, any caller parsing a DB row missing `tools` yields `[]` (satisfies SC-02).

3. **Shared — barrel (`packages/shared/src/index.ts`)**: Export `ToolDefinitionSchema` (value) and `ToolDefinition` (type) alongside the existing agent exports.

4. **DB — schema column (`packages/db/src/schema/agents.ts`)**: Add `tools: jsonb('tools').notNull().default(sql\`'[]'::jsonb\`)` (import `sql` from `drizzle-orm`). Place it after `memoryConfig`.

5. **DB — generate the migration (`packages/db/drizzle/0001_*.sql` + `meta/0001_snapshot.json` + `_journal.json`)**: After editing the schema (step 4), run `pnpm --filter @swiftagent/db db:generate` (which runs `tsc` then `drizzle-kit generate`, reading the compiled `dist/schema/*.js` per `drizzle.config.ts`). This diffs the schema against the committed `0000_baseline` snapshot and emits a normal incremental migration — expected content roughly `ALTER TABLE "agents" ADD COLUMN "tools" jsonb DEFAULT '[]'::jsonb NOT NULL;` — plus `meta/0001_snapshot.json` and an appended `_journal.json` entry (`idx: 1`). Commit all three generated artifacts verbatim. **Do NOT hand-write the SQL, do NOT use `ADD COLUMN IF NOT EXISTS`, and do NOT hand-edit `_journal.json`** — the baseline (db-migration-baseline WS-01) made `migrate` the single source of truth and targets fresh databases, so plain generated DDL is correct. Inspect the generated SQL to confirm it only adds the `tools` column (no unexpected diffs); if it contains anything else, the schema edit or a stale `dist` build is the cause — rebuild and regenerate.

6. **Verify the migration applies**: the test bootstrap (`test/setup-db.ts`) now runs the migrator, so `pnpm test:integration` implicitly proves `0000_baseline` → `0001` applies cleanly from empty. No `_journal.json` or `test/setup-db.ts` hand-edits are needed or permitted.

7. **DB — repo (`packages/db/src/repositories/agent-repo.ts`)**:
   - `create`: add `tools?: ToolDefinition[]` to the accepted record; insert `tools: record.tools ?? []`.
   - `update`: add `tools?: ToolDefinition[]` to the `Partial<...>` updates and set it when provided.
   - All reads (`getById`, `getByWorkspaceId`, `getByName`): map the row's `tools` jsonb through `AgentRecordSchema` (or coerce `row.tools ?? []`) so callers always receive a `ToolDefinition[]`. Import `ToolDefinition` from `@swiftagent/shared`.

8. **API — request schema (`packages/api/src/types.ts`)**: Add `tools: z.array(ToolDefinitionSchema).optional()` to `CreateAgentBodySchema` (import `ToolDefinitionSchema` from `@swiftagent/shared`). Keep `.strict()`.

9. **API — service (`packages/api/src/services/agent-service.ts`)**: In `registerOrUpdateAgent`, thread `parsed.tools` into both branches:
   - Existing → `agentRepo.update(existing.agentId, { ..., tools: parsed.tools ?? existing.tools })`.
   - New → `agentRepo.create({ ..., tools: parsed.tools ?? [] })`.
   Registration remains idempotent: re-registering with the same tools yields an equivalent record.

10. **SDK — client (`packages/sdk/src/client.ts`)**: Extend `RegisterAgentBody` with `tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>` and include it in the `POST /v1/agents` body. `registerAgent` still returns `AgentRecordSchema.parse(res)` (which now includes `tools`).

11. **SDK — app (`packages/sdk/src/app.ts`)**: In `listen()`, map each agent's `toolSchemas` (shape `{ name, description, parameters }`) into the persisted contract `{ name, description, inputSchema: parameters }` and pass as `tools` to `client.registerAgent(...)`. Do not send `execute` handlers.

12. **Verify no handler leakage**: Grep `packages/sdk` and `packages/api` for `execute` to confirm the wire body and persisted record never carry handler functions.

## Tests

1. **Shared — schema accepts tools**: `AgentConfigSchema.parse({ ...valid, tools: [{ name: 'lookupOrder', description: 'x', inputSchema: { type: 'object' } }] })` succeeds.
2. **Shared — record defaults to empty**: `AgentRecordSchema.parse({ ...validRecordWithoutTools })` yields `tools: []` (SC-02).
3. **Shared — rejects handler**: parsing a tool object containing an `execute` key fails (`.strict()`).
4. **DB — create persists tools**: `agentRepo.create({ ..., tools: [t1, t2] })` then `getById` returns the same two definitions (integration, Testcontainers).
5. **DB — legacy row reads as empty**: insert an agent row via raw SQL without touching `tools` (relying on the column default), then `getById` returns `tools: []` (SC-02).
6. **DB — update replaces tools**: create with `[t1]`, `update` with `[t2]`, read returns `[t2]`.
7. **API — registration round-trip**: `POST /v1/agents` with `tools` (mocked repo) returns a body whose `tools` matches the request (SC-01).
8. **API — registration without tools defaults**: `POST /v1/agents` omitting `tools` returns `tools: []`.
9. **API — re-registration idempotent**: two identical `POST /v1/agents` calls with tools produce equal `tools` on the returned record.
10. **SDK — client sends tools**: mock fetch; assert the `POST /v1/agents` body includes `tools` with `inputSchema` (not `parameters`, not `execute`).

## Acceptance Criteria

1. `ToolDefinitionSchema` exists in `@swiftagent/shared`, is exported from the barrel, and contains only `name`, `description`, `inputSchema` (no handler).
2. `AgentConfigSchema` accepts an optional `tools` array; `AgentRecordSchema` always resolves `tools` to an array, defaulting to `[]` for legacy data (SC-02).
3. The `agents` table has a non-null `tools` jsonb column defaulting to `'[]'`, added via a `db:generate`-produced incremental migration (`0001_*.sql` + `meta/0001_snapshot.json` + appended `_journal.json` entry) layered on the `0000_baseline` — no hand-written DDL, no `IF NOT EXISTS`, no test-bootstrap edits.
4. `createAgentRepo` persists and returns `tools` on create, update, and all reads.
5. `POST /v1/agents` accepts `tools`, persists them, and returns them; omitting `tools` yields `[]` (SC-01, SC-02).
6. `ControlPlaneClient.registerAgent` and `app.listen()` transmit normalized tool definitions (`{ name, description, inputSchema }`) — never execution handlers (SC-01).
7. Agent registration remains idempotent for model config, tools, and runner config.
8. `pnpm exec tsc --noEmit` and `pnpm exec eslint . --quiet` pass across the touched packages; new unit and integration tests pass.
