import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import {
  loadJournal,
  queryAppliedMigrations,
  computeMigrationStatus,
} from '@swiftagent/db';
import {
  startEmptyContainer,
  startMigratedContainer,
  migrationsFolder,
  type PgHandle,
} from '../support/pg-container.js';

/**
 * WS-29 · Migration baseline (SC-10 / SC-01). Proves the committed Drizzle
 * migrations, applied by the REAL forward migrator against a throwaway
 * `postgres:16-alpine`, materialize the deployed schema shape and are correctly
 * reflected by the WS-26 `migrate status` reporter.
 *
 * Isolation: this suite runs its OWN container (never the shared globalSetup DB)
 * because it inspects/mutates migration bookkeeping state.
 */

const CONTAINER_TIMEOUT_MS = 120_000;

// The 13 application tables materialized by the baseline + increments. The
// migrator's own `drizzle.__drizzle_migrations` lives in the `drizzle` schema
// and is excluded by the `public` filter.
const EXPECTED_TABLES = [
  'agents',
  'api_keys',
  'messages',
  'playground_spend_days',
  'playground_spend_reservations',
  'runs',
  'sessions',
  'tool_calls',
  'trace_spans',
  'traces',
  'user_workspaces',
  'users',
  'workspaces',
].sort();

const JOURNAL_TAGS = [
  '0000_baseline',
  '0001_conscious_steel_serpent',
  '0002_reflective_maverick',
  '0003_lame_kronos',
];

describe('migration-baseline (SC-10 / SC-01)', () => {
  let pg: PgHandle;
  const journal = loadJournal(migrationsFolder);

  beforeAll(async () => {
    // Boots empty, then applies the real migrator once — i.e. baseline-from-empty.
    pg = await startMigratedContainer();
  }, CONTAINER_TIMEOUT_MS);

  afterAll(async () => {
    if (pg) await pg.teardown();
  });

  it('baseline-from-empty materializes all 13 tables, the run_status + span enums, and agents.tools', async () => {
    const tableRows = await pg.sql<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;
    const tables = tableRows.map((r) => r.table_name);
    expect(tables).toHaveLength(EXPECTED_TABLES.length);
    expect(tables).toEqual(expect.arrayContaining(EXPECTED_TABLES));

    // 0002 added the `cancelled` + `timed_out` run_status values.
    const runStatusRows = await pg.sql<{ value: string }[]>`
      SELECT e.enumlabel AS value
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'run_status'
      ORDER BY e.enumsortorder
    `;
    const runStatuses = runStatusRows.map((r) => r.value);
    expect(runStatuses).toEqual(expect.arrayContaining(['cancelled', 'timed_out']));

    // 0001 added agents.tools.
    const toolsCol = await pg.sql<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'agents' AND column_name = 'tools'
    `;
    expect(toolsCol).toHaveLength(1);

    // Baseline (0000) created the span_type + span_status enums.
    const enumTypeRows = await pg.sql<{ typname: string }[]>`
      SELECT t.typname
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typtype = 'e'
    `;
    const enumNames = enumTypeRows.map((r) => r.typname);
    expect(enumNames).toEqual(expect.arrayContaining(['span_type', 'span_status', 'run_status']));
  });

  it('records one ordered bookkeeping row per journal entry and computes all APPLIED in journal order', async () => {
    const rows = await pg.sql<{ id: number | string; created_at: number | string }[]>`
      SELECT id, created_at
      FROM drizzle.__drizzle_migrations
      ORDER BY created_at ASC, id ASC
    `;
    expect(rows).toHaveLength(JOURNAL_TAGS.length);

    const applied = await queryAppliedMigrations(pg.sql);
    const status = computeMigrationStatus(journal, applied);
    expect(status.map((s) => s.tag)).toEqual(JOURNAL_TAGS);
    expect(status.every((s) => s.status === 'APPLIED')).toBe(true);
  });

  it('is idempotent: a second migrate is a no-op with no duplicate bookkeeping rows', async () => {
    // Re-run the real migrator against the already-head DB.
    await expect(migrate(pg.db, { migrationsFolder })).resolves.toBeUndefined();

    const rows = await pg.sql<{ id: number }[]>`
      SELECT id FROM drizzle.__drizzle_migrations
    `;
    expect(rows).toHaveLength(JOURNAL_TAGS.length);

    // Schema is unchanged — still exactly the 13 application tables.
    const tableRows = await pg.sql<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    expect(tableRows).toHaveLength(EXPECTED_TABLES.length);
  });

  it('migrate status accuracy: migrated DB reports all APPLIED with appliedAt, none PENDING (SC-01)', async () => {
    const applied = await queryAppliedMigrations(pg.sql);
    const status = computeMigrationStatus(journal, applied);

    expect(status).toHaveLength(JOURNAL_TAGS.length);
    for (const entry of status) {
      expect(entry.status).toBe('APPLIED');
      expect(typeof entry.appliedAt).toBe('number');
    }
    expect(status.some((s) => s.status === 'PENDING')).toBe(false);
  });

  it('migrate status accuracy: an un-migrated DB reports no applied rows and all PENDING (SC-01)', async () => {
    const empty = await startEmptyContainer();
    try {
      const applied = await queryAppliedMigrations(empty.sql);
      expect(applied).toEqual([]);

      const status = computeMigrationStatus(journal, applied);
      expect(status).toHaveLength(JOURNAL_TAGS.length);
      expect(status.map((s) => s.tag)).toEqual(JOURNAL_TAGS);
      expect(status.every((s) => s.status === 'PENDING')).toBe(true);
    } finally {
      await empty.teardown();
    }
  }, CONTAINER_TIMEOUT_MS);
});
