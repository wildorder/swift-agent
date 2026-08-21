# WS-26: Migration Status & Drift-Detection Command

## Goal

Make schema drift **detectable** and make `migrate` **refuse to run against a drifted database**, layered on top of the existing greenfield baseline (`0000_baseline`) and the postgres-js forward migrator. Deliver three process-exit-code-driven capabilities in `packages/db`:

1. **`migrate status`** — report applied vs. pending migrations by comparing the Drizzle journal (`drizzle/meta/_journal.json`, ordered `tag`/`idx` entries) against the `drizzle.__drizzle_migrations` bookkeeping table the migrator writes. Print a table (each tag → `APPLIED`/`PENDING`), exit 0.
2. **`migrate check` (drift)** — detect a database whose **live** structural schema diverges from what the latest committed snapshot (`drizzle/meta/NNNN_snapshot.json`) implies (a hand-applied `ALTER`, a dropped column/index, a stray enum value). Exit non-zero with a human-readable diff summary on drift; exit 0 on a clean match.
3. **Preflight drift guard in `migrate`** — before applying any pending migration, run the drift check against the **last-applied** migration's expected schema; if the DB has drifted, **abort and apply nothing** (SC-03). An explicit, loudly-logged escape hatch (`MIGRATE_SKIP_DRIFT_CHECK=1`) lets the runbook bypass it.

**Scope:** `packages/db` only. This does **not** regenerate the baseline (it already exists: `0000_baseline` + `0001_conscious_steel_serpent` + `0002_reflective_maverick`, journal populated) and does **not** author new migrations. It adds tooling that consumes the existing migration history. Drift detection is **structural, not data-level**.

## Traceability

- **SC-01** — `migrate status` reports the applied/pending state of every migration in the journal against the migrator's bookkeeping table and exits 0.
- **SC-02** — The drift check exits **0** on a cleanly-migrated database (no false positives — top risk) and **non-zero** with a diff summary when the live schema structurally diverges from the expected snapshot.
- **SC-03** — `migrate` runs the drift check as a preflight and **refuses to apply any migration** (aborts, applies nothing) when the DB has drifted from the last-applied migration's expected schema, unless `MIGRATE_SKIP_DRIFT_CHECK=1` is set.
- Enables (owned elsewhere) **SC-04** (WS-27 wires `db:status`/`db:check` into CI as gating steps) and **SC-10** (WS-29 covers real-DB drift behavior with Testcontainers integration tests). This workstream provides the exit-code contract those consume; it does not own those SCs.

## Dependencies

- **db-migration-baseline:WS-01** — the greenfield `0000_baseline`, the `migrate` script (`node dist/migrate.js`), and `db:generate` (`tsc && drizzle-kit generate`) already exist; `migrate` is the single schema path.
- **core-runtime-completion:WS-19** and **core-runtime-completion:WS-24** — the incremental migrations `0001_conscious_steel_serpent` and `0002_reflective_maverick` (and their `meta/NNNN_snapshot.json`) already exist and are the latest history this tooling reads.

All dependencies are intra-`packages/db`; no cross-package edits.

## Context Files (Agent MUST read before implementing)

