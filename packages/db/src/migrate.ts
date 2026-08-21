import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { queryAppliedMigrations } from './migration-status.js';
import { checkDrift, planPreflight, renderDriftSummary } from './drift-check.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(__dirname, '../drizzle');

const connectionString = process.env['DATABASE_URL'];
if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is required');
}

const pool = postgres(connectionString, { max: 1 });
const db = drizzle(pool);

/**
 * Preflight drift guard (SC-03): before applying anything, verify the live
 * schema matches the LAST-APPLIED migration's snapshot. On drift, abort and
 * apply NOTHING. A never-migrated DB has no applied state to drift from → skip.
 * `MIGRATE_SKIP_DRIFT_CHECK=1` bypasses the check with a loud warning.
 * Reuses the single migrate pool; the only `pool.end()` calls live here + in
 * the success path.
 */
async function preflightDriftGuard(): Promise<void> {
  const skip = process.env['MIGRATE_SKIP_DRIFT_CHECK'] === '1';
  const appliedRows = skip ? [] : await queryAppliedMigrations(pool);
  const plan = planPreflight(process.env, appliedRows);

  if (plan.warning) {
    console.warn(plan.warning);
  }

  if (plan.action === 'skip-virgin') {
    console.log('Database has no applied migrations; skipping drift preflight.');
    return;
  }

  if (plan.action === 'check' && plan.expectedIdx !== undefined) {
    const result = await checkDrift(pool, migrationsFolder, plan.expectedIdx);
    if (result.hasDrift) {
      console.error(renderDriftSummary(result));
      console.error(
        'Aborting: database has drifted from the last-applied migration snapshot. ' +
          'No migrations applied. Set MIGRATE_SKIP_DRIFT_CHECK=1 to override.',
      );
      await pool.end();
      process.exit(1);
    }
  }
}

async function runMigrations() {
  await preflightDriftGuard();
  console.log('Running migrations...');
  console.log(`Migrations folder: ${migrationsFolder}`);
  await migrate(db, { migrationsFolder });
  console.log('Migrations complete.');
  await pool.end();
}

runMigrations().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
