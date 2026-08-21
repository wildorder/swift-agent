import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assembleLiveSchema,
  collectDefaultNotes,
  diffSchemas,
  planPreflight,
  projectSnapshot,
  DRIFT_SKIP_WARNING,
  type DriftDifference,
} from '../drift-check.js';
import { loadSnapshot } from '../snapshot.js';
import { cleanLiveRows } from './fixtures/raw-introspection.js';

const fixturesFolder = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const snapshot = loadSnapshot(fixturesFolder, 0);
const expected = projectSnapshot(snapshot);

function find(diffs: DriftDifference[], kind: DriftDifference['kind'], object: string): DriftDifference | undefined {
  return diffs.find((d) => d.kind === kind && d.object === object);
}

describe('diffSchemas — clean DB (false-positive firewall, SC-02)', () => {
  it('produces ZERO differences when live exactly matches the snapshot', () => {
    // Feed the projected snapshot back in as the "live" schema.
    expect(diffSchemas(expected, expected)).toEqual([]);
  });

  it('normalizes raw information_schema vocabulary to the snapshot canonical form (SC-02)', () => {
    // Raw live rows (character varying+len, USER-DEFINED+udt, 'running'::run_status,
    // NO ACTION) must canonicalize to zero drift against the snapshot.
    const actual = assembleLiveSchema(cleanLiveRows());
    expect(diffSchemas(expected, actual)).toEqual([]);
    expect(collectDefaultNotes(expected, actual)).toEqual([]);
  });
});

describe('diffSchemas — structural drift (SC-02)', () => {
  it('flags a missing column', () => {
    const raw = cleanLiveRows();
    raw.columns = raw.columns.filter((c) => !(c.table_name === 'runs' && c.column_name === 'token_usage'));
    const diffs = diffSchemas(expected, assembleLiveSchema(raw));
    expect(find(diffs, 'column', 'runs.token_usage')).toMatchObject({ detail: 'missing_in_db' });
  });

  it('flags an unexpected column from a hand-applied ALTER', () => {
    const raw = cleanLiveRows();
    raw.columns.push({
      table_name: 'runs', column_name: 'priority', data_type: 'integer', udt_name: 'int4',
      is_nullable: 'YES', column_default: null, character_maximum_length: null,
    });
    const diffs = diffSchemas(expected, assembleLiveSchema(raw));
    expect(find(diffs, 'column', 'runs.priority')).toMatchObject({ detail: 'unexpected_in_db' });
  });

  it('flags ordered enum value drift', () => {
    const raw = cleanLiveRows();
    raw.enums = raw.enums.filter((e) => e.value !== 'timed_out');
    const diffs = diffSchemas(expected, assembleLiveSchema(raw));
    expect(find(diffs, 'enum', 'run_status')).toMatchObject({ detail: 'mismatch' });
  });

  it('flags a reordered enum even with the same value set', () => {
    const raw = cleanLiveRows();
    raw.enums = [
      { enum_name: 'run_status', value: 'completed' },
      { enum_name: 'run_status', value: 'running' },
      { enum_name: 'run_status', value: 'failed' },
      { enum_name: 'run_status', value: 'cancelled' },
      { enum_name: 'run_status', value: 'timed_out' },
    ];
    const diffs = diffSchemas(expected, assembleLiveSchema(raw));
    expect(find(diffs, 'enum', 'run_status')).toMatchObject({ detail: 'mismatch' });
  });

  it('flags a dropped secondary index without false PK-index diffs', () => {
    const raw = cleanLiveRows();
    raw.indexes = raw.indexes.filter((i) => i.index_name !== 'traces_run_id_idx');
    const diffs = diffSchemas(expected, assembleLiveSchema(raw));
    expect(find(diffs, 'index', 'traces_run_id_idx')).toMatchObject({ detail: 'missing_in_db' });
    // PK-backing indexes are excluded from both sides, so no spurious index diffs.
    expect(diffs.filter((d) => d.kind === 'index')).toHaveLength(1);
  });

  it('flags an FK referential-action mismatch', () => {
    const raw = cleanLiveRows();
    const fk = raw.foreignKeys.find((f) => f.fk_name === 'runs_session_id_sessions_session_id_fk');
    if (fk) fk.on_delete = 'CASCADE';
    const diffs = diffSchemas(expected, assembleLiveSchema(raw));
    expect(find(diffs, 'foreignKey', 'runs_session_id_sessions_session_id_fk')).toMatchObject({
      detail: 'mismatch',
    });
  });

  it('flags a column type/notNull mismatch', () => {
    const raw = cleanLiveRows();
    const model = raw.columns.find((c) => c.table_name === 'runs' && c.column_name === 'model');
    if (model) model.character_maximum_length = 512;
    const diffs = diffSchemas(expected, assembleLiveSchema(raw));
    expect(find(diffs, 'column', 'runs.model')).toMatchObject({ detail: 'mismatch' });
  });
});

describe('lenient defaults (no false positive, SC-02)', () => {
  it('does not flag a benign default representation difference as drift', () => {
    // Live token_usage carries a representationally-different default; snapshot has none.
    const raw = cleanLiveRows();
    const tokenUsage = raw.columns.find((c) => c.table_name === 'runs' && c.column_name === 'token_usage');
    if (tokenUsage) tokenUsage.column_default = "'{}'::jsonb";
    const actual = assembleLiveSchema(raw);

    // No hard column difference (defaults are excluded from diffSchemas)...
    expect(diffSchemas(expected, actual).some((d) => d.kind === 'column')).toBe(false);
    // ...but the difference is surfaced as an informational note.
    const notes = collectDefaultNotes(expected, actual);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('runs.token_usage');
  });
});

describe('planPreflight (SC-03)', () => {
  it('targets the last-applied snapshot idx (2 applied rows -> idx 1)', () => {
    const applied = [
      { id: 1, hash: 'h1', created_at: 1000 },
      { id: 2, hash: 'h2', created_at: 2000 },
    ];
    expect(planPreflight({}, applied)).toEqual({ action: 'check', expectedIdx: 1 });
  });

  it('skips the drift check on a never-migrated DB', () => {
    expect(planPreflight({}, [])).toEqual({ action: 'skip-virgin' });
  });

  it('honors the MIGRATE_SKIP_DRIFT_CHECK escape hatch with a loud warning', () => {
    const plan = planPreflight({ MIGRATE_SKIP_DRIFT_CHECK: '1' }, [
      { id: 1, hash: 'h1', created_at: 1000 },
    ]);
    expect(plan.action).toBe('skip-warned');
    expect(plan.warning).toBe(DRIFT_SKIP_WARNING);
  });
});
