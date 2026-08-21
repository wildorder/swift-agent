# WS-29: Migration & Observability Integration Tests

## Goal

Prove the two operational hardening surfaces this program delivers — **schema migration/drift tooling** (WS-26) and the **run-metrics API + trace-persistence hardening** (WS-28) — end to end against the real deployed shape: the committed Drizzle migrations applied by the real forward migrator, the `migrate status` / drift-check / preflight-guard exit-code contract, and observability spans/metrics persisted by a **real** run driven through the runtime harness with a deterministic fake provider and fake tool runner. Migration suites use Testcontainers PostgreSQL (some with their own throwaway container because they deliberately mutate migration state); observability suites reuse the shared migrated DB and only read/write ordinary run data.

**Reuse the existing integration-test infrastructure — do not invent a parallel one, and do not touch its schema bootstrap.** The repo already has a working integration harness: root `test/vitest.integration.config.ts` (globs `test/integration/**/*.integration.test.ts`, `globalSetup: ['./test/setup-db.ts']`), driven by the `pnpm test:integration` script. As of **db-migration-baseline WS-01**, `test/setup-db.ts` starts a Testcontainers `postgres:16-alpine`, sets `DATABASE_URL`, and materializes the schema by running the **real Drizzle migrator** against `packages/db/drizzle` (baseline `0000_baseline` + `0001_conscious_steel_serpent` + `0002_reflective_maverick` — the single source of truth; no hand-written DDL, no `drizzle-kit push`). This workstream **makes no changes to `test/setup-db.ts`**. It ADDS integration suites only, under root `test/integration/` with the mandatory `.integration.test.ts` suffix (so they are discovered by the integration config and get the Testcontainers globalSetup — and are NOT picked up as unit tests by the package-level `*.test.ts` default globs), plus any genuinely-shared helper under `test/support/`. It also declares any additional root test `devDependencies` and confirms the whole monorepo type-checks, lints, and passes unit + integration tests.

## Traceability

- **SC-10** — Migration integration tests cover baseline application from empty, ordered incremental application, idempotent re-run, and drift detection against an injected divergence (this workstream is the owner).
- **SC-11** — Observability integration tests cover model/tool/error span persistence, metrics-endpoint roll-ups, and failure-path trace finalization (this workstream is the owner).
- Contributes end-to-end coverage to **SC-01** (`migrate status` accuracy), **SC-02** (drift check positive + false-positive-free), **SC-03** (preflight refuses to apply on drift), **SC-07** (`GET /v1/runs/:runId/metrics` under workspace ownership), **SC-08** (model/tool/error spans persisted and reflected in trace + metrics responses), **SC-09** (span error/metadata payloads bounded before persistence), and **SC-12** (monorepo type-check + lint + unit + integration green).

## Dependencies

- **WS-26** — the `migrate status` (`db:status`) reporter, the drift check (`db:check`), and the `migrate` preflight drift guard are under test here. WS-26 exposes `computeMigrationStatus`, `queryAppliedMigrations`, `checkDrift`, and the `MigrationStatus` / `DriftResult` types from `@swiftagent/db`'s barrel specifically so these integration tests can call them programmatically against a live container DB.
- **WS-28** — the `GET /v1/runs/:runId/metrics` endpoint (returning `RunMetrics`), the **token metadata on model spans** (so `totalTokens` roll-ups are populated), and the **bounded span error/metadata payloads** are under test here.
- **Cross-program:**
  - **db-migration-baseline:WS-01** — `test/setup-db.ts` migrator bootstrap that this builds on (and the `packages/db/src/migrate.ts` forward migrator the migration suites invoke against their own containers).
  - **core-runtime-completion:WS-25** — the `test/support/` harness (`runtime-harness.ts`, `fake-provider.ts`, `fake-runner.ts`) and the integration config this builds on. WS-24 delivered the tracer wiring into the loop and the atomic `saveTraceWithSpans` persistence the observability suites assert against.

## Context Files (Agent MUST read before implementing)

