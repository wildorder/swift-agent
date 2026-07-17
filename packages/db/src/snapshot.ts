import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * Typed loaders for the Drizzle journal (`meta/_journal.json`) and the
 * committed snapshots (`meta/NNNN_snapshot.json`). This module isolates ALL
 * filesystem + drizzle-kit JSON-shape coupling behind one place so the
 * migration-status and drift-check logic consume typed, validated data.
 *
 * Schemas parse only the subset of the drizzle-kit v7 shape this tooling
 * reads and use `.passthrough()` so unknown drizzle-kit fields never break
 * loading across `drizzle-kit` minor bumps.
 */

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

const JournalEntrySchema = z
  .object({
    idx: z.number(),
    version: z.string().optional(),
    when: z.number().optional(),
    tag: z.string(),
    breakpoints: z.boolean().optional(),
  })
  .passthrough();

const JournalSchema = z
  .object({
    version: z.string(),
    dialect: z.string(),
    entries: z.array(JournalEntrySchema),
  })
  .passthrough();

export type JournalEntry = z.infer<typeof JournalEntrySchema>;
export type Journal = z.infer<typeof JournalSchema>;

// ---------------------------------------------------------------------------
// Snapshot (subset)
// ---------------------------------------------------------------------------

const SnapshotColumnSchema = z
  .object({
    name: z.string(),
    type: z.string(),
    typeSchema: z.string().optional(),
    primaryKey: z.boolean().optional().default(false),
    notNull: z.boolean().optional().default(false),
    default: z.string().optional(),
  })
  .passthrough();

const SnapshotIndexColumnSchema = z
  .object({
    expression: z.string(),
    isExpression: z.boolean().optional().default(false),
    asc: z.boolean().optional(),
    nulls: z.string().optional(),
  })
  .passthrough();

const SnapshotIndexSchema = z
  .object({
    name: z.string(),
    columns: z.array(SnapshotIndexColumnSchema),
    isUnique: z.boolean().optional().default(false),
    method: z.string().optional(),
  })
  .passthrough();

const SnapshotForeignKeySchema = z
  .object({
    name: z.string(),
    tableFrom: z.string(),
    tableTo: z.string(),
    columnsFrom: z.array(z.string()),
    columnsTo: z.array(z.string()),
    onDelete: z.string().optional(),
    onUpdate: z.string().optional(),
  })
  .passthrough();

const SnapshotCompositePkSchema = z
  .object({
    name: z.string(),
    columns: z.array(z.string()),
  })
  .passthrough();

const SnapshotUniqueConstraintSchema = z
  .object({
    name: z.string(),
    columns: z.array(z.string()),
    nullsNotDistinct: z.boolean().optional(),
  })
  .passthrough();

const SnapshotTableSchema = z
  .object({
    name: z.string(),
    schema: z.string().optional(),
    columns: z.record(SnapshotColumnSchema),
    indexes: z.record(SnapshotIndexSchema).optional().default({}),
    foreignKeys: z.record(SnapshotForeignKeySchema).optional().default({}),
    compositePrimaryKeys: z.record(SnapshotCompositePkSchema).optional().default({}),
    uniqueConstraints: z.record(SnapshotUniqueConstraintSchema).optional().default({}),
  })
  .passthrough();

const SnapshotEnumSchema = z
  .object({
    name: z.string(),
    schema: z.string().optional(),
    values: z.array(z.string()),
  })
  .passthrough();

const SnapshotSchema = z
  .object({
    version: z.string().optional(),
    dialect: z.string().optional(),
    tables: z.record(SnapshotTableSchema),
    enums: z.record(SnapshotEnumSchema).optional().default({}),
  })
  .passthrough();

export type SnapshotColumn = z.infer<typeof SnapshotColumnSchema>;
export type SnapshotIndex = z.infer<typeof SnapshotIndexSchema>;
export type SnapshotForeignKey = z.infer<typeof SnapshotForeignKeySchema>;
export type SnapshotTable = z.infer<typeof SnapshotTableSchema>;
export type SnapshotEnum = z.infer<typeof SnapshotEnumSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

/** Parse and validate `<migrationsFolder>/meta/_journal.json`. */
export function loadJournal(migrationsFolder: string): Journal {
  const path = resolve(migrationsFolder, 'meta', '_journal.json');
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return JournalSchema.parse(raw);
}

/**
 * Parse and validate the snapshot for a journal ordinal. Snapshot files are
 * named `NNNN_snapshot.json` where `NNNN` is the entry `idx` zero-padded to 4.
 */
export function loadSnapshot(migrationsFolder: string, idx: number): Snapshot {
  const fileName = `${String(idx).padStart(4, '0')}_snapshot.json`;
  const path = resolve(migrationsFolder, 'meta', fileName);
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return SnapshotSchema.parse(raw);
}
