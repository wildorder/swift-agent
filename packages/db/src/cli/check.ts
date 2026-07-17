import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { loadJournal } from '../snapshot.js';
import { checkDrift, renderDriftSummary } from '../drift-check.js';

/**
 * `db:check` — detect structural drift between the live `public` schema and the
 * LATEST committed snapshot. Exit codes: 0 clean, 1 drift, 2 operational error
 * (missing DATABASE_URL, unreachable DB, unparseable snapshot) so CI can
 * distinguish "drifted" from "tool broke".
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
    const latestIdx = journal.entries.reduce((max, e) => Math.max(max, e.idx), 0);
    const result = await checkDrift(sql, migrationsFolder, latestIdx);
    console.log(renderDriftSummary(result));
    await sql.end();
    process.exit(result.hasDrift ? 1 : 0);
  } catch (err) {
    console.error('migrate check failed:', err);
    await sql.end();
    process.exit(2);
  }
}

void main();