- `c:\dev\swift-agent\CLAUDE.md` — conventions; Vitest + Testcontainers; integration vs unit test split; pinned versions (`@testcontainers/postgresql`, `drizzle-orm ^0.36`, `postgres ^3.4`).
- `c:\dev\swift-agent\test\vitest.integration.config.ts` — the integration config (globs `test/integration/**/*.integration.test.ts`, `globalSetup: ['./test/setup-db.ts']`, `testTimeout: 30000`, `hookTimeout: 60000`). New suites just need the correct path + suffix; **no config change required**. (Note: a migration suite that spins its **own** container may need a longer per-test timeout — set it locally via `it(name, fn, timeoutMs)` or a `describe`-level `vi`/config override, not a global config edit.)
- `c:\dev\swift-agent\test\setup-db.ts` — the Testcontainers globalSetup; it runs the **real Drizzle migrator** against `packages/db/drizzle`, so the full schema is already provisioned for observability suites. **Read-only reference — do NOT modify.** The migration suites replicate this exact `PostgreSqlContainer('postgres:16-alpine')` + `migrate(drizzle(sql), { migrationsFolder })` mechanism against their **own** containers.
- `c:\dev\swift-agent\test\integration\db.integration.test.ts` — an existing DB integration suite; mirror its `beforeAll` connection style (`createDbClient(process.env['DATABASE_URL']!)`, `close` in `afterAll`) for the observability suites that use the shared DB.
- `c:\dev\swift-agent\test\integration\run-repo-terminal.integration.test.ts` — existing terminal-transition integration suite; a good analog for a focused DB suite that seeds workspace→agent→session→run against the shared container and asserts persisted rows.
- `c:\dev\swift-agent\test\support\runtime-harness.ts` — `createRuntimeHarness()`; composes real repos, the fake provider registry, the executor resolver with scoped-token minting, `RunExecutionService`, `Tracer` (wired into `engineDeps`), `buildApp`, and gateway against the shared `DATABASE_URL`. Read its handle surface (below) — the observability suites drive runs and build the metrics-carrying REST app through it.
- `c:\dev\swift-agent\test\support\fake-provider.ts` — `createFakeProvider`, `byTurn`, `textTurn`, `toolTurn`, `ScriptedTurn`; the deterministic model double. Note `ScriptedTurn.usage` (emitted on the `finish` chunk) and `ScriptedTurn.error` (forces a provider error).
- `c:\dev\swift-agent\test\support\fake-runner.ts` — `startFakeRunner`, `reserveFreePort`; the real SDK tool runner with `echo` / `counter` / `slow` / `boom` / `big` tools. Note the `big` tool (oversized output) drives the bounded-payload assertion (SC-09).
- `c:\dev\swift-agent\packages\db\src\repositories\trace-repo.ts` — `getTraceByRunId(runId)`, `listSpansByTraceId(traceId)`, `getTraceById(traceId)`, `saveTraceWithSpans(...)`; the read surface the observability span assertions use.
- `c:\dev\swift-agent\packages\db\src\migrate.ts` — the forward migrator entry (`migrate(drizzle(pool), { migrationsFolder })` resolving `../drizzle`); WS-26 adds the preflight drift guard here. The migration suites either import WS-26's exported functions or run this compiled entry.
- `c:\dev\swift-agent\packages\db\package.json` — `migrate` (`node dist/migrate.js`) and (from WS-26) `db:status` / `db:check` (`node dist/cli/status.js` / `dist/cli/check.js`). The preflight test may invoke the compiled `dist/migrate.js` as a child process to observe its exit code + "nothing applied" behavior.
- `c:\dev\swift-agent\packages\db\drizzle\meta\_journal.json` — the **3-entry** journal (`0000_baseline`, `0001_conscious_steel_serpent`, `0002_reflective_maverick`); the status test asserts all three are `APPLIED` in order.
- `c:\dev\swift-agent\packages\db\drizzle\0001_conscious_steel_serpent.sql` / `0002_reflective_maverick.sql` — confirm `0001` adds `agents.tools` and `0002` adds the `run_status` values `cancelled` / `timed_out`; the baseline-from-empty test asserts exactly these.
- `c:\dev\swift-agent\packages\observability\src\metrics.ts` — `deriveRunMetrics(spans)` → `RunMetrics` (`modelCallCount`, `toolCallCount`, `totalModelLatencyMs`, `totalToolLatencyMs`, `totalTokens`, `timeToFirstTokenMs`, `totalRunDurationMs`); the exact shape the metrics endpoint returns. Note `totalTokens` sums `metadata.promptTokens + metadata.completionTokens` across spans — so the token assertion depends on WS-28 having put token metadata on the model span.
- `c:\dev\swift-agent\tasks\persist-observe\ws-26-migration-status-drift.md` — WS-26's deliverable shape: exit-code contract (`db:status`→0; `db:check`→0 clean / 1 drift / 2 op-error; `migrate` preflight→1 on drift-abort), the ordinal journal↔`drizzle.__drizzle_migrations` mapping, and the `MigrationStatus` / `DriftResult` types.
- `c:\dev\swift-agent\tasks\persist-observe\ws-28-run-metrics-api.md` — WS-28's deliverable: the `GET /v1/runs/:runId/metrics` route, token metadata on model spans, and bounded span payloads.
- `c:\dev\swift-agent\packages\api\src\routes\runs.ts` — the existing run routes (`GET /runs/:runId`, `GET /runs/:runId/tool-calls`, `POST /runs/:runId/cancel`); WS-28 adds `GET /runs/:runId/metrics` alongside these, under the same workspace-ownership + `Bearer <apiKey>` auth.
- `c:\dev\swift-agent\test\integration\rest-runs.integration.test.ts` — how an integration suite builds the REST app via the harness and authenticates (`auth(apiKey) = { authorization: \`Bearer ${apiKey}\` }`, `app.inject(...)`, poll-to-terminal helper). Mirror this for the metrics suite.

