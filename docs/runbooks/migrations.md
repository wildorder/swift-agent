# Runbook: Database Migrations, Rollback & Drift Reconciliation

This runbook covers how schema changes flow to every environment, how to inspect
migration state, and how to recover when something goes wrong. It is the operator
reference for the drift guard (CI) and the drift-aware `migrate` preflight (deploy)
delivered across WS-26 / WS-27.

---

## 1. Overview & principles

- **Migrations are forward-only.** Drizzle has no `down` migration, and this repo
  **does not implement one**. There are no down-migrations anywhere in the codebase
  and none will be added. A schema "rollback" is a **new forward migration** that
  reverses the unwanted change (see §3).
- **`migrate` is the single schema path.** Local, CI, and every deployed environment
  apply schema changes exactly one way: `node packages/db/dist/migrate.js` (exposed as
  `pnpm --filter @swiftagent/db migrate`). `push` is not used. The deploy workflows run
  this identical command via `aws ecs run-task` containerOverrides.
- **Drift is detected in two places, by the same logic:**
  - **CI** — the `integration-tests` job's **Schema drift guard** step applies the
    committed migrations to a clean Postgres and runs `db:check` (§2). A non-zero exit
    fails the build.
  - **Deploy** — `migrate` runs a **drift preflight** before applying anything: it
    compares the live schema against the last-applied migration's snapshot and
    **refuses to apply on divergence** (exit non-zero, DB untouched). The deploy
    workflows already fail on a non-zero migrate exit, so a drifted deployed DB blocks
    the deploy automatically.
- **The preflight has one escape hatch: `MIGRATE_SKIP_DRIFT_CHECK=1`.** It is used
  **only** for the operator-driven reconciliation procedure (§5), set **per-invocation**,
  and **never left enabled**. It is a migrate-CLI flag — it is intentionally **not** part
  of the server's validated `ENV_KEYS`, because the running server never migrates.
- **Reconciliation is operator-driven, never automated.** The guard/preflight *detects*
  drift; nothing in this system *mutates* a deployed database to fix it. §5 is the human
  procedure.

---

## 2. Inspecting state

Both commands are in `packages/db` and require a built `dist/` (`pnpm --filter
@swiftagent/db build`) and `DATABASE_URL` pointing at the target DB.

| Command | Answers | Exit codes |
|---|---|---|
| `pnpm --filter @swiftagent/db db:status` | Which migrations are **applied** vs **pending** | `0` |
| `pnpm --filter @swiftagent/db db:check` | Is the live schema **drifted** from the journal-implied schema? | `0` clean · `1` drift · `2` tool error |

### Against a local / throwaway DB

```bash
export DATABASE_URL='postgres://postgres:postgres@localhost:5432/swiftagent_ci'
pnpm --filter @swiftagent/db build
pnpm --filter @swiftagent/db db:status
pnpm --filter @swiftagent/db db:check
```

### Against a deployed DB

The deployed database is not publicly reachable. Run the commands **inside the ECS
task** (which already has `DATABASE_URL` injected from SSM) via a one-off RunTask
command override, or from a bastion / SSM session with `DATABASE_URL` exported:

```bash
# db:status inside the deployed container (dev shown; swap cluster/service per env)
aws ecs run-task \
  --cluster dev-swiftagent \
  --task-definition "$TASK_DEF" \
  --launch-type FARGATE \
  --network-configuration "$NETWORK_CONFIG" \
  --overrides '{"containerOverrides":[{"name":"dev-swiftagent","command":["node","packages/db/dist/cli/status.js"]}]}'
```

(`TASK_DEF` / `NETWORK_CONFIG` are discovered exactly as the deploy workflow's
"Run database migration" step does — `aws ecs describe-services`.)

---

## 3. Schema rollback = forward-fix (NO down-migrations)

**There is no `down`.** To reverse an unwanted schema change, author a **new forward
migration** that expresses the desired end-state, then deploy it.

Procedure:

1. Edit `packages/db/src/schema/*.ts` to the **desired end-state** (i.e. undo the
   unwanted change in the schema source).
2. `pnpm --filter @swiftagent/db db:generate` — emits a new `000N_*.sql` plus the
   updated snapshot under `packages/db/drizzle/meta/`.
3. **Review the emitted `000N_*.sql`** to confirm it does exactly (and only) what you
   intend.
4. Commit **all** generated artifacts together: the `000N_*.sql`, the snapshot, and the
   updated `_journal.json`.
5. Deploy. The migrate task applies the new migration; `db:check` then passes because
   the live schema matches the journal again.

History is **append-only** — you never edit or delete a committed migration to "undo"
it; you add another one in front of it. See the worked example in §6.

> ⚠️ Destructive DDL (dropping a column/table, narrowing a type) **loses data**. A
> forward-fix that drops a column cannot bring the data back. If the data matters, treat
> it as a **data rollback** (§4) instead of / in addition to the forward-fix.

---

## 4. Data rollback = snapshot / restore

Forward-fixes reverse *schema*, not *data*. For data loss or a destructive DDL that must
be undone, restore from the **pre-migration RDS snapshot**.

- `deploy-prod.yml` creates a snapshot **before** every migration:
  `swiftagent-prod-pre-deploy-<timestamp>` (step **"Create pre-migration RDS snapshot"**),
  and waits for it to be available before migrating.
