import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

let container: StartedPostgreSqlContainer;

export async function setup() {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('swiftagent_test')
    .withUsername('test')
    .withPassword('test')
    .start();

  process.env['DATABASE_URL'] = container.getConnectionUri();
  console.log(`[testcontainers] Postgres started at ${container.getConnectionUri()}`);
}

export async function teardown() {
  if (container) {
    await container.stop();
    console.log('[testcontainers] Postgres stopped');
  }
}
