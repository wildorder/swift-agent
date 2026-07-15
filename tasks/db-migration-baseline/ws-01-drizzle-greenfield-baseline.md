# WS-01: Drizzle Greenfield Migration Baseline

## Goal

Make Drizzle migrations the single, authoritative source of truth for the database schema by generating a **complete greenfield baseline migration** that materializes every current table, enum, index, and foreign key from an empty database, replacing the broken partial `0000_add_users_and_user_workspaces.sql` (which only creates `users`/`user_workspaces` and even foreign-keys a `workspaces` table that no migration creates). This unblocks a clean `migrate`-from-empty path for local dev, CI, tests, and deploys, eliminates the hand-maintained raw-SQL schema in `test/setup-db.ts`, and removes the reliance on `drizzle-kit push` / hand-synced DDL. **Scope: fresh databases only** — already-provisioned dev/prod databases are reconciled manually (out of scope) — and **`migrate` is the only schema path** (`push` is dropped).

## Traceability

- **DB-SC-01** — A single `migrate` run against an empty PostgreSQL creates the entire current schema (all tables, enums, indexes, FKs) with no errors and no missing dependencies.
- **DB-SC-02** — The Drizzle schema (`packages/db/src/schema/*.ts`) is the sole source of truth; the migration journal + snapshot are consistent, so future `drizzle-kit generate` produces correct incremental diffs (e.g. the core-runtime-completion `tools` column and `run_status` values).
- **DB-SC-03** — Tests, CI, and deploy all obtain their schema exclusively via `migrate` (no hand-written SQL, no `push`).

## Dependencies

None. This is a prerequisite for `core-runtime-completion` (which should be reauthored afterward to layer normal incremental migrations on this baseline).

## Context Files (Agent MUST read before implementing)

- `c:\dev\swift-agent\CLAUDE.md` — conventions (Drizzle ORM ^0.36, drizzle-kit ^0.30, postgres.js, ESM).
- `c:\dev\swift-agent\packages\db\drizzle.config.ts` — drizzle-kit config (`schema: ./src/schema/*.ts`, `out: ./drizzle`, dialect postgresql).
- `c:\dev\swift-agent\packages\db\src\schema\*.ts` — the 11 schema modules that define the target schema (see inventory below).
- `c:\dev\swift-agent\packages\db\src\schema\index.ts` — barrel listing all tables/enums.
- `c:\dev\swift-agent\packages\db\src\migrate.ts` — the migrator CLI entry (`migrate(db, { migrationsFolder })`).
- `c:\dev\swift-agent\packages\db\package.json` — scripts (no `migrate` script today).
- `c:\dev\swift-agent\packages\db\drizzle\0000_add_users_and_user_workspaces.sql` — the broken partial baseline to remove.
- `c:\dev\swift-agent\packages\db\drizzle\meta\_journal.json` — empty journal (`{"version":"7","dialect":"postgresql","entries":[]}`).
- `c:\dev\swift-agent\test\setup-db.ts` — Testcontainers globalSetup with hand-written raw-SQL schema (to be replaced by `migrate`).
- `c:\dev\swift-agent\test\vitest.integration.config.ts` — integration config (`globalSetup: ['./test/setup-db.ts']`).
- `c:\dev\swift-agent\.github\workflows\ci.yml` — `integration-tests` job (stale `pnpm --filter @swiftagent/db migrate` step + redundant `postgres` service).
- `c:\dev\swift-agent\apps\server\src\main.ts` — `AUTO_MIGRATE` path (already uses the migrator; verify unaffected).
- `c:\dev\swift-agent\.github\workflows\deploy-*.yml` + `infra/migrate.sh` — production migrate path (`node .../migrate.js`); already migrate-based — verify the new baseline is what they apply.

## Package

`packages/db`, `test/` (root integration harness), `.github/workflows`.

## Files Touched

- `packages/db/drizzle/0000_add_users_and_user_workspaces.sql` **(DELETE)** — broken partial baseline.
- `packages/db/drizzle/0000_<generated_name>.sql` **(NEW)** — full greenfield baseline emitted by `drizzle-kit generate`.
- `packages/db/drizzle/meta/0000_snapshot.json` **(NEW)** — snapshot emitted by `drizzle-kit generate` (enables correct future diffs).
- `packages/db/drizzle/meta/_journal.json` **(MODIFY)** — regenerated to contain exactly the one baseline entry (drizzle-kit writes this).
- `packages/db/package.json` **(MODIFY)** — add `db:generate` and `migrate` scripts (see below).
- `test/setup-db.ts` **(MODIFY)** — replace the hand-written raw-SQL `CREATE TYPE`/`CREATE TABLE` block with a call to the Drizzle migrator against the container.
- `.github/workflows/ci.yml` **(MODIFY)** — remove the stale/duplicate migrate step and the now-unused `postgres` service (Testcontainers provisions the DB); keep `pnpm test:integration`.