## Package

`test/` (root integration tree, `test/integration/`) and `test/support/` (shared helpers only if a genuinely-needed one is missing). **`test/setup-db.ts`, the integration config, `packages/db`, `packages/api`, `packages/observability`, and CI are read-only here** — this workstream ADDS tests. If a harness knob is genuinely missing (see Design Notes), add it under `test/support/`; never hand-edit the schema or a package's source to make a test pass.

## Files Touched

- `test/integration/migration-baseline.integration.test.ts` **(NEW)** — baseline-from-empty, ordered incremental application, idempotent re-run, and `migrate status` accuracy. Uses its **own** throwaway `PostgreSqlContainer` (it applies the migrator from scratch and inspects bookkeeping state, so it must not share the globalSetup DB).
- `test/integration/migration-drift.integration.test.ts` **(NEW)** — drift-detection positive, drift-detection negative (false-positive firewall), and the `migrate` preflight guard (abort-on-drift + `MIGRATE_SKIP_DRIFT_CHECK=1` bypass). Uses its **own** throwaway `PostgreSqlContainer` because it deliberately mutates the live schema via raw SQL.
- `test/integration/observability-spans.integration.test.ts` **(NEW)** — model/tool/error span persistence and failure-path trace finalization + bounded payload, driving real runs through the harness against the **shared** migrated DB.
- `test/integration/run-metrics-api.integration.test.ts` **(NEW)** — `GET /v1/runs/:runId/metrics` roll-ups and cross-workspace 404, driving a real run through the harness and calling the REST app.
- `test/support/pg-container.ts` **(NEW, only if not already present)** — a small shared helper `startMigratedContainer()` / `startEmptyContainer()` that boots a `PostgreSqlContainer('postgres:16-alpine')`, returns `{ url, sql, db, container, teardown }`, and (for the migrated variant) runs the real migrator via the same `migrationsFolder` resolution `test/setup-db.ts` uses. This isolates the "own container" plumbing so the two migration suites don't duplicate it. If WS-25/WS-01 already left an equivalent helper, reuse it and do NOT add a second.
- `package.json` **(MODIFY, root — only if needed)** — the migration suites import `@swiftagent/db` (already a root devDependency per WS-25) and `@testcontainers/postgresql` + `postgres` + `drizzle-orm` (already present for `test/setup-db.ts`). Add nothing unless a fresh transitive import surfaces an undeclared-dependency error under strict pnpm; if so, add it `workspace:^` (workspace pkg) or the pinned version (external) and refresh the lockfile.

> **No `test/setup-db.ts` change, no integration-config change, no CI change, no package-source change.** The migrator bootstrap already provisions the shared schema; WS-26/WS-28 already deliver the tooling/endpoint under test; WS-27 already wires `db:status`/`db:check` into CI. This workstream only adds suites (and at most one `test/support/` container helper).

## Existing Interfaces to Consume

**Runtime harness** (`test/support/runtime-harness.ts`) — the observability + metrics suites build everything through this:

```typescript
const harness = await createRuntimeHarness();          // reads process.env.DATABASE_URL (shared container)
harness.repos.traceRepo;                               // getTraceByRunId / listSpansByTraceId / getTraceById
harness.repos.runRepo;                                 // getById, listBySession, ...
harness.fake.setResponder(fn);                         // swap the deterministic model script per test
const runService = harness.createRunService(options?); // AgentEngineOptions: modelTimeoutMs?, toolTimeoutMs?, totalRunMs?
const app = await harness.buildRestApp(runService);    // AppContext with the metrics route (WS-28) registered
const { workspaceId, apiKey } = await harness.seedWorkspaceWithKey();
const agent = await harness.seedAgent({ workspaceId, tools?, toolRunnerUrl? });
const session = await harness.seedSession(agent.agentId);
await harness.teardown();                              // closes apps/gateways + db client
```

**Driving a real run to terminal.** `RunExecutionService.start({ sessionId, content }, { onEvent?, signal? }) → { runId }` executes process-bound; poll `runRepo.getById(runId)` (or `app.inject GET /v1/runs/:runId`) until a terminal status (`completed` / `failed` / `cancelled` / `timed_out`). Reuse the `pollRun` helper shape from `rest-runs.integration.test.ts`. (`start`'s exact signature is whatever WS-23/WS-25's service exposes; read it — the point is: start → run executes → poll to terminal → assert persisted trace/spans/metrics.)

**Fake model script** (`test/support/fake-provider.ts`):

