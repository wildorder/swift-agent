# Swift Agent — Program Plan (Persistence & Observability Reliability)

## Program Overview

**Product:** Swift Agent — a hosted real-time agent runtime that lets developers embed streaming, tool-calling, multi-model AI agents into any application.

**Program scope:** Make database evolution and run/trace observability production-safe. The `core-runtime-completion` program already delivered a greenfield migration baseline, wired the tracer into the runtime loop, and shipped atomic trace/span persistence plus trace-retrieval APIs. This program hardens the *operational* edges around those foundations: reliable migration status/drift detection, a CI schema-drift guard, a documented rollback and deployed-schema reconciliation runbook, a run-history/metrics retrieval API over already-persisted spans, and the migration + observability integration coverage that proves all of it.

---

## Strategic Goals

1. **Detectable schema drift** — Make divergence between the migration journal and any database (local, CI, test, deployed) observable through a command and enforced in CI.
2. **Safe, documented evolution** — Guarantee migrations only apply against a consistent database, and give operators a proven forward-fix + snapshot/restore rollback and reconciliation runbook.
3. **Queryable run history** — Surface the already-persisted model/tool/error spans as run-level metrics (token usage, latency, tool counts) through a retrieval API.
4. **Reliable trace persistence** — Ensure trace writes cannot be silently lost and that span payloads are bounded.
5. **Proven end-to-end** — Cover migration application, drift detection, span persistence, and metrics retrieval with integration tests against Testcontainers PostgreSQL.

---

## Architecture Changes

The system already contains a greenfield Drizzle baseline (`0000_baseline` + `0001`/`0002`), a forward `migrate` command, a tracer wired into `runAgentLoop`, atomic `saveTraceWithSpans` persistence, and `GET /v1/runs/:runId/trace` + `GET /v1/traces/:traceId/spans`. This program adds operational reliability around those parts; it does not change the runtime loop or the trace schema.

### 1. Migration Status & Drift Detection

`packages/db` gains a status/drift capability layered on the existing migrator:

- **`migrate status`** — reports applied vs. pending migrations by comparing the Drizzle journal (`_journal.json`) against the `__drizzle_migrations` bookkeeping table in the target database.
- **Drift check** — detects a database whose live schema diverges from what the journal implies (e.g. a hand-applied or missing DDL), using Drizzle introspection. Exits non-zero on drift, zero on a clean match.
- **Preflight guard** — `migrate` refuses to apply when drift is detected, so a divergent database is never partially migrated on top of.

No new dependency: the check uses `drizzle-kit` introspection and the migrations bookkeeping table already maintained by the postgres-js migrator.

### 2. CI Drift Guard & Deployed Alignment

The drift check runs as a CI step so a schema change that is not expressed as a generated migration fails the build. The deployed ECS migration task is aligned to run the same migrator and status gate as local and CI, so all four environments (local, CI, test, deployed) converge on one code path. Reconciliation of an already-drifted deployed environment stays operator-driven (see the runbook), not automated.

### 3. Rollback & Reconciliation Runbook

Because Drizzle is forward-only, rollback is documented rather than a `down` command:

- **Schema rollback** = a forward "fix" migration (`db:generate`-produced) that reverses the unwanted change.
- **Data rollback** = database snapshot/restore.
- **Drift reconciliation** = a documented procedure to bring a diverged deployed schema back onto the journal baseline.

The runbook lives under `docs/runbooks/` and is validated against a worked forward-fix example.

### 4. Run History & Metrics Retrieval API

The existing `deriveRunMetrics` (currently unwired) is connected to a retrieval endpoint:

- **`GET /v1/runs/:runId/metrics`** — returns token usage, total and per-phase latency, and model/tool span counts derived from the run's persisted trace + spans, under the same workspace-ownership enforcement as the other run routes. `404` when the run (or its trace) is not visible to the caller's workspace.