- Restore it with the procedure documented in `infra/migrate.sh`'s rollback comments:

  ```bash
  aws rds restore-db-instance-from-db-snapshot \
    --db-instance-identifier <new-or-target-instance> \
    --db-snapshot-identifier swiftagent-prod-pre-deploy-<timestamp>
  ```

  Then, if the restore lands on a new instance, update the environment's `DATABASE_URL`
  SSM parameter and roll the ECS service, or restore in place per your RDS policy.

Use restore for **data / destructive-DDL recovery**. Ordinary unwanted *schema* changes
use the forward-fix in §3 — do not restore a whole database to drop a stray column.

---

## 5. Deployed-drift reconciliation (operator-driven)

When the deployed schema has **diverged** from the journal, the `migrate` preflight
refuses to apply and the deploy fails (and CI's guard is red for the same reason). Drift
means the live DB no longer matches the snapshot of its last-applied migration — usually
a hand-applied hotfix DDL, or a partially-applied migration.

**Reconcile by hand — the system will not do it for you:**

1. **Diagnose.** With `DATABASE_URL` pointed at the deployed DB (§2):
   - `db:status` — what is applied vs pending?
   - `db:check` — confirm drift and read the summary of what differs.
2. **Decide the direction:**
   - **Forward onto the journal** — if the divergence is benign/expected (e.g. a manual
     column that should become permanent): author a forward-fix migration (§3) that
     expresses the missing DDL so the journal matches reality, commit it, then apply.
   - **Restore from snapshot** — if the divergence is unwanted data/DDL: restore (§4)
     back to a known-good baseline, then redeploy normally.
3. **If forward-fixing requires applying migrations on top of a still-diverged DB**, the
   preflight will block. Bypass it **for that single reconciliation RunTask only** by
   setting `MIGRATE_SKIP_DRIFT_CHECK=1`:

   ```bash
   aws ecs run-task \
     --cluster prod-swiftagent \
     --task-definition "$TASK_DEF" \
     --launch-type FARGATE \
     --network-configuration "$NETWORK_CONFIG" \
     --overrides '{
       "containerOverrides": [
         {
           "name": "prod-swiftagent",
           "command": ["node", "packages/db/dist/migrate.js"],
           "environment": [
             { "name": "MIGRATE_SKIP_DRIFT_CHECK", "value": "1" }
           ]
         }
       ]
     }'
   ```

4. **Immediately re-verify with the override OFF.** Run `db:check` again (no
   `MIGRATE_SKIP_DRIFT_CHECK`) against the reconciled DB and confirm it exits `0` — the
   DB is back on baseline.
5. **Never leave the override enabled.** It is per-invocation only. Do not set it as a
   standing task-definition env, and do not commit any Terraform that leaves
   `migrate_skip_drift_check` non-empty.

> The ECS task definition exposes an optional `migrate_skip_drift_check` Terraform
> variable (default `""`, so the env is **absent** normally). Prefer the per-invocation
> `containerOverrides.environment` entry above over flipping the Terraform var — it is
> self-limiting and leaves no residue in the task definition.

---

## 6. Worked example — forward-fix a mistaken column

This is a concrete, copy-pasteable walkthrough of §3. It has been validated end-to-end
on a throwaway Postgres; the schema edits and generated migrations below are **not**
committed to the repo — they are a manual validation only.

### Step 1 — the mistake: add a column

Edit `packages/db/src/schema/agents.ts` to add a boolean flag (note `boolean` must be
added to the `drizzle-orm/pg-core` import):

```ts
import { pgTable, text, timestamp, jsonb, index, uniqueIndex, boolean } from 'drizzle-orm/pg-core';

export const agents = pgTable('agents', {
  // ...existing columns...
  demoFlag: boolean('demo_flag').default(false),
});
```

Generate and commit:

```bash
pnpm --filter @swiftagent/db db:generate
# → emits packages/db/drizzle/0003_add_demo_flag.sql:
#     ALTER TABLE "agents" ADD COLUMN "demo_flag" boolean DEFAULT false;
#   + updated snapshot + _journal.json
```

Commit `0003_*.sql` + snapshot + `_journal.json`, then deploy. The migrate task applies
`0003`; `db:check` passes (schema matches journal).

### Step 2 — the realization: the column is unwanted

You decide `demo_flag` should never have shipped. **Do NOT hand-write a down migration
and do NOT edit or delete `0003`.**

### Step 3 — the forward fix: drop it via a NEW migration

Remove `demoFlag` from `agents.ts` (revert the edit from Step 1), then generate again:

```bash
pnpm --filter @swiftagent/db db:generate
# → emits packages/db/drizzle/0004_drop_demo_flag.sql:
#     ALTER TABLE "agents" DROP COLUMN "demo_flag";
#   + updated snapshot + _journal.json
```

Review `0004_*.sql`, commit it + snapshot + `_journal.json`, then deploy.

### Result

The journal now contains **both** `0003` (add) and `0004` (drop) — both forward, both
committed, history never rewritten. The end-state schema has no `demo_flag`, and
`db:check` exits `0`:

```bash
# on a throwaway DB after applying 0003 then 0004:
pnpm --filter @swiftagent/db migrate
pnpm --filter @swiftagent/db db:check           # exit 0
psql "$DATABASE_URL" -c "\d agents"             # no demo_flag column
```

This is the central procedure of this runbook: **every rollback is another forward
migration.**
