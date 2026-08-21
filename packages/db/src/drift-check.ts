import type postgres from 'postgres';
import type { AppliedRow } from './migration-status.js';
import { loadSnapshot, type Snapshot } from './snapshot.js';

/**
 * Structural drift detection: introspect the live `public` schema via
 * `information_schema` + `pg_catalog`, project the committed snapshot into the
 * SAME canonical structural model, and diff. Both sides pass through identical
 * normalizers — that symmetry is the false-positive firewall (SC-02).
 *
 * Deliberately self-contained catalog queries — NOT drizzle-kit's programmatic
 * internals — so it is robust to `drizzle-kit` ^0.30 minor bumps and unit
 * testable against mocked row sets.
 *
 * Compared: table presence, column presence + type + notNull, enum presence +
 * ordered values, secondary index presence + uniqueness + column set, FK
 * endpoints + referential actions, primary-key columns. Column DEFAULTS are
 * compared leniently — representational differences produce informational notes
 * only, never a hard drift (defaults are the top false-positive risk).
 *
 * NOT compared (disclaimed in the summary): row data, statistics, comments,
 * ownership/privileges, RLS policies, triggers, functions, sequences, collations,
 * and physical storage.
 */

type Sql = ReturnType<typeof postgres>;

// ---------------------------------------------------------------------------
// Canonical structural model (both live and expected normalize into this)
// ---------------------------------------------------------------------------

export interface CanonicalColumn {
  name: string;
  type: string;
  notNull: boolean;
  default: string | null;
}

export interface CanonicalIndex {
  name: string;
  columns: string[];
  isUnique: boolean;
}

export interface CanonicalForeignKey {
  name: string;
  columnsFrom: string[];
  tableTo: string;
  columnsTo: string[];
  onDelete: string;
  onUpdate: string;
}

export interface CanonicalTable {
  name: string;
  columns: Record<string, CanonicalColumn>;
  indexes: Record<string, CanonicalIndex>;
  foreignKeys: Record<string, CanonicalForeignKey>;
  primaryKeyColumns: string[];
}

export interface CanonicalSchema {
  tables: Record<string, CanonicalTable>;
  enums: Record<string, string[]>;
}

export type LiveSchema = CanonicalSchema;
export type ExpectedSchema = CanonicalSchema;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface DriftDifference {
  kind: 'table' | 'column' | 'enum' | 'index' | 'foreignKey' | 'primaryKey';
  object: string;
  detail: 'missing_in_db' | 'unexpected_in_db' | 'mismatch';
  expected?: string;
  actual?: string;
}