No new persistence: metrics are computed from the trace/span rows and the run's `token_usage`.

### 5. Trace-Persistence Hardening

- Trace-write failures in the loop's best-effort finalization are **surfaced via structured logging** (with run/trace ids) instead of being silently swallowed, so lost run history is observable.
- Span metadata and error payloads are **bounded** before persistence so a pathological tool error or large metadata blob cannot bloat the trace tables.

### 6. Migration & Observability Integration Tests

New suites under the root `test/integration/` tree exercise: baseline application from an empty database, ordered incremental application, idempotent re-run, drift detection against an injected divergence, model/tool/error span persistence through a real run, the metrics endpoint's roll-ups, and failure-path trace finalization.

---

## Technology Choices

No new technology — uses the existing TypeScript, Drizzle ORM / drizzle-kit, postgres.js, Fastify, Zod, Vitest, and Testcontainers stack. Drift detection reuses `drizzle-kit` introspection and the migrator's `__drizzle_migrations` table; no new runtime dependency is introduced.

---

## Workstreams

| ID | Workstream | Dependencies | Estimated Effort |
|----|-----------|--------------|-----------------|
| WS-26 | Migration Status & Drift-Detection Command | core-runtime-completion baseline | M |
| WS-27 | CI Drift Guard, Deploy Alignment & Rollback Runbook | WS-26 | S |
| WS-28 | Run History & Metrics API + Trace-Persistence Hardening | core-runtime-completion (tracer/trace repo) | M |
| WS-29 | Migration & Observability Integration Tests | WS-26, WS-28 | M |

**Size key:** S = 1-2 days, M = 3-5 days, L = 5-10 days

### Workstream Details

**WS-26 — Migration Status & Drift-Detection Command**

Add a `migrate status` reporter (journal vs. `__drizzle_migrations`) and a drift check (journal-implied schema vs. live introspection) to `packages/db`, plus a preflight in `migrate.ts` that refuses to apply on drift. Expose `db:status` / `db:check` package scripts. Unit-test the status/drift logic against fixture journals. Touches `packages/db`.

**WS-27 — CI Drift Guard, Deploy Alignment & Rollback Runbook**

Wire the drift check into `.github/workflows/ci.yml` so drift fails the build, align the ECS migration task / deploy workflow to run the same migrator + status gate, and author the forward-fix + snapshot/restore rollback and deployed-drift reconciliation runbook under `docs/runbooks/`, validated with a worked forward-fix example. Touches `.github/workflows`, `infra/` (ECS migrate task), `docs/runbooks`, and `packages/db` (scripts).

**WS-28 — Run History & Metrics API + Trace-Persistence Hardening**

Wire `deriveRunMetrics` into a `SessionService`/route path exposing `GET /v1/runs/:runId/metrics` with workspace-ownership enforcement, computing roll-ups from persisted trace/spans + run token usage. Surface swallowed trace-write failures via structured logging and bound span metadata/error payloads before persistence. Touches `packages/observability`, `packages/api`, `packages/db`, and `apps/server`.

**WS-29 — Migration & Observability Integration Tests**

Add root-tree integration suites: migration baseline-from-empty, ordered incremental application, idempotent re-run, and drift detection against an injected divergence; plus model/tool/error span persistence through a real run, the metrics endpoint's roll-ups, and failure-path trace finalization. Uses Testcontainers PostgreSQL, the real migrator, deterministic fake providers, and existing `test/support/` helpers. Touches the root `test/integration/` tree and `test/support/`.

---

## Dependency Graph

```text
core-runtime-completion (baseline + tracer + trace repo)
        │
        ├──────────────────────────────┐
        ▼                               ▼
WS-26 Migration Status/Drift      WS-28 Metrics API + Hardening
        │                               │
        ▼                               │
WS-27 CI Guard + Deploy + Runbook       │
        │                               │
        └──────────────┬────────────────┘
                        ▼
        WS-29 Migration & Observability Integration Tests
```

