# WS-27: CI Drift Guard, Deploy Alignment & Rollback Runbook

## Goal

Operationalize and document the migration status/drift capability that **WS-26** builds into `packages/db` (the `db:status` / `db:check` commands and the drift-aware preflight guard baked into `migrate`). This workstream does **three** things and nothing more: (1) it adds a **CI drift guard** so a schema change that was not captured as a generated migration fails the build (SC-04); (2) it **aligns the deployed ECS migration task / deploy workflows** to the exact same migrator + drift-aware preflight that local and CI use, and documents the `MIGRATE_SKIP_DRIFT_CHECK` override that the reconciliation path needs (SC-05); and (3) it authors a **rollback & reconciliation runbook** (`docs/runbooks/migrations.md`, NEW) covering forward-fix rollback, snapshot/restore data rollback, and operator-driven deployed-drift reconciliation, validated against a **worked forward-fix example** (SC-06). **Scope: S-sized, three files.** No new `packages/db` code is written here — WS-26 owns the commands; this workstream *consumes* them. Rollback stays **documented, not a `down` command**, and reconciliation stays **operator-driven, not automated** — both are explicit program decisions.

## Traceability

- **SC-04** — CI fails the build when schema drift is present. (The drift command itself — `db:check` — is delivered by WS-26; this workstream wires it into `.github/workflows/ci.yml`.)
- **SC-05** — The deployed ECS migration task runs the same migrator and status gate as local and CI, and the drift-aware preflight (from WS-26's `migrate`) applies on deploy, with a documented `MIGRATE_SKIP_DRIFT_CHECK` override for the reconciliation path.
- **SC-06** — A documented runbook covers forward-fix rollback, snapshot/restore, and deployed-drift reconciliation, validated against a worked forward-fix example.

## Dependencies

- **WS-26** — the `db:status` / `db:check` commands + the `migrate` preflight guard (drift-aware `migrate` that refuses to apply on divergence, honoring `MIGRATE_SKIP_DRIFT_CHECK`). **This workstream MUST NOT start until WS-26 has landed those scripts and the preflight in `packages/db`.** The build agent MUST confirm `db:status` and `db:check` exist in `packages/db/package.json` and that `migrate` runs the preflight before wiring any of them.
- **Cross-program: db-migration-baseline WS-01** — the greenfield baseline and the deploy migrate path (`node dist/migrate.js` via ECS RunTask; `migrate` is the single source of truth, `push` is dropped). This workstream aligns that same path.

## Context Files (Agent MUST read before implementing)

- `c:\dev\swift-agent\CLAUDE.md` — conventions (Drizzle ORM ^0.36, drizzle-kit ^0.30, postgres.js, ESM, `ENV_KEYS` single source of truth in `@swiftagent/shared`).
- `c:\dev\swift-agent\.github\workflows\ci.yml` — the CI file. Jobs today: `build-lint`, `unit-tests`, `integration-tests`. **`integration-tests` already builds (`pnpm build`) and has a DB path available via Testcontainers** (`test/setup-db.ts` provisions PostgreSQL per-suite and applies the Drizzle migrations); only a `redis` service is declared at the job level. This is where the drift guard lands (see Design Notes for the justification). The `integration-tests` job is pasted verbatim under *Existing Interfaces to Consume*.
- `c:\dev\swift-agent\packages\db\package.json` — the `migrate` script (`node dist/migrate.js`) and the NEW `db:status` / `db:check` scripts that **WS-26 adds**. This workstream references them as a dependency; confirm they exist before wiring.
- `c:\dev\swift-agent\packages\db\src\migrate.ts` — the migrator CLI entry (`migrate(drizzle(postgres(url,{max:1})), { migrationsFolder })`), compiled to `dist/migrate.js`. WS-26 adds the drift preflight *inside this file* (or a module it calls) so the deployed task picks it up for free.
- `c:\dev\swift-agent\infra\migrate.sh` — an ECS-RunTask migration wrapper that verifies DB connectivity then runs `node dist/migrate.js`. **NOTE:** the deploy workflows do **not** currently invoke this script — they pass a `containerOverrides` command directly (see below). The agent must decide whether to add a status/check step here or to the workflows (see Implementation Steps).
- `c:\dev\swift-agent\.github\workflows\deploy-dev.yml`, `deploy-staging.yml`, `deploy-prod.yml` — the deploy workflows. Each has a **"Run database migration"** step that calls `aws ecs run-task ... --overrides '{"containerOverrides":[{"name":"<env>-swiftagent","command":[...]}]}'`. **These are the real deployed migrate path**, not `migrate.sh`.
- `c:\dev\swift-agent\infra\modules\ecs\task-definition.tf` — the ECS task definition (single container, `secrets` injected from SSM including `DATABASE_URL`). There is **no dedicated migrate task definition** — the deploy reuses the service task definition with a command override. The build agent MUST locate this precisely and decide whether to add `MIGRATE_SKIP_DRIFT_CHECK` as an (unset-by-default) container env; do **not** invent a separate Terraform migrate task.
- `c:\dev\swift-agent\packages\shared\src\config.ts` — `ENV_KEYS` + the validated env schema. `MIGRATE_SKIP_DRIFT_CHECK` is a **migrate-CLI-only** flag read directly by the WS-26 preflight; it is **not** part of the server's validated `ENV_KEYS` schema and MUST NOT be added there (adding it would force it on the running server, which never migrates).

## Package

`.github/workflows`, `infra`, `docs/runbooks`, `packages/db` (scripts only — reference/verify, not author).

## Files Touched

- `.github/workflows/ci.yml` **(MODIFY)** — add a drift-guard step to the existing `integration-tests` job that applies the committed migrations against a job Postgres and runs `db:check`; a non-zero exit fails the build (SC-04).
- `.github/workflows/deploy-dev.yml` **(MODIFY)** — the "Run database migration" command override already runs `dist/migrate.js`, which (post-WS-26) runs the drift preflight; confirm the command path is correct and (optionally) add a status log step. **Also fix the pre-existing path inconsistency** (see Design Notes).
- `.github/workflows/deploy-staging.yml` **(MODIFY)** — same alignment as dev.
- `.github/workflows/deploy-prod.yml` **(MODIFY)** — same alignment as dev/staging.
- `infra/migrate.sh` **(MODIFY, if used)** — if the agent chooses to route deploys through this wrapper (it is NOT wired today), add a `db:status` echo step and rely on the `migrate` preflight; otherwise leave it and document that it is unused. Prefer NOT introducing new wiring — keep the change small.
- `infra/modules/ecs/task-definition.tf` **(MODIFY, only if needed)** — add `MIGRATE_SKIP_DRIFT_CHECK` as an optional container environment variable wired from a Terraform variable defaulting to unset/`""`, so operators can flip it for the reconciliation path without editing the task def by hand. Only do this if it can be done without disturbing the running server (the server ignores it).
- `docs/runbooks/migrations.md` **(NEW)** — the rollback & reconciliation runbook with a worked forward-fix example (SC-06).
- `packages/db/package.json` **(VERIFY, do not modify unless a script is missing)** — confirm `migrate`, `db:status`, `db:check` exist (WS-26 owns them). If `db:check` is absent, STOP — WS-26 is incomplete.

## Existing Interfaces to Consume

**CI `integration-tests` job today** (`.github/workflows/ci.yml`) — the drift guard is added to *this* job because it already builds and has a DB path:

```yaml
  # ── Job 3: Integration Tests (after Jobs 1 + 2) ─────────────────────
  integration-tests:
    name: Integration Tests
    runs-on: ubuntu-latest
    needs: [build-lint, unit-tests]

    services:
      redis:
        image: redis:7-alpine
        ports:
          - 6379:6379
        options: >-
          --health-cmd="redis-cli ping"
          --health-interval=10s
          --health-timeout=5s
          --health-retries=5

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build
        run: pnpm build
        env:
          TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}
          TURBO_TEAM: ${{ secrets.TURBO_TEAM }}

      - name: Run integration tests
        run: pnpm test:integration
        env:
          # DATABASE_URL is provisioned per-suite by test/setup-db.ts (Testcontainers),
          # which starts its own PostgreSQL and applies the Drizzle migrations.
          REDIS_URL: redis://localhost:6379
```

> **Important:** the integration *tests* get their DB from Testcontainers **inside** the test process (`test/setup-db.ts`), which is not reachable from a plain workflow step. The drift guard therefore needs **its own** Postgres it can point `DATABASE_URL` at from the shell (a `services: postgres` block or an inline `docker run`). See Implementation Steps step 2.

**Deployed migrate step today** (`.github/workflows/deploy-prod.yml`, "Run database migration") — the command override is the deployed migrate path:

```yaml
      - name: Run database migration
        run: |
          TASK_DEF=$(aws ecs describe-services \
            --cluster $ECS_CLUSTER \
            --services $ECS_SERVICE \
            --query 'services[0].taskDefinition' \
            --output text)

          NETWORK_CONFIG=$(aws ecs describe-services \
            --cluster $ECS_CLUSTER \
            --services $ECS_SERVICE \
            --query 'services[0].networkConfiguration' \
            --output json)

          TASK_ARN=$(aws ecs run-task \
            --cluster $ECS_CLUSTER \
            --task-definition $TASK_DEF \
            --launch-type FARGATE \
            --network-configuration "$NETWORK_CONFIG" \
            --overrides '{"containerOverrides": [{"name": "'"$ENVIRONMENT"'-swiftagent", "command": ["node", "dist/migrate.js"]}]}' \
            --query 'tasks[0].taskArn' \
            --output text)
          # ... waits for tasks-stopped, checks exitCode != 0 → fail
```

> **Pre-existing inconsistency to fix (SC-05 alignment):** `deploy-prod.yml` and `deploy-staging.yml` use `command: ["node", "dist/migrate.js"]`, but `deploy-dev.yml` uses `command: ["node", "packages/db/dist/migrate.js"]`. Exactly one is correct given the container's working directory (the Dockerfile sets the workdir; the build agent MUST read `apps/server/Dockerfile` to determine which path resolves inside the image) — normalize all three to the same, correct command so every environment runs the identical migrator + WS-26 preflight.

**`infra/migrate.sh` today** — a wrapper that is present but **not invoked** by the deploy workflows:

```bash
#!/usr/bin/env bash
set -euo pipefail
# ... verifies DB connectivity via `node -e` postgres SELECT 1 ...
echo "Running database migrations..."
node dist/migrate.js
echo "=== Migration completed successfully ==="
# Manual rollback instructions (comment): revert task def, restore RDS snapshot, update SSM.
```

**Migrator CLI today** (`packages/db/src/migrate.ts`) — resolves `migrationsFolder = ../drizzle`, requires `DATABASE_URL`, runs `migrate(...)`, `process.exit(1)` on failure. **WS-26 adds the drift preflight here** so `dist/migrate.js` (what the ECS task runs) refuses to apply on drift unless `MIGRATE_SKIP_DRIFT_CHECK` is set. This workstream does not edit `migrate.ts`.

**`packages/db` scripts** (`packages/db/package.json`) — today: `"migrate": "node dist/migrate.js"`, `"db:generate": "tsc && drizzle-kit generate"`. **WS-26 adds** `db:status` and `db:check` (consumed here). This workstream reads/verifies them; it does not author them.

## Design Notes

- **Where the CI guard lives — decision: extend the existing `integration-tests` job with a dedicated Postgres and a drift-guard step.** Rationale: that job already runs `pnpm build` (so `dist/migrate.js` and the compiled `db:check` exist) and already gates the merge after `build-lint` + `unit-tests`. Adding a small step there is cheaper than a whole new job (no duplicate checkout/install/build) while keeping the guard on the critical merge path. **Caveat:** the integration *tests'* Testcontainers DB is process-internal and not shell-reachable, so the guard needs its **own** Postgres (a job-level `services: postgres` block, or an inline `docker run postgres:16-alpine`). Point `DATABASE_URL` at it, run `pnpm --filter @swiftagent/db migrate` (applies committed migrations), then `pnpm --filter @swiftagent/db db:check`. This is deliberately a *separate* DB from the test containers so the guard is a clean, deterministic apply-then-check.
- **The guard is false-positive-safe.** It runs `db:check` against a **freshly-migrated** database — one that just had exactly the committed migrations applied to it, and nothing else. Such a DB is, by construction, in perfect agreement with the journal-implied schema. Therefore **any** non-zero `db:check` here means a real authoring mistake: a change to `packages/db/src/schema/*.ts` that was **not** captured as a generated migration (the author forgot `pnpm db:generate`, or committed the schema edit but not the resulting `000N_*.sql` + snapshot). There is no benign failure mode. Document this in the step's comment so a future maintainer does not "quiet" a legitimate red build.
- **Deploy alignment is mostly free.** WS-26 builds the preflight *into* `migrate`, and the ECS task already runs `dist/migrate.js`. So the deployed task inherits drift-refusal automatically — the alignment work is (a) confirming the command path is correct and identical across all three deploy workflows, and (b) exposing the `MIGRATE_SKIP_DRIFT_CHECK` override for the reconciliation path. Do **not** re-implement drift logic in the workflow; rely on the migrator's own preflight and exit code (the workflows already fail the deploy on a non-zero migrate exit).
- **`MIGRATE_SKIP_DRIFT_CHECK` is an escape hatch, not a default.** It exists solely for the operator-driven reconciliation procedure (bring a diverged deployed schema back onto the baseline, then re-enable the guard). It is set **per-invocation** (a one-off `containerOverrides.environment` entry on the reconciliation RunTask, or a temporarily-set Terraform var), **never** left on. It is a migrate-CLI flag, so it does **not** belong in the server's validated `ENV_KEYS`.
- **Rollback is DOCUMENTED, not a `down` command.** This is an explicit program decision — Drizzle is **forward-only**. There are no down-migrations anywhere in this codebase and this workstream must not introduce the concept. Schema rollback = a **new** `db:generate`-produced forward migration that reverses the unwanted change. Be firm about this in the runbook.
- **Reconciliation stays operator-driven — NOT automated.** The guard *detects* drift; it never *mutates* a deployed database to fix it. The runbook gives the human procedure. This is an explicit program scope-out; do not add any auto-reconcile tooling.
- **Keep it S-sized.** Three files of substance (`ci.yml`, the three deploy workflows collectively, and `docs/runbooks/migrations.md`), plus the optional Terraform env var. Do not expand scope into WS-26's command internals or WS-28/WS-29's territory.

## Implementation Steps

1. **Verify the WS-26 dependency is satisfied.** Read `packages/db/package.json` and confirm `db:status` and `db:check` scripts exist and that `migrate.ts` (or a module it imports) runs the drift preflight honoring `MIGRATE_SKIP_DRIFT_CHECK`. Run `pnpm --filter @swiftagent/db db:check` locally against a freshly-migrated DB to confirm it exits `0` on a clean schema. **If any of these are missing, STOP and report that WS-26 is incomplete** — do not stub them here.

2. **Add the CI drift guard (`.github/workflows/ci.yml`, MODIFY).** In the `integration-tests` job:
   - Add a `postgres` service alongside `redis` (image `postgres:16-alpine`, a health-checked `5432:5432` mapping, `POSTGRES_PASSWORD`/`POSTGRES_DB` set) — this is the guard's dedicated, shell-reachable DB (the test suite's Testcontainers DB is not reachable from a workflow step).
   - After the existing `Build` step (so `dist/migrate.js` and compiled `db:check` exist), add a step **"Schema drift guard"**:
     ```yaml
     - name: Schema drift guard
       # Applies the committed migrations to a clean DB then runs db:check.
       # A freshly-migrated DB always matches the journal, so a non-zero exit here
       # means a schema change was not captured as a generated migration
       # (author forgot `pnpm db:generate` / did not commit the 000N_*.sql + snapshot).
       run: |
         pnpm --filter @swiftagent/db migrate
         pnpm --filter @swiftagent/db db:check
       env:
         DATABASE_URL: postgres://postgres:postgres@localhost:5432/swiftagent_ci
     ```
   - Keep the existing "Run integration tests" step unchanged (it still uses Testcontainers). Decide (and comment) whether the guard runs **before** the integration tests to fail fast — order it first among the two DB steps.