```typescript
harness.fake.setResponder(byTurn(
  toolTurn('echo', { hello: 'world' }),                 // turn 0: emit a tool_call
  { tokens: ['done'], usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }, // turn 1: final text + usage
));
// error path: setResponder(() => ({ error: 'provider exploded' }))   → provider throws mid-run (SC-08 error span)
```

**Fake tool runner** (`test/support/fake-runner.ts`):

```typescript
const runner = await startFakeRunner({ publicKey: harness.keys.publicKey, workspaceId });
// runner.url → use as the agent's toolRunnerUrl (aud defaults to runner.url; the resolver mints aud = toolRunnerUrl)
// tools: echo (ok), counter (increments runner.counter.value), slow (delays), boom (throws → tool-call error span), big (oversized output → bounded span, SC-09)
await runner.teardown();
```

**Trace read surface** (`packages/db/src/repositories/trace-repo.ts`):

```typescript
const trace = await traceRepo.getTraceByRunId(runId);          // TraceRecordRow | null
const spans = await traceRepo.listSpansByTraceId(trace!.traceId); // SpanRecordRow[], ordered by startedAt
// SpanRecordRow: { spanId, parentSpanId, traceId, type: 'run_span'|'model_call_span'|'tool_call_span',
//                  name, startedAt, completedAt, durationMs, metadata, status: 'ok'|'error', error }
```

**Metrics shape** (`packages/observability/src/metrics.ts`):

```typescript
interface RunMetrics {
  totalRunDurationMs: number | null;
  timeToFirstTokenMs: number | null;
  modelCallCount: number;
  toolCallCount: number;
  totalModelLatencyMs: number;
  totalToolLatencyMs: number;
  totalTokens: number;   // Σ (metadata.promptTokens + metadata.completionTokens) across spans
}
```

