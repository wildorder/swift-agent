# WS-15: Management Data Layer

## Goal

Introduce the **management data layer**: Drizzle schemas and migrations for `users` and `user_workspaces`, factory repositories (`createUserRepo`, `createUserWorkspaceRepo`), shared Zod record types, `PREFIX_USER` + `generateUserId()`, and Testcontainers-backed integration tests. This enables later management routes to map Cognito `sub` → `usr_` rows, list memberships, and authorize with `isMember(userId, workspaceId)`.

Follow existing `@swiftagent/db` and `@swiftagent/shared` conventions: **Drizzle + postgres.js** (not `pg`), factory repos `createXxxRepo(db: Db)`, barrel exports, prefixed nanoid IDs, Zod as runtime source of truth.

## Dependencies

- **product-x WS-02** (Shared Types) — Zod schemas, `z.infer`, shared package export patterns.
- **product-x WS-03** (Database) — `packages/db` client, Drizzle config, migration workflow.

## Context Files (Agent MUST read before implementing)

- `c:\dev\swift-agent\packages\db\src\schema\workspaces.ts`
- `c:\dev\swift-agent\packages\db\src\schema\index.ts`
- `c:\dev\swift-agent\packages\db\src\repositories\workspace-repo.ts`
- `c:\dev\swift-agent\packages\db\src\repositories\index.ts`
- `c:\dev\swift-agent\packages\db\src\index.ts`
- `c:\dev\swift-agent\packages\db\drizzle.config.ts`
- `c:\dev\swift-agent\packages\shared\src\types\workspace.ts`
- `c:\dev\swift-agent\packages\shared\src\constants.ts`
- `c:\dev\swift-agent\packages\shared\src\utils\id.ts`
- `c:\dev\swift-agent\packages\shared\src\index.ts`
- `c:\dev\swift-agent\test\setup-db.ts`
- `c:\dev\swift-agent\test\integration\db.integration.test.ts`

## Package

