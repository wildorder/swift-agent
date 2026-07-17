import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { loadJournal } from '../snapshot.js';
import { computeMigrationStatus, queryAppliedMigrations, renderStatusTable } from '../migration-status.js';

/**
 * `db:status` — report applied vs. pending migrations. Reports, never gates:
 * exits 0 unconditionally on success, 2 on operational error.
 */

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    console.error('DATABASE_URL environment variable is required');
    process.exit(2);
  }

  const sql = postgres(connectionString, { max: 1 });
  try {
    const journal = loadJournal(migrationsFolder);
    const applied = await queryAppliedMigrations(sql);
    const rows = computeMigrationStatus(journal, applied);
    console.log(renderStatusTable(rows));
  } catch (err) {
    console.error('migrate status failed:', err);
    await sql.end();
    process.exit(2);
  }
  await sql.end();
  process.exit(0);
}

void main();