**Migration tooling** (from WS-26's barrel exports in `@swiftagent/db`) — called against a live container `sql`/`db`:

```typescript
import {
  queryAppliedMigrations,   // (sql) => Promise<AppliedRow[]>  (reads drizzle.__drizzle_migrations; [] if absent)
  computeMigrationStatus,   // (journal, appliedRows) => MigrationStatus[]  { idx, tag, status:'APPLIED'|'PENDING'|'UNKNOWN', appliedAt? }
  checkDrift,               // (sql, migrationsFolder, expectedIdx) => Promise<DriftResult>  { hasDrift, expectedSnapshotTag, differences }
} from '@swiftagent/db';
```

> If WS-26 did NOT export a given function from the barrel, prefer importing it programmatically over shelling out — but the **preflight-guard** test genuinely needs to observe `migrate`'s process exit code and "nothing applied" side-effect, so it invokes the compiled `dist/migrate.js` as a child process (`execFile`) with `DATABASE_URL` pointed at the drifted container. Note the CLIs (`db:status`/`db:check`) are thin wrappers over the exported functions; call the exported functions directly for the status/drift **assertions** (testable, no `dist` build dependency in the assertion path), and reserve child-process invocation for the exit-code contract of `migrate`'s preflight.

**Real migrator** (`test/setup-db.ts` mechanism, replicated per-container):

```typescript
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
const migrationsFolder = resolve(__dirname, '../../packages/db/drizzle'); // from test/integration → repo/packages/db/drizzle
const sql = postgres(url, { max: 1 });
await migrate(drizzle(sql), { migrationsFolder });
```

## Design Notes

- **Suffix + location (known footgun from WS-25).** Every new suite MUST live at repo ROOT under `test/integration/` with the `.integration.test.ts` suffix. That is the ONLY location the integration config discovers, and the suffix keeps them out of the package-level `*.test.ts` default globs (which would run them DB-less and fail). Do NOT place any of these under a package `__tests__` or `src/`.

- **Container isolation is the top correctness risk.** The migration-baseline and migration-drift suites **deliberately mutate migration state and the live schema** (applying the migrator from empty, hand-`ALTER`ing a table, aborting `migrate`). If they ran against the **shared** globalSetup DB, they would corrupt the schema every other integration suite depends on. Therefore **each migration suite spins its OWN throwaway `PostgreSqlContainer('postgres:16-alpine')`** (via the `test/support/pg-container.ts` helper), and stops it in `afterAll`/`afterEach`. Never point a mutation at `process.env.DATABASE_URL`. A per-test fresh container (or fresh database) is the cleanest isolation for the drift/preflight cases (tests 5–7) and for the idempotency/incremental cases (tests 1–3) — prefer a fresh container per `describe` (or per test where a test both migrates-from-empty AND then drifts) so ordering never leaks state.
- **Observability suites reuse the shared migrated DB.** They only read/write ordinary run/trace data through the harness (which reads `process.env.DATABASE_URL`). No extra container, no mutation of migration state. Isolation between observability tests is by unique seeded workspace/agent/session/run IDs (the harness already generates fresh IDs per seed call).
- **`migrationsFolder` path.** From a suite in `test/integration/`, resolve the migrations folder to `<repo>/packages/db/drizzle` (`resolve(dirname(fileURLToPath(import.meta.url)), '../../packages/db/drizzle')`). This is the same committed folder `test/setup-db.ts` and `packages/db/src/migrate.ts` use — the single source of truth.
- **Drift-negative is the critical anti-false-positive assertion (SC-02).** On a cleanly-migrated container, `checkDrift(sql, migrationsFolder, latestIdx)` must return `hasDrift === false` with an empty `differences` array. This is the highest-value migration assertion — a false positive here would make the CI drift guard (WS-27) block every clean deploy. Assert it explicitly and first among the drift cases.
- **Drift-positive injects a real divergence.** After a clean migrate, mutate the live schema with raw SQL — e.g. `ALTER TABLE agents DROP COLUMN tools` (dropped column) or `ALTER TABLE runs ADD COLUMN stray_col text` (unexpected column) — then `checkDrift` must return `hasDrift === true` with a `DriftDifference` naming the object (`agents.tools` → `missing_in_db`, or `runs.stray_col` → `unexpected_in_db`). Use a raw `sql`-template statement, not a repo method.
- **Preflight guard observes exit code + side-effect.** For SC-03, drift the DB (raw `ALTER`), then invoke the compiled `dist/migrate.js` as a child process with `DATABASE_URL` set to the drifted container and assert: (a) non-zero exit, (b) **nothing was "fixed"** — the injected drift is still present afterward (e.g. the dropped column is still missing, or the stray column still there), and (c) **no new `drizzle.__drizzle_migrations` bookkeeping row** was added (count unchanged). Then re-run with `MIGRATE_SKIP_DRIFT_CHECK=1` in the child env and assert it proceeds (exit 0; and since there are no pending migrations on a head-migrated-then-drifted DB, the bookkeeping count is unchanged but the process must not abort — assert exit 0 and the loud warning on stderr). Requires `pnpm --filter @swiftagent/db build` to have produced `dist/migrate.js` — note this in the suite's preconditions (CI's `integration-tests` job builds packages before running; locally the test should `execFile` the built entry and, if it is missing, fail with a clear message rather than silently passing).
- **Token-usage roll-up depends on WS-28.** `deriveRunMetrics.totalTokens` sums `metadata.promptTokens + metadata.completionTokens` over spans. WS-28 is responsible for putting the fake provider's emitted `usage` onto the model span's metadata as `promptTokens`/`completionTokens`. Script the fake provider's `finish` chunk with an explicit `usage` (e.g. `{ inputTokens: 10, outputTokens: 5, totalTokens: 15 }`) and assert `metrics.totalTokens === 15`. **If, when implementing, the harness/provider does not surface a way to force a specific `usage` onto the persisted model span, add the smallest knob to `test/support/` (the fake provider already supports `ScriptedTurn.usage`) — do NOT edit `packages/*` to make the assertion pass; if the token metadata is genuinely absent on the span, that is a WS-28 gap to report, not a test to fudge.**
- **Forcing an error span.** The tool-error span uses the real `boom` tool (already in `fake-runner.ts`) driven by a `toolTurn('boom', ...)`; the model-error span uses `setResponder(() => ({ error: '...' }))`. Both already exist in the harness doubles — no new knob needed.
- **Bounded payload (SC-09).** Drive the `big` tool (already in `fake-runner.ts`, returns a payload just over `RUNNER_MAX_OUTPUT_BYTES`) and assert the persisted tool-call span's `error`/output is **bounded** — a truncation marker or a length at/under the cap, not the full oversized blob. The exact bound + marker are WS-28's/WS-22's; assert the persisted span payload length is `<=` the documented cap and/or contains the truncation sentinel. If the oversized output instead surfaces as a runner-side rejection (output-bound reject on parse), assert the tool-call span is `status: 'error'` with a bounded error message. Read the WS-28 bounding behavior and assert to that reality.
- **Testcontainers/Docker required.** All suites need Docker (Testcontainers). They run in the `integration-tests` CI job (which already runs `pnpm test:integration` after building packages). Locally, Docker must be running; migration suites additionally require `dist/` (run `pnpm -r build` or `pnpm --filter @swiftagent/db build`) for the preflight child-process test.

## Implementation Steps

1. **Shared container helper (`test/support/pg-container.ts`, only if absent).** Export `startEmptyContainer(): Promise<PgHandle>` (boots `postgres:16-alpine`, returns `{ url, sql, db, container, teardown }`, does NOT migrate) and `startMigratedContainer(): Promise<PgHandle>` (same, then runs the real migrator via the `migrationsFolder` resolution above). `teardown` ends the `sql` pool and stops the container. Reuse an existing equivalent if WS-25/WS-01 left one; do not duplicate.

