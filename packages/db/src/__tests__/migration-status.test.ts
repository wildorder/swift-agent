import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  computeMigrationStatus,
  queryAppliedMigrations,
  renderStatusTable,
  resolveLastAppliedIdx,
  type AppliedRow,
} from '../migration-status.js';
import { loadJournal, type Journal } from '../snapshot.js';

const fixturesFolder = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

const journal3: Journal = {
  version: '7',
  dialect: 'postgresql',
  entries: [
    { idx: 0, tag: '0000_baseline' },
    { idx: 1, tag: '0001_conscious_steel_serpent' },
    { idx: 2, tag: '0002_reflective_maverick' },
  ],
};

function appliedRow(id: number, createdAt: number): AppliedRow {
  return { id, hash: `hash_${id}`, created_at: createdAt };
}

describe('computeMigrationStatus', () => {
  it('marks every journal entry PENDING on a virgin DB (SC-01)', () => {
    const rows = computeMigrationStatus(journal3, []);
    expect(rows.map((r) => r.status)).toEqual(['PENDING', 'PENDING', 'PENDING']);
    expect(rows.map((r) => r.tag)).toEqual([
      '0000_baseline',
      '0001_conscious_steel_serpent',
      '0002_reflective_maverick',
    ]);
    expect(renderStatusTable(rows).match(/PENDING/g)).toHaveLength(3);
  });

  it('marks all APPLIED and ordinal-zips tags to rows (SC-01)', () => {
    const applied = [appliedRow(1, 1000), appliedRow(2, 2000), appliedRow(3, 3000)];
    const rows = computeMigrationStatus(journal3, applied);
    expect(rows.map((r) => r.status)).toEqual(['APPLIED', 'APPLIED', 'APPLIED']);
    // ordinal mapping: tag 0000 <-> row0, 0001 <-> row1, 0002 <-> row2
    expect(rows[0]).toMatchObject({ tag: '0000_baseline', appliedAt: 1000, hash: 'hash_1' });
    expect(rows[2]).toMatchObject({ tag: '0002_reflective_maverick', appliedAt: 3000, hash: 'hash_3' });
  });

  it('marks the trailing unapplied entry PENDING on a partial DB (SC-01)', () => {
    const applied = [appliedRow(1, 1000), appliedRow(2, 2000)];
    const rows = computeMigrationStatus(journal3, applied);
    expect(rows.map((r) => r.status)).toEqual(['APPLIED', 'APPLIED', 'PENDING']);
    expect(rows[2]).toMatchObject({ tag: '0002_reflective_maverick', status: 'PENDING' });
    expect(rows[2]?.appliedAt).toBeUndefined();
  });

  it('reports surplus bookkeeping rows as trailing UNKNOWN and still exits 0-worthy', () => {
    const journal2: Journal = { ...journal3, entries: journal3.entries.slice(0, 2) };
    const applied = [appliedRow(1, 1000), appliedRow(2, 2000), appliedRow(3, 3000)];
    const rows = computeMigrationStatus(journal2, applied);
    expect(rows.map((r) => r.status)).toEqual(['APPLIED', 'APPLIED', 'UNKNOWN']);
    expect(rows[2]).toMatchObject({ status: 'UNKNOWN', appliedAt: 3000, hash: 'hash_3' });
  });
});

describe('queryAppliedMigrations', () => {
  it('returns [] when the bookkeeping table is absent (to_regclass null)', async () => {
    const sql = vi.fn().mockResolvedValueOnce([{ oid: null }]);
    const rows = await queryAppliedMigrations(sql as never);
    expect(rows).toEqual([]);
    expect(sql).toHaveBeenCalledTimes(1); // second query never runs
  });

  it('coerces id/created_at to numbers when the table exists', async () => {
    const sql = vi
      .fn()
      .mockResolvedValueOnce([{ oid: 'drizzle.__drizzle_migrations' }])
      .mockResolvedValueOnce([
        { id: '1', hash: 'h1', created_at: '1000' },
        { id: 2, hash: 'h2', created_at: 2000 },
      ]);
    const rows = await queryAppliedMigrations(sql as never);
    expect(rows).toEqual([
      { id: 1, hash: 'h1', created_at: 1000 },
      { id: 2, hash: 'h2', created_at: 2000 },
    ]);
  });
});

describe('resolveLastAppliedIdx', () => {
  it('resolves to (count - 1) so 2 applied rows target snapshot idx 1', () => {
    expect(resolveLastAppliedIdx([appliedRow(1, 1000), appliedRow(2, 2000)])).toBe(1);
    expect(resolveLastAppliedIdx([])).toBe(-1);
  });
});

describe('loadJournal (fixture)', () => {
  it('parses the fixture journal with three ordered entries', () => {
    const journal = loadJournal(fixturesFolder);
    expect(journal.entries).toHaveLength(3);
    expect(journal.entries.map((e) => e.tag)).toEqual([
      '0000_baseline',
      '0001_conscious_steel_serpent',
      '0002_reflective_maverick',
    ]);
  });
});