3. **Confirm and normalize the deployed migrate command (`deploy-dev.yml`, `deploy-staging.yml`, `deploy-prod.yml`, MODIFY).**
   - Read `apps/server/Dockerfile` to determine the container working directory and therefore whether `dist/migrate.js` or `packages/db/dist/migrate.js` is the correct path inside the image.
   - Normalize the `containerOverrides.command` in **all three** deploy workflows to the single correct path so every environment runs the identical migrator + WS-26 preflight (SC-05). Today prod/staging use `dist/migrate.js` and dev uses `packages/db/dist/migrate.js` — pick the correct one and make all three match.
   - No drift logic is added to the workflow: the migrator's own preflight (WS-26) exits non-zero on drift, and the existing `exitCode != 0 → exit 1` guard already fails the deploy. Add a one-line comment above the migrate step noting that drift refusal is enforced by the migrator preflight and overridable only via `MIGRATE_SKIP_DRIFT_CHECK` per the runbook.

4. **(Optional, only if clean) Expose the reconciliation override (`infra/modules/ecs/task-definition.tf`, MODIFY).** Add a Terraform variable (e.g. `migrate_skip_drift_check`, default `""`) and wire it as a container `environment` entry `MIGRATE_SKIP_DRIFT_CHECK` on the task definition, so operators can flip it for a reconciliation RunTask without hand-editing the task def. Because the running server never migrates, this env is inert for normal operation. If wiring it cleanly is non-trivial, prefer the simpler path: document setting it as a per-invocation `containerOverrides.environment` entry on the reconciliation `aws ecs run-task` call (no Terraform change) — and note that choice in the runbook.

