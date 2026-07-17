import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/**
 * Throwaway `PostgreSqlContainer` plumbing for the migration integration suites
 * (WS-29). The migration-baseline and migration-drift suites deliberately mutate
 * migration state and the live schema (applying the migrator from empty,
 * hand-`ALTER`ing tables, aborting `migrate`), so they must NOT touch the shared
 * globalSetup DB (`test/setup-db.ts`). Each spins its OWN container via these
 * helpers and stops it in teardown.
 *
 * The migrated variant runs the SAME real Drizzle migrator against the SAME
 * committed `packages/db/drizzle` folder that `test/setup-db.ts` and
 * `packages/db/src/migrate.ts` use — the single source of truth, no hand-written
 * DDL, no `drizzle-kit push`.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Committed migrations folder — resolved from `test/support` to `<repo>/packages/db/drizzle`. */
export const migrationsFolder = resolve(__dirname, '../../packages/db/drizzle');

export interface PgHandle {
  /** `postgres://…` connection string for the container. */
  url: string;
  /** Raw postgres.js client (`sql` tag) — drives raw DDL + the WS-26 tooling. */
  sql: ReturnType<typeof postgres>;
  /** Drizzle handle over the same client — used by the real migrator. */
  db: PostgresJsDatabase<Record<string, never>>;
  container: StartedPostgreSqlContainer;
  /** End the `sql` pool and stop the container. Idempotent-safe per suite. */
  teardown(): Promise<void>;
}

async function startContainer(): Promise<PgHandle> {
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('swiftagent_migration_test')
    .withUsername('test')
    .withPassword('test')
    .start();

  const url = container.getConnectionUri();
  const sql = postgres(url, { max: 1 });
  const db = drizzle(sql);

  return {
    url,
    sql,
    db,
    container,
    async teardown() {
      await sql.end();
      await container.stop();
    },
  };
}

/** Boot a container with an EMPTY schema — the migrator has NOT been run. */
export function startEmptyContainer(): Promise<PgHandle> {
  return startContainer();
}

/** Boot a container and apply the real Drizzle migrations (single source of truth). */
export async function startMigratedContainer(): Promise<PgHandle> {
  const handle = await startContainer();
  await migrate(handle.db, { migrationsFolder });
  return handle;
}
