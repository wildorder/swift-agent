import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

let container: StartedPostgreSqlContainer;

const __dirname = dirname(fileURLToPath(import.meta.url));
// Single source of truth: apply the same Drizzle migrations used by CI/deploy.
const migrationsFolder = resolve(__dirname, '../packages/db/drizzle');

export async function setup() {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('swiftagent_test')
    .withUsername('test')
    .withPassword('test')
    .start();

  const connectionUri = container.getConnectionUri();
  process.env['DATABASE_URL'] = connectionUri;
  console.log(`[testcontainers] Postgres started at ${connectionUri}`);

  // Materialize the schema by running the real Drizzle migrations (no hand-written DDL).
  const migrationSql = postgres(connectionUri, { max: 1 });
  try {
    await migrate(drizzle(migrationSql), { migrationsFolder });
    console.log('[testcontainers] Migrations applied');
  } finally {
    await migrationSql.end();
  }
}

export async function teardown() {
  if (container) {
    await container.stop();
    console.log('[testcontainers] Postgres stopped');
  }
}