5. **Decide the `infra/migrate.sh` disposition (MODIFY or leave).** Since the deploy workflows invoke `node dist/migrate.js` directly (not `migrate.sh`), either: (a) leave `migrate.sh` as-is and add a comment/runbook note that it is a standalone manual wrapper not used by CD; or (b) if the agent prefers routing deploys through it, add a `pnpm --filter @swiftagent/db db:status` echo before the migrate call and switch the workflows to call the script. **Prefer (a)** to keep the change small — do not introduce new wiring unless it demonstrably reduces drift between environments.

6. **Author the runbook (`docs/runbooks/migrations.md`, NEW).** Structure it with these sections (see Tests for the worked-example requirement):
   1. **Overview & principles** — forward-only migrations; `migrate` is the single schema path; drift is detected by `db:check` in CI and by the `migrate` preflight on deploy; reconciliation is operator-driven.
   2. **Inspecting state** — `pnpm --filter @swiftagent/db db:status` (applied vs. pending) and `db:check` (drift yes/no), and how to run them against a deployed DB (via an ECS RunTask override or a bastion/session with `DATABASE_URL` set).
   3. **Schema rollback = forward-fix (NO down-migrations).** The procedure: edit `packages/db/src/schema/*.ts` to the desired end-state → `pnpm --filter @swiftagent/db db:generate` → review the emitted `000N_*.sql` → commit migration + snapshot + `_journal.json` → deploy (the migrate task applies it). State plainly that Drizzle has no `down` and this repo does not implement one.
   4. **Data rollback = snapshot/restore.** Reference the pre-migration RDS snapshot the deploy workflow already creates (`swiftagent-<env>-pre-deploy-<timestamp>` in `deploy-prod.yml`) and the `aws rds restore-db-instance-from-db-snapshot` procedure from `infra/migrate.sh`'s comments. Note that restore is for **data**/destructive-DDL recovery; ordinary unwanted schema changes use forward-fix.
   5. **Deployed-drift reconciliation (operator-driven).** When the deployed schema has diverged from the journal (guard/preflight blocks): (a) diagnose with `db:status` + `db:check`; (b) decide whether to bring the DB *forward* onto the journal (author a forward-fix that expresses the missing DDL as a migration) or to *restore* from snapshot; (c) if forward-fixing requires applying migrations on top of a diverged DB, set `MIGRATE_SKIP_DRIFT_CHECK=1` **for that single reconciliation RunTask only**, apply, then immediately **re-run `db:check` with the override off** to confirm the DB is back on baseline; (d) never leave the override enabled. Include the exact `aws ecs run-task ... --overrides` snippet with a `command` of `["node","dist/migrate.js"]` and an `environment` entry `{"name":"MIGRATE_SKIP_DRIFT_CHECK","value":"1"}`.
   6. **Worked forward-fix example** (satisfies SC-06) — see step 7.

