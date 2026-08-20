import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { checkDrift, DRIFT_SKIP_WARNING } from '@swiftagent/db';
import { startMigratedContainer, migrationsFolder, type PgHandle } from '../support/pg-container.js';

/**
 * WS-29 · Migration drift + preflight guard (SC-02 / SC-03). Proves the WS-26
 * drift check is false-positive-free on a clean DB, fires on an injected raw-SQL
 * divergence, and that the `migrate` preflight guard aborts (applying nothing)
 * on drift while `MIGRATE_SKIP_DRIFT_CHECK=1` bypasses it.
 *
 * Isolation: OWN throwaway container(s) — these tests hand-`ALTER` the live
 * schema and run the migrator, so they must never touch the shared DB.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
// Compiled forward migrator entry (built by `pnpm --filter @swiftagent/db build`).
const migrateDistPath = resolve(__dirname, '../../packages/db/dist/migrate.js');

const CONTAINER_TIMEOUT_MS = 120_000;
const LATEST_IDX = 3; // 4 committed migrations → last-applied ordinal is 3.

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the compiled migrate CLI as a child process, capturing its exit code. */
function runMigrateCli(url: string, extraEnv: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      process.execPath,
      [migrateDistPath],
      { env: { ...process.env, DATABASE_URL: url, ...extraEnv } },
      (err, stdout, stderr) => {
        if (err && typeof (err as NodeJS.ErrnoException).code !== 'number' && err.signal == null) {
          // A spawn failure (e.g. missing node) — surface it rather than mask as exit 0.
          rejectPromise(err);
          return;
        }
        const code =
          err && typeof (err as { code?: number }).code === 'number'
            ? (err as { code: number }).code
            : 0;
        resolvePromise({ code, stdout, stderr });
      },
    );
  });
}

async function bookkeepingCount(pg: PgHandle): Promise<number> {
  const rows = await pg.sql<{ id: number }[]>`SELECT id FROM drizzle.__drizzle_migrations`;
  return rows.length;
}

describe('migration-drift detection (SC-02)', () => {
  let pg: PgHandle;

  beforeAll(async () => {
    pg = await startMigratedContainer();
  }, CONTAINER_TIMEOUT_MS);

  afterAll(async () => {
    if (pg) await pg.teardown();
  });

  // Assert the false-positive firewall FIRST, before any mutation: a clean,
  // freshly-migrated DB must report ZERO drift. A false positive here would
  // block every clean deploy under the CI drift guard (WS-27).
  it('reports NO drift on a cleanly-migrated schema (false-positive firewall)', async () => {
    const result = await checkDrift(pg.sql, migrationsFolder, LATEST_IDX);
    expect(result.hasDrift).toBe(false);
    expect(result.differences).toEqual([]);
  });

  // Runs after the negative case (same container) — deliberately last, since it
  // mutates the live schema.
  it('detects drift when a committed column is dropped via raw SQL', async () => {
    await pg.sql`ALTER TABLE agents DROP COLUMN tools`;

    const result = await checkDrift(pg.sql, migrationsFolder, LATEST_IDX);
    expect(result.hasDrift).toBe(true);
    const diff = result.differences.find((d) => d.object === 'agents.tools');
    expect(diff).toBeDefined();
    expect(diff!.kind).toBe('column');
    expect(diff!.detail).toBe('missing_in_db');
  });
});

describe('migrate preflight guard (SC-03)', () => {
  let pg: PgHandle;

  beforeAll(async () => {
    if (!existsSync(migrateDistPath)) {
      throw new Error(
        `Compiled migrate entry not found at ${migrateDistPath}. ` +
          'Run `pnpm --filter @swiftagent/db build` before the integration suite.',
      );
    }
    pg = await startMigratedContainer();
    // Inject drift: drop a committed column so the preflight guard must fire.
    await pg.sql`ALTER TABLE agents DROP COLUMN tools`;
  }, CONTAINER_TIMEOUT_MS);

  afterAll(async () => {
    if (pg) await pg.teardown();
  });

  it('aborts on drift with a non-zero exit and applies NOTHING', async () => {
    const before = await bookkeepingCount(pg);

    const result = await runMigrateCli(pg.url);
    expect(result.code).not.toBe(0);

    // Nothing was "fixed": the injected drift is still present.
    const drift = await checkDrift(pg.sql, migrationsFolder, LATEST_IDX);
    expect(drift.hasDrift).toBe(true);

    // No new bookkeeping row — the migrator applied nothing.
    const after = await bookkeepingCount(pg);
    expect(after).toBe(before);
  }, CONTAINER_TIMEOUT_MS);

  it('bypasses the guard with MIGRATE_SKIP_DRIFT_CHECK=1 (exit 0, loud warning)', async () => {
    const before = await bookkeepingCount(pg);

    const result = await runMigrateCli(pg.url, { MIGRATE_SKIP_DRIFT_CHECK: '1' });
    expect(result.code).toBe(0);
    // Loud warning on stderr — the escape hatch is never silent.
    expect(result.stderr).toContain(DRIFT_SKIP_WARNING);

    // A head-migrated DB has no pending migrations, so the bypass proceeds past
    // the guard but still applies nothing — the assertion is that it did NOT abort.
    const after = await bookkeepingCount(pg);
    expect(after).toBe(before);
  }, CONTAINER_TIMEOUT_MS);
});