WS-26 and WS-28 are independent and can run in parallel after the existing baseline. WS-27 follows WS-26. WS-29 needs the drift command (WS-26) and the metrics API (WS-28); it does not depend on WS-27's CI/deploy wiring.

---

## Critical Path

**WS-26 → WS-29** (with WS-28 in parallel feeding WS-29).

Minimum timeline: approximately 8-13 working days. WS-27 runs alongside WS-28 off the WS-26 completion and is not on the test-blocking path.

---

## Scope (In)

- `migrate status` reporting applied vs. pending migrations
- Schema drift detection (journal-implied vs. live introspection)
- Migration preflight that refuses to apply on drift
- CI schema-drift guard
- Deployed ECS migrate-task alignment to the shared migrator + status gate
- Forward-fix + snapshot/restore rollback runbook
- Deployed-drift reconciliation procedure
- `GET /v1/runs/:runId/metrics` over persisted trace/spans + token usage
- Structured logging of trace-write failures
- Bounded span metadata / error payloads
- Migration integration tests (baseline, incrementals, idempotency, drift)
- Observability integration tests (span persistence, metrics, failure-path)

## Scope (Out)

- Down/reverse migration commands (rollback is forward-fix + restore)
- Automated reconciliation of a drifted deployed schema
- At-least-once / retry / dead-letter trace persistence
- New trace or span schema fields
- Streaming or push delivery of metrics
- Cost/pricing computation beyond token counts
- Changes to the runtime loop, providers, or executor resolution
- Durable execution / run recovery across restarts (Phase 2)
- Public gateway load-balancer routing
- Summary-memory implementation

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Drift check produces false positives on benign introspection differences | High | Normalize introspection output; test against the real baseline so a clean DB always passes; scope comparison to structural DDL |
| Preflight guard blocks a legitimate deploy | Medium | Provide an explicit, logged override path and document it in the runbook |
| Deployed schema already diverged before the guard exists | Medium | Ship the reconciliation runbook in the same program; guard detects but does not auto-mutate production |
| Metrics roll-ups disagree with persisted spans | Medium | Derive solely from persisted rows; assert equality in integration tests |
| Bounding span payloads truncates diagnostically useful errors | Low | Bound generously and record a truncation marker rather than dropping |
| CI drift step flakes on Testcontainers startup | Low | Reuse the existing integration harness and health-gated container startup |

---

## Success Criteria

- **SC-01:** `migrate status` accurately reports applied and pending migrations by comparing the journal against the database's migration bookkeeping.
- **SC-02:** The drift check exits non-zero for a database whose live schema diverges from the journal baseline and zero for a clean match.
- **SC-03:** `migrate` refuses to apply when drift is detected, leaving the database unmodified.
- **SC-04:** CI fails the build when schema drift is present.
- **SC-05:** The deployed ECS migration task runs the same migrator and status gate as local and CI.
- **SC-06:** A documented runbook covers forward-fix rollback, snapshot/restore, and deployed-drift reconciliation, validated against a worked forward-fix example.
- **SC-07:** `GET /v1/runs/:runId/metrics` returns token usage, latency, and model/tool span counts derived from the run's persisted trace and spans, under workspace-ownership enforcement.
- **SC-08:** A run's model, tool, and error spans are persisted and reflected in both the trace-retrieval and metrics responses.
- **SC-09:** Trace-write failures are surfaced through structured logging with run/trace identifiers, and span metadata/error payloads are bounded before persistence.
- **SC-10:** Migration integration tests cover baseline application from empty, ordered incremental application, idempotent re-run, and drift detection against an injected divergence.
- **SC-11:** Observability integration tests cover model/tool/error span persistence, metrics-endpoint roll-ups, and failure-path trace finalization.
- **SC-12:** Monorepo type-checking, linting, unit tests, and runtime integration tests pass.