7. **Write the worked forward-fix example into the runbook.** A concrete, copy-pasteable walkthrough:
   - *Mistake:* add a column — edit `packages/db/src/schema/agents.ts` to add `demoFlag: boolean('demo_flag').default(false)`, run `pnpm --filter @swiftagent/db db:generate` → emits e.g. `0003_add_demo_flag.sql` (`ALTER TABLE "agents" ADD COLUMN "demo_flag" boolean DEFAULT false;`) + snapshot; commit + deploy.
   - *Realization:* the column is unwanted. **Do NOT hand-write a down.**
   - *Forward fix:* remove `demoFlag` from `agents.ts`, run `pnpm --filter @swiftagent/db db:generate` again → emits a **new** `0004_drop_demo_flag.sql` (`ALTER TABLE "agents" DROP COLUMN "demo_flag";`) + updated snapshot; commit + deploy. The journal now has both `0003` and `0004`; the end-state matches the schema; `db:check` passes.
   - Note the two migrations are both forward and both committed — history is append-only, never rewritten.

8. **Local dry-run verification (see Tests).** Before opening the PR, run the drift guard commands locally against a throwaway Postgres to confirm the clean case exits `0`, and run the deliberately-drifted fixture to confirm it exits non-zero. Lint the workflow YAML.

