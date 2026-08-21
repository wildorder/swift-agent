import type {
  RawColumnRow,
  RawEnumRow,
  RawForeignKeyRow,
  RawIndexRow,
  RawIntrospection,
  RawPrimaryKeyRow,
} from '../../drift-check.js';

/**
 * Canned `information_schema` / `pg_catalog` rows in RAW live vocabulary that,
 * after `assembleLiveSchema`, normalize to exactly `projectSnapshot(0000_snapshot)`.
 * This is the substrate for the false-positive-firewall tests: raw live shapes
 * (`character varying`+len, `USER-DEFINED`+udt, `'running'::run_status`, `NO ACTION`)
 * must canonicalize to the snapshot form and produce zero drift.
 */

const columns: RawColumnRow[] = [
  { table_name: 'runs', column_name: 'run_id', data_type: 'text', udt_name: 'text', is_nullable: 'NO', column_default: null, character_maximum_length: null },
  { table_name: 'runs', column_name: 'session_id', data_type: 'text', udt_name: 'text', is_nullable: 'NO', column_default: null, character_maximum_length: null },
  { table_name: 'runs', column_name: 'status', data_type: 'USER-DEFINED', udt_name: 'run_status', is_nullable: 'NO', column_default: "'running'::run_status", character_maximum_length: null },
  { table_name: 'runs', column_name: 'model', data_type: 'character varying', udt_name: 'varchar', is_nullable: 'NO', column_default: null, character_maximum_length: 255 },
  { table_name: 'runs', column_name: 'token_usage', data_type: 'jsonb', udt_name: 'jsonb', is_nullable: 'YES', column_default: null, character_maximum_length: null },
  { table_name: 'runs', column_name: 'created_at', data_type: 'timestamp with time zone', udt_name: 'timestamptz', is_nullable: 'NO', column_default: 'now()', character_maximum_length: null },
  { table_name: 'traces', column_name: 'trace_id', data_type: 'text', udt_name: 'text', is_nullable: 'NO', column_default: null, character_maximum_length: null },
  { table_name: 'traces', column_name: 'run_id', data_type: 'text', udt_name: 'text', is_nullable: 'NO', column_default: null, character_maximum_length: null },
];

const enums: RawEnumRow[] = [
  { enum_name: 'run_status', value: 'running' },
  { enum_name: 'run_status', value: 'completed' },
  { enum_name: 'run_status', value: 'failed' },
  { enum_name: 'run_status', value: 'cancelled' },
  { enum_name: 'run_status', value: 'timed_out' },
];

const indexes: RawIndexRow[] = [
  { index_name: 'runs_session_id_idx', table_name: 'runs', is_unique: false, column_name: 'session_id', ord: 1 },
  { index_name: 'traces_run_id_idx', table_name: 'traces', is_unique: true, column_name: 'run_id', ord: 1 },
];

const foreignKeys: RawForeignKeyRow[] = [
  { fk_name: 'runs_session_id_sessions_session_id_fk', table_from: 'runs', table_to: 'sessions', col_from: 'session_id', col_to: 'session_id', on_delete: 'NO ACTION', on_update: 'NO ACTION', ord: 1 },
  { fk_name: 'traces_run_id_runs_run_id_fk', table_from: 'traces', table_to: 'runs', col_from: 'run_id', col_to: 'run_id', on_delete: 'NO ACTION', on_update: 'NO ACTION', ord: 1 },
];

const primaryKeys: RawPrimaryKeyRow[] = [
  { table_name: 'runs', column_name: 'run_id', ord: 1 },
  { table_name: 'traces', column_name: 'trace_id', ord: 1 },
];

/** A deep clone of the clean raw introspection so tests can mutate freely. */
export function cleanLiveRows(): RawIntrospection {
  return structuredClone({
    tables: ['runs', 'traces'],
    columns,
    enums,
    indexes,
    foreignKeys,
    primaryKeys,
  });
}