- `c:\dev\swift-agent\packages\db\` — schema, repos, Drizzle migration output.
- `c:\dev\swift-agent\packages\shared\` — constants, ID helper, Zod types, barrel exports.
- Root `c:\dev\swift-agent\test\` — Testcontainers DDL parity and integration tests.

## Files Touched

- `packages/db/src/schema/users.ts` **(NEW)** — `users` table; `cognito_sub` **unique**.
- `packages/db/src/schema/user-workspaces.ts` **(NEW)** — join table; **composite PK `(userId, workspaceId)`** (duplicate memberships impossible).
- `packages/db/src/schema/index.ts` **(MODIFY)** — export new tables.
- `packages/db/src/repositories/user-repo.ts` **(NEW)** — `createUserRepo`.
- `packages/db/src/repositories/user-workspace-repo.ts` **(NEW)** — `createUserWorkspaceRepo`.
- `packages/db/src/repositories/index.ts` **(MODIFY)** — export factories and `*Repo` types.
- `packages/db/src/index.ts` **(MODIFY)** — re-export per existing pattern.
- `packages/db/drizzle/` **(MODIFY)** — new generated SQL from `drizzle-kit generate`.
- `packages/shared/src/constants.ts` **(MODIFY)** — `PREFIX_USER = 'usr_'`.
- `packages/shared/src/utils/id.ts` **(MODIFY)** — `generateUserId()` using existing `prefixedId`.
- `packages/shared/src/types/user.ts` **(NEW)** — `UserRecordSchema` / `UserRecord`.
- `packages/shared/src/types/user-workspace.ts` **(NEW)** — `UserWorkspaceRecordSchema` / `UserWorkspaceRecord`.
- `packages/shared/src/index.ts` **(MODIFY)** — export schemas, types, constant, generator.
- `packages/shared/src/index.test.ts` **(MODIFY)** — parse tests mirroring `WorkspaceRecord` style.
- `test/setup-db.ts` **(MODIFY)** — raw DDL aligned with migration for integration tests.
- `test/integration/db.integration.test.ts` **(MODIFY)** — repo tests (Vitest + **Testcontainers Postgres**).

## Existing Interfaces to Consume

- **Schema** — `pgTable`, `text`, `timestamp(..., { withTimezone: true })`, `.notNull()`, `.defaultNow()`, PK/unique/FK as in `workspaces.ts`.
- **`WorkspaceRecord` / `WorkspaceRecordSchema`** — `.strict()`, ID prefix checks, `z.coerce.date()` for timestamps.
- **`createWorkspaceRepo` / `WorkspaceRepo`** — `insert…returning()`, `eq`, `toRecord(row: typeof table.$inferSelect)`.
- **`Db`** from `packages/db` client — repos take `db: Db` only.
- **`prefixedId` + `DEFAULT_NANOID_LENGTH`** — add `PREFIX_USER` and `generateUserId()` alongside `generateWorkspaceId()`.

## Implementation Steps

1. **Shared** — Add `PREFIX_USER = 'usr_'` to `constants.ts`. Add `generateUserId()` in `id.ts` (same pattern as `generateWorkspaceId()`). Export from `shared/src/index.ts`.

2. **Zod types** — `UserRecordSchema`: `userId` (`usr_` prefix), `cognitoSub` (non-empty), `email` (valid email), `createdAt`, `updatedAt` (coerced dates). `UserWorkspaceRecordSchema`: `userId`, `workspaceId` (`ws_` prefix), `role`: `z.enum(['owner', 'member'])`, `createdAt`. Use `.strict()`; export `z.infer` types. Extend `index.test.ts`.

3. **Schema `users`** — Columns: `userId` → `user_id` text PK; `cognitoSub` → `cognito_sub` text not null **with unique constraint** (unique index); `email` text not null; `createdAt` / `updatedAt` timestamptz not null, `defaultNow()` on both (mirror `workspaces`).

4. **Schema `user_workspaces`** — **Composite primary key** on `(user_id, workspace_id)`. Columns: `role` text not null (app validates `'owner' | 'member'` via Zod; DB stores plain text); `created_at` timestamptz not null `defaultNow()`. FKs: `user_id` → `users.user_id`, `workspace_id` → `workspaces.workspace_id`. Prefer `onDelete: 'restrict'` unless a product doc mandates cascade; document in a short SQL comment if non-default.

5. **`createUserRepo(db)`** — `create({ userId, cognitoSub, email })` → `UserRecord` (timestamps from DB via `returning()`); `getByCognitoSub` → `UserRecord | null`; `getById` → `UserRecord | null`; private `toRecord`.

6. **`createUserWorkspaceRepo(db)`** — `create({ userId, workspaceId, role })` → `UserWorkspaceRecord`; `listByUserId(userId)` → array (order by `created_at` ascending); `getByUserAndWorkspace` → `UserWorkspaceRecord | null`; **`isMember(userId, workspaceId): Promise<boolean>`** — minimal existence query (`limit 1`) for route authorization.

7. **Barrels** — Update `schema/index.ts`, `repositories/index.ts`, `packages/db/src/index.ts`, `packages/shared/src/index.ts` to match existing export style.

8. **Migration** — From `packages/db`, run `drizzle-kit generate` so `packages/db/drizzle/` contains a new migration. Do not hand-edit generated SQL except to fix generator bugs; re-verify after edits.

9. **Tests** — Update `test/setup-db.ts` DDL to match migration. Extend `db.integration.test.ts`: create user (`generateUserId()`), seed workspace, create membership; assert repo methods; verify duplicate `(userId, workspaceId)` insert fails (composite PK).

## Tests

- **Unit (shared):** `packages/shared/src/index.test.ts` — valid/invalid parses for new schemas (bad prefixes, email, role).
- **Integration:** `test/integration/db.integration.test.ts` with `test/setup-db.ts` — **Vitest + `@testcontainers/postgresql`**, same global `DATABASE_URL` pattern as existing DB tests.

## Acceptance Criteria

1. `users` exists with `user_id` (PK `usr_`), **`cognito_sub` unique**, `email`, `created_at`, `updated_at` (timestamptz, defaults consistent with `workspaces`).
2. `user_workspaces` exists with **composite PK `(user_id, workspace_id)`**, `role` (text storing owner/member), `created_at`, FKs to `users` and `workspaces`.
3. `createUserRepo` exposes `create`, `getByCognitoSub`, `getById`; mappings return shared `UserRecord` shapes.
4. `createUserWorkspaceRepo` exposes `create`, `listByUserId`, `getByUserAndWorkspace`, and **`isMember` → boolean**.
5. `UserRecord` / `UserWorkspaceRecord` Zod schemas and types live in `@swiftagent/shared` and validate ID prefixes and role.
6. `PREFIX_USER` and `generateUserId()` are exported from `@swiftagent/shared`.
7. Schema, repository, and package barrels updated; `@swiftagent/db` public API exports new repos and types.
8. New Drizzle migration applies cleanly; `test/setup-db.ts` stays in sync for Testcontainers.
9. Typecheck and ESLint pass for touched code; new tests pass.