## Tests

CI/infra changes are not unit-testable; verify them as follows.

1. **Local drift-guard dry-run — clean case (SC-04).** Start a throwaway Postgres (`docker run -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=swiftagent_ci -p 5432:5432 postgres:16-alpine`), export `DATABASE_URL`, then `pnpm --filter @swiftagent/db build && pnpm --filter @swiftagent/db migrate && pnpm --filter @swiftagent/db db:check`. Assert `db:check` exits `0` on the freshly-migrated DB. This mirrors the exact CI step.
2. **Deliberately-drifted DB fixture — dirty case (SC-04).** Against that same DB, apply an out-of-band DDL change that is **not** in any migration (e.g. `psql "$DATABASE_URL" -c 'ALTER TABLE agents ADD COLUMN drift_probe text;'`), then re-run `pnpm --filter @swiftagent/db db:check`. Assert it exits **non-zero** (proves the guard would fail the build). Drop the column afterward. (Equivalently: add a column to a `schema/*.ts` file **without** running `db:generate`, build, migrate a clean DB, and confirm `db:check` reports the uncaptured change.)
3. **Workflow lint.** Validate `ci.yml` and the three `deploy-*.yml` with `actionlint` (or `yamllint`) so the new `services: postgres` block, the drift-guard step, and the normalized `containerOverrides` command parse correctly. Confirm the `postgres` service has a health check and the `DATABASE_URL` in the guard step points at it.
4. **Deploy command parity (SC-05).** Diff the `containerOverrides.command` across `deploy-dev.yml`, `deploy-staging.yml`, `deploy-prod.yml` and assert all three are byte-identical and match the path that resolves inside `apps/server/Dockerfile`'s workdir. Confirm no drift logic was duplicated into the workflow (the migrator preflight + existing `exitCode` check are the gate).
5. **Preflight-on-deploy simulation (SC-05).** Locally, against a drifted DB (from test 2), run `node packages/db/dist/migrate.js` (the deployed command) and assert it **refuses** (non-zero, DB unmodified) — proving the deployed task inherits WS-26's preflight. Then re-run with `MIGRATE_SKIP_DRIFT_CHECK=1` and assert it applies — proving the override works.
6. **Runbook worked-example walkthrough (SC-06).** Follow the runbook's forward-fix example end-to-end on a throwaway DB: add `demo_flag` via `db:generate` + migrate, then generate the follow-up drop migration + migrate, and assert the final `db:check` exits `0` and `information_schema.columns` shows no `demo_flag` on `agents`. This proves the runbook's central procedure actually works. **Revert the throwaway schema edits and generated migrations** — they are a manual validation, not committed artifacts.