2. **Migration-baseline suite (`test/integration/migration-baseline.integration.test.ts`).** Each test (or `describe`) gets its own container so migration state never leaks:
   - **Baseline-from-empty:** `startEmptyContainer()`, run the migrator, then introspect `information_schema` and assert all **11** tables exist (`agents`, `api_keys`, `messages`, `runs`, `sessions`, `tool_calls`, `trace_spans`, `traces`, `user_workspaces`, `users`, `workspaces`); assert `run_status` enum values include `cancelled` + `timed_out` (from `0002`); assert `agents.tools` column exists (from `0001`); assert the `span_type` / `span_status` enums exist (baseline `0000`).
   - **Ordered incremental application:** after migrate, `SELECT id, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC, id ASC` → assert exactly **3** rows (matching the 3 journal entries), and that `computeMigrationStatus(loadedJournal, rows)` marks all three `APPLIED` in journal order (`0000_baseline`, `0001_conscious_steel_serpent`, `0002_reflective_maverick`).
   - **Idempotent re-run:** run the migrator a **second** time on the same container → no throw; assert the `drizzle.__drizzle_migrations` row count is still exactly **3** (no duplicate bookkeeping rows) and the schema is unchanged.
   - **`migrate status` accuracy (SC-01):** call `queryAppliedMigrations(sql)` + `computeMigrationStatus(journal, rows)` on the migrated container → all **3** `APPLIED`, none `PENDING`, each with an `appliedAt`. (Also assert the reverse on a fresh `startEmptyContainer()` **before** migrating: `queryAppliedMigrations` returns `[]` and all three compute as `PENDING`.) The CLI (`db:status`) is a thin wrapper over these exported functions; asserting the functions directly is the testable path.

3. **Migration-drift suite (`test/integration/migration-drift.integration.test.ts`).** Own container(s); each drift/preflight test starts from a freshly-migrated container:
   - **Drift-negative (SC-02, false-positive firewall) — assert this FIRST:** `startMigratedContainer()`, then `checkDrift(sql, migrationsFolder, latestIdx=2)` → `hasDrift === false`, `differences.length === 0`.
   - **Drift-positive (SC-02):** on a freshly-migrated container, `await sql\`ALTER TABLE agents DROP COLUMN tools\`` (or add a stray column), then `checkDrift(sql, migrationsFolder, 2)` → `hasDrift === true` with a `DriftDifference` naming the object + `detail` (`missing_in_db` / `unexpected_in_db`). (If invoking the CLI instead: `execFile('node', ['packages/db/dist/cli/check.js'], { env: { DATABASE_URL: url } })` → exit 1; clean-DB exit 0.)
   - **Preflight guard — abort on drift (SC-03):** on a freshly-migrated-then-drifted container, capture the pre-run `drizzle.__drizzle_migrations` row count, `execFile('node', ['packages/db/dist/migrate.js'], { env: { ...process.env, DATABASE_URL: url } })` → assert **non-zero exit**; assert the drift is STILL present (dropped column still missing / stray column still there — migrate "fixed" nothing); assert the bookkeeping row count is **unchanged** (no migration applied).
   - **Preflight guard — bypass (SC-03):** same drifted container, `execFile` with `env.MIGRATE_SKIP_DRIFT_CHECK = '1'` → assert **exit 0** (it proceeds past the guard) and a loud warning on stderr; bookkeeping count unchanged (there are no pending migrations to apply on a head DB, so the assertion is: it did NOT abort).

4. **Observability-spans suite (`test/integration/observability-spans.integration.test.ts`).** Shared DB via `createRuntimeHarness()`; `afterAll` teardown:
   - **Model/tool/error span persistence (SC-08):** seed workspace + agent (with the `echo`/`counter` tool + a real `startFakeRunner`); script `byTurn(toolTurn('echo', {...}), textTurn('done', usage))`; start the run, poll to `completed`; `traceRepo.getTraceByRunId(runId)` → non-null; `listSpansByTraceId(trace.traceId)` → contains exactly one `run_span` (root, `parentSpanId === null`, `status: 'ok'`), at least one `model_call_span` (`status: 'ok'`), and one `tool_call_span` for `echo` (`status: 'ok'`).
   - **Error span persistence (SC-08):** two variants — (a) tool failure via `toolTurn('boom', {})` → the `boom` tool-call span has `status: 'error'` and a bounded `error` payload; (b) model failure via `setResponder(() => ({ error: 'provider exploded' }))` → the model-call span (or root span) has `status: 'error'`; run terminal `failed`.
   - **Failure-path trace finalization (SC-08/SC-11):** for a run that ends `failed` (or `cancelled`/`timed_out`), assert a trace still exists AND the **root `run_span` is finalized** — `completedAt !== null`, `durationMs !== null`, `status: 'error'` — proving finalization runs on every exit path (not just success).
   - **Bounded payload (SC-09):** drive the `big` tool → assert the persisted `tool_call_span` payload/`error` is bounded (truncation marker present or length `<=` the documented cap), never the full oversized blob.

