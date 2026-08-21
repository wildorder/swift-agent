import type postgres from 'postgres';
import type { Journal } from './snapshot.js';

/**
 * Migration status reporting: reconcile the Drizzle journal against the
 * migrator's `drizzle.__drizzle_migrations` bookkeeping table.
 *
 * The bookkeeping table stores `hash` + `created_at`, NOT the journal `tag`.
 * The postgres-js migrator applies journal entries strictly in `idx` order and
 * inserts one bookkeeping row per applied entry in that same order. The
 * reliable mapping is therefore ORDINAL: sort journal entries by `idx`, sort
 * bookkeeping rows by `created_at` (tie-break `id`), and zip. We deliberately
 * do NOT recompute SHA-256 hashes to match tags — that would couple status to
 * drizzle internals and is unnecessary for the ordinal invariant.
 */

// A postgres.js client instance (the `sql` tag). Modeled off postgres()'s
// return type to avoid depending on the namespaced `postgres.Sql` export.
type Sql = ReturnType<typeof postgres>;

export interface AppliedRow {
  id: number;
  hash: string;
  created_at: number;
}

export type MigrationStatusState = 'APPLIED' | 'PENDING' | 'UNKNOWN';

export interface MigrationStatus {
  idx: number;
  tag: string;
  status: MigrationStatusState;
  appliedAt?: number;
  hash?: string;
}

/**
 * The ONLY DB-touching function in this module (so unit tests can mock it).
 * Returns bookkeeping rows in apply order. If the `drizzle.__drizzle_migrations`
 * table does not exist, the DB has never been migrated → returns `[]`.
 */
export async function queryAppliedMigrations(sql: Sql): Promise<AppliedRow[]> {
  const reg = await sql<{ oid: string | null }[]>`
    SELECT to_regclass('drizzle.__drizzle_migrations') AS oid
  `;
  if (reg.length === 0 || reg[0]?.oid == null) {
    return [];
  }

  const rows = await sql<{ id: number | string; hash: string; created_at: number | string }[]>`
    SELECT id, hash, created_at
    FROM drizzle.__drizzle_migrations
    ORDER BY created_at ASC, id ASC
  `;

  return rows.map((r) => ({
    id: Number(r.id),
    hash: String(r.hash),
    created_at: Number(r.created_at),
  }));
}

/**
 * Pure ordinal reconciliation. Journal entry `i` is `APPLIED` iff a bookkeeping
 * row exists at ordinal `i`; otherwise `PENDING`. Surplus bookkeeping rows
 * (count exceeds journal length) are reported as trailing `UNKNOWN` rows — this
 * surfaces a checked-out branch older than the DB. Status is a report, not a
 * gate, so this never throws on surplus.
 */
export function computeMigrationStatus(journal: Journal, appliedRows: AppliedRow[]): MigrationStatus[] {
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
  const result: MigrationStatus[] = [];

  entries.forEach((entry, i) => {
    const row = appliedRows[i];
    if (row) {
      result.push({
        idx: entry.idx,
        tag: entry.tag,
        status: 'APPLIED',
        appliedAt: row.created_at,
        hash: row.hash,
      });
    } else {
      result.push({ idx: entry.idx, tag: entry.tag, status: 'PENDING' });
    }
  });

  for (let i = entries.length; i < appliedRows.length; i++) {
    const row = appliedRows[i];
    if (!row) continue;
    result.push({
      idx: i,
      tag: '(unknown — applied, not in journal)',
      status: 'UNKNOWN',
      appliedAt: row.created_at,
      hash: row.hash,
    });
  }

  return result;
}

/**
 * The ordinal of the last-applied migration = (applied row count − 1). Used by
 * the migrate preflight to pick which snapshot the live DB is expected to match.
 * Returns -1 when nothing is applied (caller should skip the drift check).
 */
export function resolveLastAppliedIdx(appliedRows: AppliedRow[]): number {
  return appliedRows.length - 1;
}

function formatAppliedAt(ms: number | undefined): string {
  if (ms == null) return '';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return String(ms);
  return date.toISOString();
}

/** Fixed-width `IDX | TAG | STATUS | APPLIED AT` table. */
export function renderStatusTable(rows: MigrationStatus[]): string {
  const header = ['IDX', 'TAG', 'STATUS', 'APPLIED AT'];
  const body = rows.map((r) => [
    String(r.idx),
    r.tag,
    r.status,
    formatAppliedAt(r.appliedAt),
  ]);

  const widths = header.map((h, col) =>
    Math.max(h.length, ...body.map((line) => line[col]?.length ?? 0)),
  );

  const pad = (cells: string[]): string =>
    cells.map((cell, col) => cell.padEnd(widths[col] ?? 0)).join(' | ').trimEnd();

  const separator = widths.map((w) => '-'.repeat(w)).join('-+-');

  return [pad(header), separator, ...body.map(pad)].join('\n');
}