- `c:\dev\swift-agent\CLAUDE.md` — conventions (drizzle-orm ^0.36, drizzle-kit ^0.30, postgres.js NOT pg, ESM, Zod source of truth, Vitest, factory-function repos).
- `c:\dev\swift-agent\packages\db\src\migrate.ts` — the forward migrator entry (`drizzle-orm/postgres-js/migrator`; resolves `../drizzle`; compiled to `dist/migrate.js`). **MODIFY** target for the preflight guard.
- `c:\dev\swift-agent\packages\db\package.json` — current scripts (`db:generate` = `tsc && drizzle-kit generate`, `migrate` = `node dist/migrate.js`, `build` = `tsc`). **MODIFY** target for `db:status`/`db:check`.
- `c:\dev\swift-agent\packages\db\drizzle.config.ts` — `schema: ./dist/schema/*.js`, `out: ./drizzle`, dialect `postgresql`, `dbCredentials.url` from `DATABASE_URL`.
- `c:\dev\swift-agent\packages\db\drizzle\meta\_journal.json` — the journal (version `7`, 3 entries: `0000_baseline`, `0001_conscious_steel_serpent`, `0002_reflective_maverick`).
- `c:\dev\swift-agent\packages\db\drizzle\meta\0002_snapshot.json` — the **latest** committed snapshot; the expected-schema source for the drift diff. (`0000_snapshot.json`/`0001_snapshot.json` are prior states.)
- `c:\dev\swift-agent\packages\db\src\client.ts` — `createDbClient` / `Db` type (postgres-js + drizzle).
- `c:\dev\swift-agent\packages\db\src\index.ts` — the db barrel (what's exported; add new public surface here if any).
- `c:\dev\swift-agent\packages\db\src\schema\runs.ts`, `traces.ts`, and the rest of `packages\db\src\schema\*.ts` — the schema modules the snapshot is derived from; the drift check compares the live DB against the snapshot, **not** against these `.ts` files directly (the snapshot is the compiled, canonical representation).

## Package

`packages/db`

## Files Touched

- `packages/db/src/migration-status.ts` **(NEW)** — journal parsing + `__drizzle_migrations` reconciliation; pure logic + a thin query fn. Exports `computeMigrationStatus(...)` and a `renderStatusTable(...)` formatter.
- `packages/db/src/drift-check.ts` **(NEW)** — load the latest snapshot, introspect the live DB into a normalized structural model, diff, and return a typed `DriftResult`. Exports `checkDrift(...)` and `renderDriftSummary(...)`.
- `packages/db/src/snapshot.ts` **(NEW)** — typed loader + Zod parse of `drizzle/meta/_journal.json` and `drizzle/meta/NNNN_snapshot.json` (the subset of the drizzle-kit snapshot v7 shape this tooling reads). Isolates all filesystem + JSON-shape coupling behind one module so status/drift consume typed data.
- `packages/db/src/cli/status.ts` **(NEW)** — CLI entry: open DB, call `computeMigrationStatus`, print table, `process.exit(0)`; compiled to `dist/cli/status.js`.
- `packages/db/src/cli/check.ts` **(NEW)** — CLI entry: open DB, call `checkDrift`, print summary, `process.exit(hasDrift ? 1 : 0)`; compiled to `dist/cli/check.js`.
- `packages/db/src/migrate.ts` **(MODIFY)** — add the preflight drift guard before `migrate(...)`; honor `MIGRATE_SKIP_DRIFT_CHECK`.
- `packages/db/package.json` **(MODIFY)** — add `db:status` and `db:check` scripts (both `node dist/cli/*.js`); document the schema-change workflow in a comment field.
- `packages/db/src/index.ts` **(MODIFY, if exposing)** — export `computeMigrationStatus`, `checkDrift`, and their result types for programmatic use by WS-29 integration tests.
- `packages/db/src/__tests__/migration-status.test.ts` **(NEW)** — unit tests for status/journal parsing with fixture journals + a mocked query layer (no DB).
- `packages/db/src/__tests__/drift-check.test.ts` **(NEW)** — unit tests for the snapshot-vs-introspection diff/normalization with fixture snapshots + a mocked introspection result (no DB).
- `packages/db/src/__tests__/fixtures/` **(NEW)** — small fixture `_journal.json`, snapshot slices, and canned `information_schema` rows for the unit tests.

> Real-DB drift behavior (introspection against a live Testcontainers Postgres, preflight abort, escape hatch) is covered by **WS-29** integration tests at repo root under `test/integration/`, NOT here. This workstream unit-tests the pure logic against fixtures.

## Existing Interfaces to Consume

**Forward migrator today** (`packages/db/src/migrate.ts`) — the preflight guard wraps this call:

```typescript
const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(__dirname, '../drizzle');

const connectionString = process.env['DATABASE_URL'];
if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is required');
}

const pool = postgres(connectionString, { max: 1 });
const db = drizzle(pool);

async function runMigrations() {
  console.log('Running migrations...');
  console.log(`Migrations folder: ${migrationsFolder}`);
  await migrate(db, { migrationsFolder });      // preflight drift guard goes BEFORE this line
  console.log('Migrations complete.');
  await pool.end();
}
```

**DB client today** (`packages/db/src/client.ts`) — reuse for CLI entries so they share pooling/`schema` wiring:

```typescript
export type Db = ReturnType<typeof createDbClient>['db'];

export interface DbClient {
  db: ReturnType<typeof drizzle<typeof schema>>;
  pool: ReturnType<typeof postgres>;
  close: () => Promise<void>;
}

export function createDbClient(connectionString: string): DbClient {
  const pool = postgres(connectionString);
  const db = drizzle(pool, { schema });
  return { db, pool, close: async () => { await pool.end(); } };
}
```

> Note: `createDbClient` uses the default (unbounded) pool; the CLI entries and preflight should prefer `postgres(url, { max: 1 })` directly (matching `migrate.ts`) since they are short-lived one-shot processes.

**Journal today** (`packages/db/drizzle/meta/_journal.json`) — ordered entries; `tag` is the migration filename stem, `idx` the ordinal:

```json
{
  "version": "7",
  "dialect": "postgresql",
  "entries": [
    { "idx": 0, "version": "7", "when": 1784140923298, "tag": "0000_baseline", "breakpoints": true },
    { "idx": 1, "version": "7", "when": 1784145760964, "tag": "0001_conscious_steel_serpent", "breakpoints": true },
    { "idx": 2, "version": "7", "when": 1784153049708, "tag": "0002_reflective_maverick", "breakpoints": true }
  ]
}
```

**Snapshot shape today** (`packages/db/drizzle/meta/0002_snapshot.json`, drizzle-kit v7) — the expected-schema source. Relevant slices the drift check reads (`enums` keyed `schema.name`; each table has `columns`/`indexes`/`foreignKeys`; note the exact serialized forms — enum columns carry `type: "<enum_name>"` + `typeSchema`, varchar carries length in the type string, defaults are pre-quoted strings):

```jsonc
// top-level: { id, prevId, version:"7", dialect:"postgresql", tables:{...}, enums:{...}, ... }
"enums": {
  "public.run_status": { "name": "run_status", "schema": "public",
    "values": ["running","completed","failed","cancelled","timed_out"] }
},
"tables": {
  "public.runs": {
    "name": "runs", "schema": "",
    "columns": {
      "run_id":     { "name": "run_id", "type": "text", "primaryKey": true,  "notNull": true },
      "session_id": { "name": "session_id", "type": "text", "primaryKey": false, "notNull": true },
      "status":     { "name": "status", "type": "run_status", "typeSchema": "public",
                      "primaryKey": false, "notNull": true, "default": "'running'" },
      "model":      { "name": "model", "type": "varchar(255)", "primaryKey": false, "notNull": true },
      "token_usage":{ "name": "token_usage", "type": "jsonb", "primaryKey": false, "notNull": false },
      "created_at": { "name": "created_at", "type": "timestamp with time zone", "notNull": true, "default": "now()" },
      "updated_at": { "name": "updated_at", "type": "timestamp with time zone", "notNull": true, "default": "now()" }
    },
    "indexes": {
      "runs_session_id_idx": { "name": "runs_session_id_idx",
        "columns": [ { "expression": "session_id", "isExpression": false, "asc": true, "nulls": "last" } ],
        "isUnique": false, "method": "btree" }
    },
    "foreignKeys": {
      "runs_session_id_sessions_session_id_fk": { "name": "runs_session_id_sessions_session_id_fk",
        "tableFrom": "runs", "tableTo": "sessions",
        "columnsFrom": ["session_id"], "columnsTo": ["session_id"],
        "onDelete": "no action", "onUpdate": "no action" }
    },
    "compositePrimaryKeys": {}, "uniqueConstraints": {}, "checkConstraints": {}
  }
  // ... 10 more tables: agents, api_keys, messages, sessions, tool_calls, trace_spans, traces, user_workspaces, users, workspaces
}
```

**`__drizzle_migrations` bookkeeping table** (written by `drizzle-orm/postgres-js/migrator`) — lives in the **`drizzle`** schema by default; columns `id` (serial), `hash` (text, the SHA-256 of the migration SQL), `created_at` (bigint epoch-ms). One row per applied migration, in apply order. There is **no `tag` column** — mapping to journal tags is positional/ordinal (see Design Notes).

## Design Notes

### `__drizzle_migrations` and the ordinal mapping (status, SC-01)

- The postgres-js migrator creates `drizzle.__drizzle_migrations` (schema-qualified — **`drizzle`**, not `public`). Always reference it schema-qualified; if the schema/table does not exist, the DB has **never been migrated** → every journal entry is `PENDING`.
- The table stores `hash` + `created_at`, **not** the journal `tag`. The migrator applies journal entries strictly in `idx` order and inserts one bookkeeping row per applied entry in that same order. Therefore the reliable mapping is **ordinal**: sort journal entries by `idx`, sort bookkeeping rows by `created_at` (tie-break by `id`), and zip. Journal entry `i` is `APPLIED` iff a bookkeeping row exists at ordinal `i`; otherwise `PENDING`.
- **Do not** try to match `hash` to a `tag` by recomputing SHA-256 in the status path — that couples status to drizzle's internal hashing and is unnecessary for SC-01 (the ordinal invariant is what the migrator guarantees). Recording `hash` in the result for display is fine, but correctness rests on ordinal alignment. If the bookkeeping row count **exceeds** the journal entry count, report the surplus rows as `UNKNOWN (applied, not in journal)` and exit 0 (status is a report, not a gate) — this surfaces a checked-out branch older than the DB.
- `renderStatusTable` prints a fixed-width table: `IDX | TAG | STATUS` (plus an `APPLIED AT` column from `created_at` when applied). Status exits **0 unconditionally** — it reports, it does not gate.

### Drift check — chosen approach (SC-02, top risk: false positives)

**Decision: implement a focused, self-contained structural introspection in SQL against `information_schema` + `pg_catalog`, and diff it against the committed snapshot. Do NOT call drizzle-kit programmatically for drift.** Justification:

- drizzle-kit ^0.30 has **no stable, documented public programmatic API** for "introspect a live DB to a snapshot object and diff against another snapshot." `drizzle-kit introspect`/`pull` is a CLI that writes `.ts` + a snapshot to disk (side-effecting, needs a temp `out` dir and its own config), and its internal diff/snapshot builders are not part of the package's public exports and change between minor versions. Depending on those internals would make the drift check fragile against a `drizzle-kit` bump and hard to unit-test.
- A focused introspection query set is **deterministic, version-independent, unit-testable** (mock the row sets), and gives us exact control over normalization — which is essential because SC-02's top risk is false positives on a clean DB.

**What the introspection reads** (one bounded query per category, filtered to `table_schema = 'public'` and the known table set from the snapshot):

- **Tables** — `information_schema.tables` (type `BASE TABLE`), excluding `drizzle.__drizzle_migrations`.
- **Columns** — `information_schema.columns`: `column_name`, `data_type`/`udt_name`, `is_nullable`, `column_default`, `character_maximum_length`. Map to the snapshot's `type` string form (see normalization).
- **Enums** — `pg_type` + `pg_enum` (join `pg_namespace` for `public`), enum name → ordered `enumlabel[]`.
- **Indexes** — `pg_indexes` (or `pg_index`+`pg_class`) for index name, table, uniqueness, and column list. Exclude the implicit PK/unique-constraint indexes that the snapshot represents as `compositePrimaryKeys`/`uniqueConstraints` rather than `indexes` (see normalization).
- **Foreign keys** — `information_schema.table_constraints` + `key_column_usage` + `constraint_column_usage` (or `pg_constraint`) for FK name, from-table/cols, to-table/cols, `on delete`/`on update`.
- **NOT NULL / defaults** — carried on the column rows above (compared where feasible; see normalization).

**What is compared:** table presence, column presence + type + `notNull` + normalized default, enum presence + exact ordered value list, index presence + uniqueness + column set, FK presence + endpoints + on-delete/on-update, primary keys. **What is NOT compared:** row data, table statistics, comments, ownership/privileges, RLS policies, triggers, functions, sequences beyond serial-PK defaults, collations, and physical storage. State this explicitly in `renderDriftSummary` output so operators know the scope.

**Normalization (the false-positive firewall — SC-02):** the snapshot and `information_schema` describe the same schema in **different vocabularies**; normalize BOTH sides to a canonical structural model before diffing:

- **Types:** `information_schema` reports `character varying` + `character_maximum_length: 255`; the snapshot says `varchar(255)`. Canonicalize to `varchar(255)`. `timestamp with time zone` is common to both. For enum-typed columns, `information_schema.data_type` is `USER-DEFINED` with `udt_name = run_status`; the snapshot says `type: "run_status"` (+`typeSchema`). Canonicalize the live side to the `udt_name`. `jsonb`/`text`/`integer` map directly.
- **Defaults:** Postgres reports `'running'::run_status`, `now()`, `'{}'::jsonb`; the snapshot stores `'running'`, `now()`, `{}` (roughly). Strip `::<type>` casts and normalize whitespace/quoting before comparing. Treat a missing default on both sides as equal. Because defaults are the highest false-positive risk, compare them **leniently**: canonicalize aggressively and, where a benign representational difference is unavoidable, prefer NOT flagging over flagging (record it as an informational note, not a drift error).
- **Indexes:** exclude PK-backing and unique-constraint-backing indexes from the `indexes` comparison (the snapshot models those under `compositePrimaryKeys`/`uniqueConstraints`, not `indexes`). Compare only the explicitly-declared secondary indexes by name + column set + uniqueness. drizzle's `traces_run_id_idx` is a `uniqueIndex` → present in snapshot `indexes` with `isUnique: true`; the live unique index must match.
- **FK / constraint names:** compare by the drizzle-generated constraint name (stable, deterministic from table/column names). `on delete`/`on update` `no action` in the snapshot maps to `NO ACTION` in the catalog — uppercase-normalize.
- **Ordering:** enum value order **is** significant (Postgres enum ordinality) — compare as an ordered list. Column/table/index sets are compared as **sets keyed by name**, order-insensitive.

`checkDrift` returns a typed `DriftResult`:

```typescript
interface DriftResult {
  hasDrift: boolean;
  expectedSnapshotTag: string;            // e.g. "0002_reflective_maverick"
  differences: DriftDifference[];         // [] when clean
}
interface DriftDifference {
  kind: 'table' | 'column' | 'enum' | 'index' | 'foreignKey' | 'primaryKey';
  object: string;                         // "runs.status", "run_status", ...
  detail: 'missing_in_db' | 'unexpected_in_db' | 'mismatch';
  expected?: string;                      // human-readable expected shape
  actual?: string;                        // human-readable live shape
}
```

`renderDriftSummary` prints each difference grouped by `kind` and the not-compared disclaimer; the CLI exits `1` when `hasDrift`, else `0`.

**Which snapshot is "expected"?** The drift CLI (`db:check`) compares against the **latest** journal snapshot (highest `idx` → `0002_snapshot.json`), i.e. the fully-migrated target. The **preflight guard** compares against the snapshot for the **last-applied** migration (the highest ordinal present in `__drizzle_migrations`), because the DB may legitimately be behind head with pending migrations still to apply — drift there means the *applied* state diverged, not that pending work is outstanding. Resolve the last-applied tag via the ordinal mapping from the status module, then load `meta/<tag>.snapshot` → actually `meta/NNNN_snapshot.json` where `NNNN` is that entry's zero-padded `idx`.

### Preflight guard (SC-03)

- In `migrate.ts`, before `await migrate(...)`: if `process.env['MIGRATE_SKIP_DRIFT_CHECK'] === '1'`, log a loud, single-line warning (`WARNING: drift check skipped via MIGRATE_SKIP_DRIFT_CHECK=1 — applying migrations against a possibly-drifted database`) and proceed. Otherwise run `checkDrift` against the last-applied snapshot; if `hasDrift`, print the drift summary and **`process.exit(1)` WITHOUT calling `migrate`** (apply nothing). If the DB has never been migrated (no bookkeeping table / zero applied), skip the drift check (there is no applied state to drift from) and proceed to migrate.
- The guard must not create the pool twice — reuse the single `postgres(url,{max:1})` pool already opened in `migrate.ts`, pass it (or a `Db`) into `checkDrift`, and only `pool.end()` in one place.

### Process-exit-code contract (consumed by WS-27 CI, WS-29 tests)

- `db:status` → always exit 0.
- `db:check` → exit 0 clean, 1 on drift, 2 on operational error (missing `DATABASE_URL`, unreachable DB, unparseable snapshot) so CI can distinguish "drifted" from "tool broke."
- `migrate` preflight → exit 1 on drift-abort (nothing applied), non-zero on migrate failure (unchanged), 0 on success.
- All three run from **compiled `dist/`** JS (consistent with the existing `migrate` script), so `pnpm --filter @swiftagent/db build` must precede them.

## Implementation Steps

1. **Snapshot/journal loader (`packages/db/src/snapshot.ts`)**: Export `loadJournal(migrationsFolder): Journal` and `loadSnapshot(migrationsFolder, idx): Snapshot`. Define minimal Zod schemas for the subset consumed — `Journal` (`version`, `dialect`, `entries: { idx, tag, when }[]`) and `Snapshot` (`enums: Record<string, { name, schema, values: string[] }>`, `tables: Record<string, { name, columns, indexes, foreignKeys, compositePrimaryKeys, uniqueConstraints }>`). Parse with `.passthrough()` so unknown drizzle-kit fields don't break loading. Snapshot files are named `NNNN_snapshot.json` where `NNNN` is the entry `idx` zero-padded to 4. Resolve `migrationsFolder` the same way `migrate.ts` does (`resolve(__dirname, '../drizzle')`).

2. **Migration status logic (`packages/db/src/migration-status.ts`)**:
   - Export `queryAppliedMigrations(sql): Promise<AppliedRow[]>` — `SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC, id ASC`. Wrap in a check for the table's existence (`to_regclass('drizzle.__drizzle_migrations')`); return `[]` if absent. Keep this the ONLY DB-touching function so unit tests can mock it.
   - Export `computeMigrationStatus(journal, appliedRows): MigrationStatus[]` — pure function; ordinal-zip per Design Notes; produce `{ idx, tag, status: 'APPLIED'|'PENDING', appliedAt?, hash? }`, plus trailing `UNKNOWN` rows for surplus bookkeeping rows.
   - Export `renderStatusTable(rows): string` — fixed-width table.

3. **Structural introspection (`packages/db/src/drift-check.ts`, part A)**: Export `introspectLiveSchema(sql, tableNames): Promise<LiveSchema>` running the bounded per-category queries (tables, columns, enums, indexes, FKs, PKs) filtered to `public` and the snapshot's table set. Return a normalized `LiveSchema` (canonical types, stripped defaults, uppercased referential actions, enum labels in ordinal order, PK/unique-backing indexes excluded from the index set). Each query is a single parameterized `sql`-template call; keep them individually testable.

4. **Snapshot→canonical projection (`drift-check.ts`, part B)**: Export `projectSnapshot(snapshot): ExpectedSchema` mapping the snapshot's vocabulary into the SAME canonical `LiveSchema` shape (same type-string canonicalization, same default normalization, same index exclusions). This symmetry is what makes the diff false-positive-free — both sides pass through identical normalizers.

5. **Diff (`drift-check.ts`, part C)**: Export `diffSchemas(expected, actual): DriftDifference[]` — set-diff tables/columns/enums/indexes/FKs/PKs by name, compare canonical fields, emit `missing_in_db`/`unexpected_in_db`/`mismatch`. Enum values compared as ordered lists. Defaults compared leniently (informational note, never a hard `mismatch`, when only representation differs).

6. **`checkDrift` orchestrator (`drift-check.ts`, part D)**: Export `checkDrift(sql, migrationsFolder, expectedIdx): Promise<DriftResult>` — `loadSnapshot(migrationsFolder, expectedIdx)` → `projectSnapshot` → `introspectLiveSchema` → `diffSchemas`; set `hasDrift = differences.length > 0`. Export `renderDriftSummary(result): string` (grouped diffs + not-compared disclaimer).

7. **Status CLI (`packages/db/src/cli/status.ts`)**: read `DATABASE_URL` (exit 2 if missing), open `postgres(url,{max:1})`, `loadJournal`, `queryAppliedMigrations`, `computeMigrationStatus`, `console.log(renderStatusTable(...))`, `pool.end()`, `process.exit(0)`. Wrap in try/catch → exit 2 on operational error.

8. **Drift CLI (`packages/db/src/cli/check.ts`)**: read `DATABASE_URL` (exit 2 if missing), open pool, resolve the **latest** journal idx, `checkDrift(sql, migrationsFolder, latestIdx)`, print `renderDriftSummary`, `pool.end()`, `process.exit(result.hasDrift ? 1 : 0)`. try/catch → exit 2.

9. **Preflight guard (`packages/db/src/migrate.ts` MODIFY)**: after opening the pool and before `migrate(...)`:
   - If `MIGRATE_SKIP_DRIFT_CHECK === '1'` → loud warn, skip.
   - Else: `queryAppliedMigrations` → if empty (never migrated), skip drift check. Otherwise resolve the last-applied `idx` (count of applied rows − 1, per ordinal mapping), `checkDrift(sql, migrationsFolder, lastAppliedIdx)`; if `hasDrift`, `console.error(renderDriftSummary(...))`, `await pool.end()`, `process.exit(1)` — do **not** call `migrate`.
   - Reuse the existing single pool; keep exactly one `pool.end()` on the success path and one on the abort path.

10. **Package scripts (`packages/db/package.json` MODIFY)**: add
    - `"db:status": "node dist/cli/status.js"`
    - `"db:check": "node dist/cli/check.js"`
    - Add a `"//schema-workflow"` comment field documenting: edit `src/schema/*.ts` → `pnpm db:generate` (tsc + drizzle-kit) → commit migration + snapshot; `pnpm build && pnpm db:status` to inspect applied/pending; `pnpm build && pnpm db:check` to detect drift; `migrate` runs the drift check as a preflight (bypass with `MIGRATE_SKIP_DRIFT_CHECK=1`).

11. **Barrel (`packages/db/src/index.ts` MODIFY, if exposing)**: export `computeMigrationStatus`, `queryAppliedMigrations`, `checkDrift`, and the `DriftResult`/`MigrationStatus` types for WS-29 integration tests to import programmatically.

12. **Build/verify**: `pnpm --filter @swiftagent/db build` produces `dist/cli/status.js` + `dist/cli/check.js`; run `pnpm --filter @swiftagent/db typecheck` and `pnpm --filter @swiftagent/db lint`; fix all errors before reporting complete.

## Tests

Unit only (fixtures + mocks; no DB — real-DB behavior is WS-29). All in `packages/db/src/__tests__/`.

1. **Status: all pending on virgin DB (SC-01)** — `computeMigrationStatus(journal3, [])` → all three tags `PENDING`; `renderStatusTable` shows 3 `PENDING` rows.
2. **Status: all applied (SC-01)** — 3 journal entries + 3 bookkeeping rows (ascending `created_at`) → all `APPLIED`, each with its `appliedAt`; ordinal zip aligns tag `0000_baseline`↔row0, etc.
3. **Status: partial (SC-01)** — 3 journal entries + 2 bookkeeping rows → `0000`/`0001` `APPLIED`, `0002` `PENDING`.
4. **Status: surplus bookkeeping rows** — 2 journal entries + 3 rows → 2 `APPLIED` + 1 trailing `UNKNOWN`; status still exits 0.
5. **Status: missing bookkeeping table** — `queryAppliedMigrations` returns `[]` when `to_regclass` is null (mock) → all `PENDING`, no throw.
6. **Drift: clean DB, zero diffs (SC-02, false-positive firewall)** — feed `projectSnapshot(0002_snapshot fixture)` as the mocked `introspectLiveSchema` result → `diffSchemas` returns `[]`, `hasDrift === false`. This is the critical no-false-positive assertion: a live schema exactly matching the snapshot must produce ZERO differences after normalization.
7. **Drift: type/varchar/enum normalization equivalence (SC-02)** — mocked live rows in raw `information_schema` vocabulary (`character varying`+len 255, `USER-DEFINED`+`udt_name`, `'running'::run_status` default, `NO ACTION`) normalize to the snapshot canonical form → no drift.
8. **Drift: missing column** — live schema lacks `runs.token_usage` → one `DriftDifference` `{ kind:'column', object:'runs.token_usage', detail:'missing_in_db' }`, `hasDrift === true`.
9. **Drift: unexpected column (hand-applied ALTER)** — live schema has an extra `runs.priority` column → `{ kind:'column', detail:'unexpected_in_db' }`, `hasDrift === true`.
10. **Drift: enum value drift (ordered)** — live `run_status` missing `timed_out`, or with values reordered → `{ kind:'enum', object:'run_status', detail:'mismatch' }`.
11. **Drift: dropped secondary index** — live schema missing `traces_run_id_idx` → `{ kind:'index', detail:'missing_in_db' }`; PK-backing indexes excluded so they never appear as spurious diffs.
12. **Drift: FK endpoint/action mismatch** — live `runs_session_id_...fk` with `on delete cascade` vs snapshot `no action` → `{ kind:'foreignKey', detail:'mismatch' }`.
13. **Drift: lenient default (no false positive)** — live default `'{}'::jsonb` vs snapshot `{}` → NOT a hard `mismatch` (informational note at most), `hasDrift` stays `false`.
14. **Preflight idx resolution** — given 2 applied rows, the guard targets snapshot idx `1` (last-applied), not the latest idx `2`; asserted via the pure last-applied-idx helper.
15. **Escape hatch** — with `MIGRATE_SKIP_DRIFT_CHECK=1`, the preflight helper reports "skip" (drift check not invoked); assert the warning string is produced. (Full migrate-abort flow is WS-29.)

## Acceptance Criteria

1. `pnpm --filter @swiftagent/db build` emits `dist/cli/status.js` and `dist/cli/check.js`; `packages/db/package.json` exposes `db:status` and `db:check` scripts (both `node dist/cli/*.js`) plus a documented schema-change-workflow comment. (SC-01)
2. `db:status` reads the journal + `drizzle.__drizzle_migrations` and prints an ordered `IDX | TAG | STATUS [| APPLIED AT]` table with each migration marked `APPLIED`/`PENDING` (and `UNKNOWN` for surplus rows), exiting **0** unconditionally. Mapping is ordinal (`idx` order ↔ `created_at` order), not hash-recomputed. (SC-01)
3. `db:check` introspects the live `public` schema via `information_schema`/`pg_catalog`, normalizes both it and the latest committed snapshot into one canonical structural model, and diffs tables/columns/types/enums(ordered)/indexes/FKs/PKs. It exits **0** on a clean match, **1** on drift (with a human-readable summary + not-compared disclaimer), **2** on operational error. On a cleanly-migrated DB it produces **zero** false-positive differences. (SC-02)
4. Drift detection is **structural only** and does **not** depend on drizzle-kit's programmatic/introspection internals — it uses self-contained catalog queries, making it robust to `drizzle-kit` ^0.30 minor bumps. Data, comments, privileges, triggers, and policies are explicitly out of scope and disclaimed in the output. (SC-02)
5. `migrate` runs the drift check as a **preflight against the last-applied migration's snapshot** and, on drift, **aborts before applying any migration** (`process.exit(1)`, nothing applied). A never-migrated DB skips the check and proceeds. `MIGRATE_SKIP_DRIFT_CHECK=1` bypasses the check with a loud, logged warning. (SC-03)
6. Status/journal-parsing and drift diff/normalization logic are unit-tested with fixture journals, fixture snapshots, and mocked query/introspection layers (no DB); the clean-DB zero-false-positive case is explicitly asserted. Real-DB behavior is deferred to WS-29. (SC-02)
7. `pnpm --filter @swiftagent/db typecheck` (`tsc --noEmit`) and `pnpm --filter @swiftagent/db lint` (`eslint src/`) pass; the new unit tests pass under `pnpm --filter @swiftagent/db test`.