## Existing Interfaces to Consume

**Schema inventory** (target of the baseline — from `packages/db/src/schema/`):

| Table | Enum(s) | Notable columns / constraints |
|---|---|---|
| `workspaces` | — | `workspace_id` PK, `name`, timestamps |
| `users` | — | `user_id` PK, `cognito_sub` UNIQUE, `email`, timestamps |
| `user_workspaces` | — | composite PK (`user_id`,`workspace_id`), FKs→users/workspaces `ON DELETE restrict`, `role` |
| `api_keys` | — | `api_key_id` PK, FK→workspaces, `key_hash`, indexes on `key_hash` + `workspace_id` |
| `agents` | — | `agent_id` PK, FK→workspaces, jsonb `model_config`/`memory_config`, `tool_runner_url`, index on `workspace_id`, unique(`workspace_id`,`name`) |
| `sessions` | `session_status('active','closed')` | `session_id` PK, FK→agents, `status` default `active`, jsonb `metadata`, indexes on `agent_id`,`user_id` |
| `runs` | `run_status('running','completed','failed')` | `run_id` PK, FK→sessions, `status` default `running`, `model varchar(255)`, jsonb `token_usage`, index on `session_id` |
| `messages` | `message_role('system','user','assistant','tool')` | `message_id` PK, FK→sessions, nullable FK→runs, indexes on (`session_id`,`created_at`) + `run_id` |
| `tool_calls` | `tool_call_status('started','completed','failed')` | `call_id` PK, FK→runs, jsonb `input`/`output`, `status` default `started`, index on `run_id` |
| `traces` | — | `trace_id` PK, FK→runs, `root_span_id`, `total_duration_ms`, unique index on `run_id` |
| `trace_spans` | `span_type(...)`, `span_status('ok','error')` | `span_id` PK, FK→traces, `parent_span_id`, `type`, jsonb `metadata` default `{}`, `status` default `ok`, jsonb `error`, index on `trace_id` |

> The baseline must reflect the **current committed schema exactly** (e.g. `agents` has NO `tools` column yet, `run_status` has only the three original values). The core-runtime-completion workstreams add those as normal incremental migrations after this baseline.

**Migrator CLI today** (`packages/db/src/migrate.ts`): resolves `migrationsFolder = ../drizzle`, requires `DATABASE_URL`, calls `migrate(drizzle(postgres(url,{max:1})), { migrationsFolder })`. Compiled to `packages/db/dist/migrate.js` (what deploy/`infra/migrate.sh` run).

**`test/setup-db.ts` today**: starts a `PostgreSqlContainer('postgres:16-alpine')`, sets `process.env.DATABASE_URL`, then `sql.unsafe('CREATE TYPE ...; CREATE TABLE ...')` by hand for all tables. This duplicated DDL is the drift risk being removed.

## Implementation Steps

1. **Add scripts (`packages/db/package.json`)**: add
   - `"db:generate": "drizzle-kit generate"` — regenerate migrations from the schema.
   - `"migrate": "node dist/migrate.js"` — run the compiled migrator (fixes the CI/`pnpm --filter @swiftagent/db migrate` reference and matches the deploy command). Requires a prior `pnpm --filter @swiftagent/db build`.

2. **Reset the broken baseline artifacts (`packages/db/drizzle/`)**: delete `0000_add_users_and_user_workspaces.sql`. Ensure `meta/` contains no stale snapshot files and `_journal.json` is `{"version":"7","dialect":"postgresql","entries":[]}` (it already is). This gives `drizzle-kit generate` a clean initial state so it emits a single full baseline.