## Acceptance Criteria

1. CI's `integration-tests` job has a **dedicated `postgres` service** and a **"Schema drift guard"** step that runs `pnpm --filter @swiftagent/db migrate` then `pnpm --filter @swiftagent/db db:check` against it (after `pnpm build`); a non-zero `db:check` fails the build (SC-04). The step carries a comment explaining why a failure is always a real authoring mistake (uncaptured schema change), so it is never silenced.
2. The drift guard is verified false-positive-safe: a freshly-migrated DB passes (`db:check` exits `0`), and a deliberately-drifted DB fails (`db:check` exits non-zero) — both demonstrated by the local dry-run and the drifted fixture.
3. All three deploy workflows (`deploy-dev.yml`, `deploy-staging.yml`, `deploy-prod.yml`) run the **same** `node <migrate.js>` command in their ECS migrate step, with the path corrected to what resolves inside `apps/server/Dockerfile`'s workdir; the deployed task thereby runs the identical migrator + WS-26 drift preflight as local/CI, and a drift-refusal (non-zero migrate exit) fails the deploy (SC-05).
4. The `MIGRATE_SKIP_DRIFT_CHECK` override is available for the reconciliation path — either wired as an optional, default-unset ECS task-definition env in Terraform, or documented as a per-invocation `containerOverrides.environment` entry — and is **not** added to the server's validated `ENV_KEYS`.
5. `docs/runbooks/migrations.md` exists and covers: (a) forward-fix schema rollback via `db:generate` with an explicit "NO down-migrations" statement; (b) snapshot/restore data rollback referencing the pre-deploy RDS snapshot; (c) operator-driven deployed-drift reconciliation including exactly when/how to use `MIGRATE_SKIP_DRIFT_CHECK` and to re-verify with the override off; and (d) a **worked forward-fix example** (add a column, then drop it via a follow-up generated migration) that has been walked through end-to-end on a throwaway DB (SC-06).
6. No down-migration mechanism is introduced anywhere, and no automated reconciliation tooling is added — rollback is documented, reconciliation is operator-driven (both explicit program decisions).
7. `db:status` / `db:check` / `migrate` are **consumed, not authored** here; the spec's wiring is confirmed against the WS-26-provided scripts (if `db:check` is absent, WS-27 does not proceed).
8. Workflow YAML lints clean (`actionlint`/`yamllint`); the change stays S-sized (`ci.yml`, the three deploy workflows, `docs/runbooks/migrations.md`, and at most the optional Terraform env var).