export interface DriftResult {
  hasDrift: boolean;
  expectedSnapshotTag: string;
  differences: DriftDifference[];
  /** Informational, non-gating observations (e.g. benign default representation differences). */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Shared normalizers (applied symmetrically to both sides)
// ---------------------------------------------------------------------------

/**
 * Strip trailing `::type` casts and surrounding single quotes, then lowercase,
 * so `'running'::run_status`, `'running'` → `running`, and `'{}'::jsonb`, `{}`
 * → `{}`. Missing default on both sides stays `null`.
 */
export function normalizeDefault(value: string | null | undefined): string | null {
  if (value == null) return null;
  let s = String(value).trim();
  // Strip a trailing type cast: ::text, ::run_status, ::"public".run_status, ...
  s = s.replace(/::\s*[\w".]+(\s*\[\s*\])?\s*$/, '').trim();
  // Strip a single layer of surrounding single quotes.
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    s = s.slice(1, -1);
  }
  return s.trim().toLowerCase();
}

/** Referential actions are compared uppercase (`no action` ↔ `NO ACTION`). */
function normalizeAction(action: string | undefined): string {
  return (action ?? 'no action').trim().toUpperCase();
}

// ---------------------------------------------------------------------------
// Snapshot → canonical projection
// ---------------------------------------------------------------------------

/** Project a committed snapshot into the canonical structural model. */
export function projectSnapshot(snapshot: Snapshot): ExpectedSchema {
  const tables: Record<string, CanonicalTable> = {};

  for (const table of Object.values(snapshot.tables)) {
    const columns: Record<string, CanonicalColumn> = {};
    const primaryKeyColumns: string[] = [];

    for (const col of Object.values(table.columns)) {
      columns[col.name] = {
        name: col.name,
        // Snapshot type strings are already the canonical form we target:
        // enum columns carry the enum (udt) name, varchar carries its length.
        type: col.type,
        notNull: col.notNull,
        default: normalizeDefault(col.default),
      };
      if (col.primaryKey) primaryKeyColumns.push(col.name);
    }

    for (const pk of Object.values(table.compositePrimaryKeys)) {
      for (const c of pk.columns) {
        if (!primaryKeyColumns.includes(c)) primaryKeyColumns.push(c);
      }
    }

    // Snapshot `indexes` already excludes PK-/unique-constraint-backing indexes
    // (those live under compositePrimaryKeys / uniqueConstraints).
    const indexes: Record<string, CanonicalIndex> = {};
    for (const idx of Object.values(table.indexes)) {
      indexes[idx.name] = {
        name: idx.name,
        columns: idx.columns.filter((c) => !c.isExpression).map((c) => c.expression),
        isUnique: idx.isUnique,
      };
    }

    const foreignKeys: Record<string, CanonicalForeignKey> = {};
    for (const fk of Object.values(table.foreignKeys)) {
      foreignKeys[fk.name] = {
        name: fk.name,
        columnsFrom: [...fk.columnsFrom],
        tableTo: fk.tableTo,
        columnsTo: [...fk.columnsTo],
        onDelete: normalizeAction(fk.onDelete),
        onUpdate: normalizeAction(fk.onUpdate),
      };
    }

    tables[table.name] = {
      name: table.name,
      columns,
      indexes,
      foreignKeys,
      primaryKeyColumns: [...primaryKeyColumns].sort(),
    };
  }

  const enums: Record<string, string[]> = {};
  for (const e of Object.values(snapshot.enums)) {
    enums[e.name] = [...e.values];
  }

  return { tables, enums };
}

// ---------------------------------------------------------------------------
// Live introspection: raw rows → canonical projection
// ---------------------------------------------------------------------------

export interface RawColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: string; // 'YES' | 'NO'
  column_default: string | null;
  character_maximum_length: number | null;
}

export interface RawEnumRow {
  enum_name: string;
  value: string;
}

export interface RawIndexRow {
  index_name: string;
  table_name: string;
  is_unique: boolean;
  column_name: string;
  ord: number;
}

export interface RawForeignKeyRow {
  fk_name: string;
  table_from: string;
  table_to: string;
  col_from: string;
  col_to: string;
  on_delete: string;
  on_update: string;
  ord: number;
}

export interface RawPrimaryKeyRow {
  table_name: string;
  column_name: string;
  ord: number;
}

export interface RawIntrospection {
  tables: string[];
  columns: RawColumnRow[];
  enums: RawEnumRow[];
  indexes: RawIndexRow[];
  foreignKeys: RawForeignKeyRow[];
  primaryKeys: RawPrimaryKeyRow[];
}

/** Canonicalize a live `information_schema` column type into the snapshot's vocabulary. */
function canonicalizeLiveType(row: RawColumnRow): string {
  const dataType = row.data_type;
  if (dataType === 'USER-DEFINED') {
    // Enum-typed columns: information_schema reports USER-DEFINED; the concrete
    // type name lives in udt_name (matches the snapshot's enum name).
    return row.udt_name;
  }
  if (dataType === 'character varying') {
    return row.character_maximum_length != null
      ? `varchar(${row.character_maximum_length})`
      : 'varchar';
  }
  if (dataType === 'character') {
    return row.character_maximum_length != null
      ? `char(${row.character_maximum_length})`
      : 'char';
  }
  // text, jsonb, integer, 'timestamp with time zone', boolean, ... map directly.
  return dataType;
}

/**
 * Pure assembler: normalize raw introspection rows into the canonical model.
 * Split out from {@link introspectLiveSchema} so normalization is unit-testable
 * against canned rows with no DB.
 */
export function assembleLiveSchema(raw: RawIntrospection): LiveSchema {
  const tables: Record<string, CanonicalTable> = {};

  const ensureTable = (name: string): CanonicalTable => {
    let t = tables[name];
    if (!t) {
      t = { name, columns: {}, indexes: {}, foreignKeys: {}, primaryKeyColumns: [] };
      tables[name] = t;
    }
    return t;
  };

  for (const name of raw.tables) ensureTable(name);

  for (const col of raw.columns) {
    ensureTable(col.table_name).columns[col.column_name] = {
      name: col.column_name,
      type: canonicalizeLiveType(col),
      notNull: col.is_nullable === 'NO',
      default: normalizeDefault(col.column_default),
    };
  }

  // Index columns arrive one row per (index, column); group and order by `ord`.
  const indexRows = [...raw.indexes].sort((a, b) => a.ord - b.ord);
  for (const row of indexRows) {
    const table = ensureTable(row.table_name);
    let idx = table.indexes[row.index_name];
    if (!idx) {
      idx = { name: row.index_name, columns: [], isUnique: row.is_unique };
      table.indexes[row.index_name] = idx;
    }
    idx.columns.push(row.column_name);
  }

  const fkRows = [...raw.foreignKeys].sort((a, b) => a.ord - b.ord);
  for (const row of fkRows) {
    const table = ensureTable(row.table_from);
    let fk = table.foreignKeys[row.fk_name];
    if (!fk) {
      fk = {
        name: row.fk_name,
        columnsFrom: [],
        tableTo: row.table_to,
        columnsTo: [],
        onDelete: normalizeAction(row.on_delete),
        onUpdate: normalizeAction(row.on_update),
      };
      table.foreignKeys[row.fk_name] = fk;
    }
    fk.columnsFrom.push(row.col_from);
    fk.columnsTo.push(row.col_to);
  }

  const pkRows = [...raw.primaryKeys].sort((a, b) => a.ord - b.ord);
  for (const row of pkRows) {
    ensureTable(row.table_name).primaryKeyColumns.push(row.column_name);
  }
  for (const table of Object.values(tables)) {
    table.primaryKeyColumns = [...table.primaryKeyColumns].sort();
  }

  const enums: Record<string, string[]> = {};
  for (const row of raw.enums) {
    (enums[row.enum_name] ??= []).push(row.value);
  }

  return { tables, enums };
}

/**
 * Run the bounded per-category introspection queries against the live DB and
 * assemble the canonical model. `tableNames` bounds the column/index/FK/PK
 * queries to the snapshot's table set (`__drizzle_migrations` lives in the
 * `drizzle` schema and is excluded by the `public` filter anyway).
 */
export async function introspectLiveSchema(sql: Sql, tableNames: string[]): Promise<LiveSchema> {
  const names = tableNames.length > 0 ? tableNames : [''];

  const tableRows = await sql<{ table_name: string }[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `;

  const columns = await sql<RawColumnRow[]>`
    SELECT table_name, column_name, data_type, udt_name, is_nullable,
           column_default, character_maximum_length
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN ${sql(names)}
    ORDER BY table_name, ordinal_position
  `;

  const enums = await sql<RawEnumRow[]>`
    SELECT t.typname AS enum_name, e.enumlabel AS value
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
    ORDER BY t.typname, e.enumsortorder
  `;

  const indexes = await sql<RawIndexRow[]>`
    SELECT i.relname AS index_name, t.relname AS table_name,
           ix.indisunique AS is_unique, a.attname AS column_name, k.ord::int AS ord
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
    WHERE n.nspname = 'public'
      AND t.relname IN ${sql(names)}
      AND ix.indisprimary = false
      AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = ix.indexrelid)
    ORDER BY t.relname, i.relname, k.ord
  `;

  const foreignKeys = await sql<RawForeignKeyRow[]>`
    SELECT tc.constraint_name AS fk_name,
           tc.table_name AS table_from,
           ccu.table_name AS table_to,
           kcu.column_name AS col_from,
           ccu.column_name AS col_to,
           rc.delete_rule AS on_delete,
           rc.update_rule AS on_update,
           kcu.ordinal_position::int AS ord
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name
     AND kcu.constraint_schema = tc.constraint_schema
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_name = tc.constraint_name
     AND rc.constraint_schema = tc.constraint_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
     AND ccu.constraint_schema = tc.constraint_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND tc.table_name IN ${sql(names)}
    ORDER BY tc.constraint_name, kcu.ordinal_position
  `;

  const primaryKeys = await sql<RawPrimaryKeyRow[]>`
    SELECT t.relname AS table_name, a.attname AS column_name, k.ord::int AS ord
    FROM pg_constraint con
    JOIN pg_class t ON t.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
    WHERE con.contype = 'p'
      AND n.nspname = 'public'
      AND t.relname IN ${sql(names)}
    ORDER BY t.relname, k.ord
  `;

  return assembleLiveSchema({
    tables: tableRows.map((r) => r.table_name),
    columns: [...columns],
    enums: [...enums],
    indexes: [...indexes],
    foreignKeys: [...foreignKeys],
    primaryKeys: [...primaryKeys],
  });
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

function describeColumn(col: CanonicalColumn): string {
  return `${col.type}${col.notNull ? ' NOT NULL' : ''}`;
}

function describeIndex(idx: CanonicalIndex): string {
  return `${idx.isUnique ? 'UNIQUE ' : ''}(${idx.columns.join(', ')})`;
}

function describeForeignKey(fk: CanonicalForeignKey): string {
  return `(${fk.columnsFrom.join(', ')}) -> ${fk.tableTo}(${fk.columnsTo.join(', ')}) ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate}`;
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Structural set-diff of two canonical schemas. Returns HARD differences only.
 * Column DEFAULT differences are intentionally excluded (surfaced as notes by
 * {@link checkDrift}) — never a hard `mismatch`, per the lenient-default rule.
 */
export function diffSchemas(expected: ExpectedSchema, actual: LiveSchema): DriftDifference[] {
  const differences: DriftDifference[] = [];

  // Enums (ordered value lists).
  for (const [name, expectedValues] of Object.entries(expected.enums)) {
    const actualValues = actual.enums[name];
    if (!actualValues) {
      differences.push({ kind: 'enum', object: name, detail: 'missing_in_db', expected: expectedValues.join(', ') });
    } else if (!arraysEqual(expectedValues, actualValues)) {
      differences.push({
        kind: 'enum',
        object: name,
        detail: 'mismatch',
        expected: expectedValues.join(', '),
        actual: actualValues.join(', '),
      });
    }
  }
  for (const name of Object.keys(actual.enums)) {
    if (!expected.enums[name]) {
      differences.push({ kind: 'enum', object: name, detail: 'unexpected_in_db', actual: actual.enums[name]?.join(', ') });
    }
  }

  // Tables.
  for (const [tableName, expectedTable] of Object.entries(expected.tables)) {
    const actualTable = actual.tables[tableName];
    if (!actualTable) {
      differences.push({ kind: 'table', object: tableName, detail: 'missing_in_db' });
      continue;
    }
    diffTable(expectedTable, actualTable, differences);
  }
  for (const tableName of Object.keys(actual.tables)) {
    if (!expected.tables[tableName]) {
      differences.push({ kind: 'table', object: tableName, detail: 'unexpected_in_db' });
    }
  }

  return differences;
}

function diffTable(
  expectedTable: CanonicalTable,
  actualTable: CanonicalTable,
  differences: DriftDifference[],
): void {
  // Columns (type + notNull; defaults handled leniently elsewhere).
  for (const [colName, expectedCol] of Object.entries(expectedTable.columns)) {
    const actualCol = actualTable.columns[colName];
    const object = `${expectedTable.name}.${colName}`;
    if (!actualCol) {
      differences.push({ kind: 'column', object, detail: 'missing_in_db', expected: describeColumn(expectedCol) });
      continue;
    }
    if (expectedCol.type !== actualCol.type || expectedCol.notNull !== actualCol.notNull) {
      differences.push({
        kind: 'column',
        object,
        detail: 'mismatch',
        expected: describeColumn(expectedCol),
        actual: describeColumn(actualCol),
      });
    }
  }
  for (const colName of Object.keys(actualTable.columns)) {
    if (!expectedTable.columns[colName]) {
      const actualCol = actualTable.columns[colName];
      differences.push({
        kind: 'column',
        object: `${expectedTable.name}.${colName}`,
        detail: 'unexpected_in_db',
        actual: actualCol ? describeColumn(actualCol) : undefined,
      });
    }
  }

  // Secondary indexes.
  for (const [idxName, expectedIdx] of Object.entries(expectedTable.indexes)) {
    const actualIdx = actualTable.indexes[idxName];
    if (!actualIdx) {
      differences.push({ kind: 'index', object: idxName, detail: 'missing_in_db', expected: describeIndex(expectedIdx) });
      continue;
    }
    if (expectedIdx.isUnique !== actualIdx.isUnique || !arraysEqual(expectedIdx.columns, actualIdx.columns)) {
      differences.push({
        kind: 'index',
        object: idxName,
        detail: 'mismatch',
        expected: describeIndex(expectedIdx),
        actual: describeIndex(actualIdx),
      });
    }
  }
  for (const idxName of Object.keys(actualTable.indexes)) {
    if (!expectedTable.indexes[idxName]) {
      const actualIdx = actualTable.indexes[idxName];
      differences.push({
        kind: 'index',
        object: idxName,
        detail: 'unexpected_in_db',
        actual: actualIdx ? describeIndex(actualIdx) : undefined,
      });
    }
  }

  // Foreign keys.
  for (const [fkName, expectedFk] of Object.entries(expectedTable.foreignKeys)) {
    const actualFk = actualTable.foreignKeys[fkName];
    if (!actualFk) {
      differences.push({ kind: 'foreignKey', object: fkName, detail: 'missing_in_db', expected: describeForeignKey(expectedFk) });
      continue;
    }
    const mismatch =
      !arraysEqual(expectedFk.columnsFrom, actualFk.columnsFrom) ||
      !arraysEqual(expectedFk.columnsTo, actualFk.columnsTo) ||
      expectedFk.tableTo !== actualFk.tableTo ||
      expectedFk.onDelete !== actualFk.onDelete ||
      expectedFk.onUpdate !== actualFk.onUpdate;
    if (mismatch) {
      differences.push({
        kind: 'foreignKey',
        object: fkName,
        detail: 'mismatch',
        expected: describeForeignKey(expectedFk),
        actual: describeForeignKey(actualFk),
      });
    }
  }
  for (const fkName of Object.keys(actualTable.foreignKeys)) {
    if (!expectedTable.foreignKeys[fkName]) {
      const actualFk = actualTable.foreignKeys[fkName];
      differences.push({
        kind: 'foreignKey',
        object: fkName,
        detail: 'unexpected_in_db',
        actual: actualFk ? describeForeignKey(actualFk) : undefined,
      });
    }
  }

  // Primary key columns.
  if (!arraysEqual(expectedTable.primaryKeyColumns, actualTable.primaryKeyColumns)) {
    differences.push({
      kind: 'primaryKey',
      object: expectedTable.name,
      detail: 'mismatch',
      expected: `(${expectedTable.primaryKeyColumns.join(', ')})`,
      actual: `(${actualTable.primaryKeyColumns.join(', ')})`,
    });
  }
}

/**
 * Lenient default comparison: representational differences in column defaults
 * are surfaced as informational notes, NEVER as hard drift.
 */
export function collectDefaultNotes(expected: ExpectedSchema, actual: LiveSchema): string[] {
  const notes: string[] = [];
  for (const [tableName, expectedTable] of Object.entries(expected.tables)) {
    const actualTable = actual.tables[tableName];
    if (!actualTable) continue;
    for (const [colName, expectedCol] of Object.entries(expectedTable.columns)) {
      const actualCol = actualTable.columns[colName];
      if (!actualCol) continue;
      if (expectedCol.default !== actualCol.default) {
        notes.push(
          `default differs on ${tableName}.${colName}: expected ${formatDefault(expectedCol.default)}, live ${formatDefault(actualCol.default)} (informational — not treated as drift)`,
        );
      }
    }
  }
  return notes;
}

function formatDefault(value: string | null): string {
  return value == null ? '(none)' : `\`${value}\``;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Load the expected snapshot at `expectedIdx`, project it, introspect the live
 * DB, and diff. `hasDrift` is driven purely by hard `differences`; benign
 * default differences land in `notes`.
 */
export async function checkDrift(sql: Sql, migrationsFolder: string, expectedIdx: number): Promise<DriftResult> {
  const snapshot = loadSnapshot(migrationsFolder, expectedIdx);
  const expected = projectSnapshot(snapshot);
  const tableNames = Object.values(snapshot.tables).map((t) => t.name);
  const actual = await introspectLiveSchema(sql, tableNames);

  const differences = diffSchemas(expected, actual);
  const notes = collectDefaultNotes(expected, actual);

  return {
    hasDrift: differences.length > 0,
    expectedSnapshotTag: `${String(expectedIdx).padStart(4, '0')}_snapshot`,
    differences,
    notes,
  };
}

const NOT_COMPARED_DISCLAIMER = [
  'Drift detection is STRUCTURAL only. Not compared: row data, table statistics,',
  'comments, ownership/privileges, RLS policies, triggers, functions, sequences,',
  'collations, and physical storage. Column defaults are compared leniently',
  '(representational differences are reported as informational notes, not drift).',
].join('\n');

/** Human-readable summary: differences grouped by kind + the not-compared disclaimer. */
export function renderDriftSummary(result: DriftResult): string {
  const lines: string[] = [];
  lines.push(`Drift check against expected snapshot: ${result.expectedSnapshotTag}`);

  if (!result.hasDrift) {
    lines.push('Result: NO DRIFT — live schema matches the expected snapshot.');
  } else {
    lines.push(`Result: DRIFT DETECTED — ${result.differences.length} difference(s).`);
    const byKind = new Map<DriftDifference['kind'], DriftDifference[]>();
    for (const diff of result.differences) {
      const bucket = byKind.get(diff.kind) ?? [];
      bucket.push(diff);
      byKind.set(diff.kind, bucket);
    }
    for (const [kind, diffs] of byKind) {
      lines.push('');
      lines.push(`${kind}:`);
      for (const diff of diffs) {
        let line = `  - ${diff.object}: ${diff.detail}`;
        if (diff.expected != null) line += ` | expected: ${diff.expected}`;
        if (diff.actual != null) line += ` | live: ${diff.actual}`;
        lines.push(line);
      }
    }
  }

  if (result.notes.length > 0) {
    lines.push('');
    lines.push('Notes (informational):');
    for (const note of result.notes) lines.push(`  - ${note}`);
  }

  lines.push('');
  lines.push(NOT_COMPARED_DISCLAIMER);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Migrate preflight planning (pure — testable without running the migrator)
// ---------------------------------------------------------------------------

export const DRIFT_SKIP_WARNING =
  'WARNING: drift check skipped via MIGRATE_SKIP_DRIFT_CHECK=1 — applying migrations against a possibly-drifted database';

export interface PreflightPlan {
  /** `skip-warned`: escape hatch set; `skip-virgin`: never migrated; `check`: run drift check. */
  action: 'skip-warned' | 'skip-virgin' | 'check';
  warning?: string;
  /** Snapshot ordinal to check against (last-applied migration) when `action === 'check'`. */
  expectedIdx?: number;
}

/**
 * Decide the migrate preflight action from the environment + applied rows.
 * Pure so the escape-hatch and last-applied-idx resolution are unit-testable
 * without invoking the migrator.
 */
export function planPreflight(
  env: Record<string, string | undefined>,
  appliedRows: AppliedRow[],
): PreflightPlan {
  if (env['MIGRATE_SKIP_DRIFT_CHECK'] === '1') {
    return { action: 'skip-warned', warning: DRIFT_SKIP_WARNING };
  }
  if (appliedRows.length === 0) {
    return { action: 'skip-virgin' };
  }
  return { action: 'check', expectedIdx: appliedRows.length - 1 };
}