3. **Generate the greenfield baseline**: run `pnpm --filter @swiftagent/db exec drizzle-kit generate --name baseline` (no `DATABASE_URL` needed for generate). Verify it produced:
   - `drizzle/0000_baseline.sql` (or drizzle's chosen suffix) containing **all** enums (`CREATE TYPE`), all 11 tables (`CREATE TABLE`), all indexes/unique indexes, and all FK `ALTER TABLE ... ADD CONSTRAINT` statements, ordered so dependencies exist before references (drizzle emits tables then FKs).
   - `drizzle/meta/0000_snapshot.json`.
   - `drizzle/meta/_journal.json` with exactly one entry (`idx: 0`, matching `tag`).
   Inspect the SQL and confirm every table from the inventory is present and no FK references a not-yet-created table.

4. **Replace hand-written test schema (`test/setup-db.ts`)**: in `setup()`, after the container starts and `DATABASE_URL` is set, replace the `sql.unsafe('CREATE TYPE ...')` block with a Drizzle migrator run so tests use the exact same migrations as prod:
   ```ts
   import { drizzle } from 'drizzle-orm/postgres-js';
   import { migrate } from 'drizzle-orm/postgres-js/migrator';
   import { fileURLToPath } from 'node:url';
   import { dirname, resolve } from 'node:path';
   // ...
   const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../packages/db/drizzle');
   const migrationSql = postgres(connectionUri, { max: 1 });
   await migrate(drizzle(migrationSql), { migrationsFolder });
   await migrationSql.end();
   ```
   Remove the entire hand-written `CREATE TYPE`/`CREATE TABLE` string. Keep the container start/stop and `DATABASE_URL` export. (The root workspace already depends on `drizzle-orm` transitively via `@swiftagent/db`; if the import does not resolve at the root, add `drizzle-orm` to the root `package.json` devDependencies.)

5. **CI cleanup (`.github/workflows/ci.yml`)**: in the `integration-tests` job, remove the `- name: Run database migrations` step (`pnpm --filter @swiftagent/db migrate` against the CI `postgres` service) — `test/setup-db.ts` now provisions and migrates its own Testcontainers database. Also remove the now-unused `postgres` service block (keep `redis` if used). Keep the `Build` step (needed so `dist/migrate.js` exists if any step calls `migrate`) and `pnpm test:integration`.

6. **Verify migrate path parity**: confirm `apps/server/src/main.ts` (`AUTO_MIGRATE`) and the deploy workflows/`infra/migrate.sh` point at `packages/db/drizzle` / `dist/migrate.js` — no change needed, but they must now apply the new complete baseline. Do not alter them unless a path is wrong.

7. **No `push`**: confirm nothing in CI/deploy invokes `drizzle-kit push`; leave `db:generate` as the only drizzle-kit authoring command. Document in the `packages/db` scripts that schema changes flow: edit `src/schema/*.ts` → `pnpm db:generate` → commit the new migration + snapshot.

## Tests

1. **Migrate-from-empty (DB-SC-01)**: against a fresh Testcontainers PostgreSQL, run the migrator; assert it completes with no error and that `information_schema` shows all 11 tables and all 4 enums with the correct values. (This is exercised implicitly by the existing root integration suites now that `setup-db.ts` migrates.)
2. **Existing integration suites still green (DB-SC-03)**: `test/integration/db.integration.test.ts` and `management.integration.test.ts` pass unchanged against the migrated schema (proving the baseline matches the hand-written schema they relied on).
3. **Idempotent re-run**: running the migrator twice against the same DB is a no-op on the second run (drizzle records applied migrations in `__drizzle_migrations`).
4. **Future-diff sanity (DB-SC-02)**: after adding a throwaway nullable column to a schema file and running `drizzle-kit generate`, exactly one new incremental migration is produced (not a full baseline) — proving the snapshot is consistent. (Revert the throwaway change; this is a manual/one-off check, not a committed test.)

## Acceptance Criteria

1. A single `0000` greenfield baseline migration (+ matching `meta/0000_snapshot.json` and one-entry `_journal.json`) creates the entire current schema from empty, in dependency-correct order; the broken partial `0000_add_users_and_user_workspaces.sql` is deleted.
2. `packages/db` exposes a working `migrate` script (`node dist/migrate.js`) and a `db:generate` script; `pnpm --filter @swiftagent/db migrate` succeeds against a fresh DB with `DATABASE_URL` set (after build).
3. `test/setup-db.ts` obtains its schema by running the Drizzle migrator (no hand-written DDL); the root integration suites pass.
4. CI no longer references a nonexistent migrate script or a redundant DB service; deploy/`AUTO_MIGRATE` continue to apply the same baseline.
5. `drizzle-kit push` is not used anywhere; `migrate` is the single source of truth.
6. `pnpm -w exec tsc --noEmit` and `pnpm -w exec eslint . --quiet` pass; `pnpm test` (unit) and `pnpm test:integration` pass.