5. **Run-metrics-API suite (`test/integration/run-metrics-api.integration.test.ts`).** Shared DB via the harness; build the REST app through `harness.buildRestApp(runService)` (which registers WS-28's metrics route), authenticate with `Bearer <apiKey>` exactly like `rest-runs.integration.test.ts`:
   - **Metrics roll-ups (SC-07):** seed workspace+key+agent (echo tool + runner); script `byTurn(toolTurn('echo', {...}), { tokens: ['done'], usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } })`; start the run, poll `GET /v1/runs/:runId` to `completed`; `GET /v1/runs/:runId/metrics` with the owning key → `200`; assert `modelCallCount >= 1`, `toolCallCount === 1`, `totalModelLatencyMs >= 0`, `totalToolLatencyMs >= 0`, `totalRunDurationMs >= 0`, and `totalTokens === 15` (proving WS-28 put token metadata on the model span).
   - **Cross-workspace 404 (SC-07 ownership):** seed a **second** workspace + key; `GET /v1/runs/:runId/metrics` for the first workspace's run using the second workspace's key → `404` (no existence leak), matching the ownership behavior of the sibling run endpoints.

6. **Root deps + lockfile (only if needed).** If any new suite triggers a strict-pnpm undeclared-dependency error, add the missing workspace package (`workspace:^`) or pinned external to root `package.json` devDependencies and `pnpm install`. Expect none new (all imports — `@swiftagent/db`, `@testcontainers/postgresql`, `postgres`, `drizzle-orm`, and the WS-25 harness deps — are already declared).

7. **Green gate (SC-12).** Run `pnpm -w exec tsc --noEmit`, `pnpm -w exec eslint . --quiet`, `pnpm -w test` (unit), and `pnpm test:integration` (Docker required; `pnpm --filter @swiftagent/db build` first so `dist/migrate.js` + `dist/cli/*.js` exist for the preflight child-process test). Fix all failures in the new suites; do not modify package source to make an assertion pass.

## Tests

(This workstream *is* tests. Each case below is a required integration test with concrete setup + assertions.)

1. **Baseline-from-empty (SC-10).** *Setup:* own empty container; run the real migrator. *Assert:* all 11 tables present via `information_schema.tables` (`agents, api_keys, messages, runs, sessions, tool_calls, trace_spans, traces, user_workspaces, users, workspaces`); `run_status` enum includes `cancelled` + `timed_out`; `agents.tools` column present; `span_type`/`span_status` enums present.
2. **Ordered incremental application (SC-10).** *Setup:* own container, migrated once. *Assert:* `drizzle.__drizzle_migrations` has exactly 3 rows ordered by `created_at`; `computeMigrationStatus(journal, rows)` yields the 3 tags `APPLIED` in journal order.
3. **Idempotent re-run (SC-10).** *Setup:* migrate the same container twice. *Assert:* second run does not throw; `drizzle.__drizzle_migrations` still has exactly 3 rows (no duplicates); schema unchanged.
4. **`migrate status` accuracy (SC-01/SC-10).** *Setup:* migrated container (and a separate empty one). *Assert:* on migrated → `computeMigrationStatus` marks all 3 `APPLIED` with `appliedAt`, none `PENDING`; on empty → `queryAppliedMigrations` returns `[]` and all 3 compute as `PENDING`.
5. **Drift-detection negative — false-positive firewall (SC-02).** *Setup:* freshly-migrated container, no mutation. *Assert:* `checkDrift(sql, migrationsFolder, 2)` → `hasDrift === false`, `differences === []`. (Critical anti-false-positive case.)
6. **Drift-detection positive (SC-02).** *Setup:* freshly-migrated container, then `ALTER TABLE agents DROP COLUMN tools` (or add a stray column) via raw `sql`. *Assert:* `checkDrift` → `hasDrift === true` with a `DriftDifference` naming the object + `detail` (`missing_in_db`/`unexpected_in_db`). (CLI variant: `db:check` exits 1.)
7. **Preflight guard aborts on drift (SC-03).** *Setup:* freshly-migrated-then-drifted container; capture bookkeeping row count; `execFile` compiled `dist/migrate.js` with `DATABASE_URL` at the drifted DB. *Assert:* non-zero exit; injected drift still present (nothing "fixed"); bookkeeping row count unchanged (nothing applied).
8. **Preflight bypass with `MIGRATE_SKIP_DRIFT_CHECK=1` (SC-03).** *Setup:* same drifted container; `execFile` `dist/migrate.js` with `MIGRATE_SKIP_DRIFT_CHECK=1`. *Assert:* exit 0 (proceeds past guard), loud warning on stderr; does not abort.
9. **Model/tool span persistence (SC-08/SC-11).** *Setup:* harness run with `echo` tool + real runner; `byTurn(toolTurn('echo',…), textTurn('done', usage))`; poll to `completed`. *Assert:* `getTraceByRunId` non-null; spans include one root `run_span` (`parentSpanId===null`, `status:'ok'`), ≥1 `model_call_span` (`ok`), one `tool_call_span` for `echo` (`ok`).
10. **Tool-error span persistence (SC-08/SC-11).** *Setup:* `toolTurn('boom', {})` against the real runner; poll to `failed`. *Assert:* the `boom` `tool_call_span` has `status:'error'` and a bounded `error` payload.
11. **Model-error span persistence (SC-08).** *Setup:* `setResponder(() => ({ error: 'provider exploded' }))`; poll to `failed`. *Assert:* the model-call span (or root span) has `status:'error'`; run terminal `failed`.
12. **Failure-path trace finalization (SC-08/SC-11).** *Setup:* a run ending `failed` (or `cancelled`/`timed_out`). *Assert:* trace exists AND root `run_span` is finalized (`completedAt!==null`, `durationMs!==null`, `status:'error'`) — finalization on every exit path.
13. **Bounded payload (SC-09).** *Setup:* drive the `big` tool (oversized output). *Assert:* the persisted `tool_call_span` payload/`error` is bounded (truncation marker present or length `<=` the documented cap), never the full blob.
14. **Metrics endpoint roll-ups (SC-07/SC-11).** *Setup:* harness run (echo tool + runner) with the fake `finish` usage `{ inputTokens:10, outputTokens:5, totalTokens:15 }`; poll to `completed`; `GET /v1/runs/:runId/metrics` with the owning `Bearer` key. *Assert:* `200`; `modelCallCount>=1`, `toolCallCount===1`, `totalModelLatencyMs>=0`, `totalToolLatencyMs>=0`, `totalRunDurationMs>=0`, `totalTokens===15`.
15. **Metrics cross-workspace 404 (SC-07).** *Setup:* a second workspace + key. *Assert:* `GET /v1/runs/:runId/metrics` for the first workspace's run using the second key → `404` (no existence leak).
16. **Full green gate (SC-12).** *Assert:* `pnpm -w exec tsc --noEmit`, `pnpm -w exec eslint . --quiet`, unit tests, and `pnpm test:integration` (including all suites above) pass.

## Acceptance Criteria

1. All new suites live at repo ROOT under `test/integration/` with the `.integration.test.ts` suffix (discovered only by `pnpm test:integration`, never as unit tests). `test/setup-db.ts`, the integration config, `packages/*` source, and CI are unmodified; the only additions are the four suites and at most one `test/support/` container helper.
2. **Migration suites use their OWN throwaway `PostgreSqlContainer('postgres:16-alpine')`** (never the shared globalSetup DB) because they mutate migration state and the live schema; observability + metrics suites reuse the shared migrated DB via the WS-25 harness and isolate by fresh seeded IDs. Migration containers are stopped in teardown.
3. **Migration coverage (SC-10):** baseline-from-empty (all 11 tables, `run_status` incl. `cancelled`/`timed_out`, `agents.tools`), ordered incremental application (3 bookkeeping rows in order), idempotent re-run (no duplicate rows), and `migrate status` accuracy (all `APPLIED` on migrated, all `PENDING` on empty) are implemented and pass.
4. **Drift coverage (SC-02):** the drift check returns **zero** differences on a cleanly-migrated DB (false-positive firewall, asserted explicitly) and **drift** on an injected raw-SQL divergence naming the diverged object.
5. **Preflight coverage (SC-03):** `migrate` against a drifted DB aborts with a non-zero exit, applies nothing (injected drift still present, no new bookkeeping row), and `MIGRATE_SKIP_DRIFT_CHECK=1` bypasses the guard (exit 0, loud warning).
6. **Observability coverage (SC-08/SC-11):** a real harness-driven run persists a root `run_span` + `model_call_span` + `tool_call_span` with correct statuses; tool-error and model-error runs persist an `error`-status span with a bounded error; failure/cancel/timeout runs still persist a finalized trace (root span ended, error status); an oversized tool payload yields a bounded persisted span (SC-09).
7. **Metrics coverage (SC-07/SC-11):** `GET /v1/runs/:runId/metrics` returns the `RunMetrics` roll-ups (`modelCallCount`, `toolCallCount`, non-negative latencies, and `totalTokens` matching the fake provider's emitted usage) for the owning workspace, and returns `404` for a foreign workspace.
8. `pnpm -w exec tsc --noEmit`, `pnpm -w exec eslint . --quiet`, unit tests, and `pnpm test:integration` all pass (SC-12). No `packages/*` source was edited to make an assertion pass; any genuinely-missing test knob was added under `test/support/` (and any genuine WS-26/WS-28 gap is reported, not worked around).
