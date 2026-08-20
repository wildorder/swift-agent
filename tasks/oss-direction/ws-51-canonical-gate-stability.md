# WS-51: Canonical Verification Gate Stability

## Goal

Make the four configured verification commands — `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` — pass **deterministically** from a clean checkout, so every later workstream in the oss-direction program is judged against a gate that only goes red for real defects.

At baseline (2026-08-19) the gate is **flaky-red**: `pnpm build`, `pnpm typecheck`, and `pnpm lint` are green, but `pnpm test` intermittently fails in `apps/server/src/__tests__/index.test.ts`. That test `await import`s `../index.js`, which transitively evaluates the entire server module graph (`@swiftagent/api`, `@swiftagent/gateway`, `@swiftagent/db`, `@swiftagent/models`, `@swiftagent/runtime`, `@swiftagent/observability`, Fastify, Drizzle, `postgres`) inside a single `it()` block running under vitest's **5000ms default `testTimeout`**. In isolation the import takes ~2.5s; under `turbo run test`'s parallel fan-out (every package's `vitest run` competing for CPU) it intermittently exceeds 5000ms. It has been observed failing on one full `pnpm test` run and passing on the next with **no source change between them** (program doc, "Defect repaired (gate)"; manifest `constraints.canonicalGate`).

Three cohesive deliverables:

1. **Remove the timing margin** in `apps/server/src/__tests__/index.test.ts` so parallel turbo load can never push the import-graph evaluation past the test's time budget.
2. **Audit every other package test suite for the same shape** — a bare `await import()` of a heavy module graph inside a default-timeout test — and apply the same fix wherever found, not only to the one observed failure. (Evidence as of spec authoring: a repository-wide grep for `await import\(` across `**/*.test.ts` and `**/__tests__/**` matches **only** `apps/server/src/__tests__/index.test.ts:5`. The audit is still mandatory at implementation time — the tree may have moved — and must also catch the near-miss variant: any test whose runtime sits near the 5000ms default because of module-graph evaluation, even without a literal `await import()`.)
3. **Establish the fix as a convention** — a mechanical guardrail (a suite-level `testTimeout` with a doc comment stating why), not an ad-hoc magic number — so a newly added test in the same suite cannot silently reintroduce the flake.

Stability is then **demonstrated, not asserted**: repeated full-suite runs with the turbo cache bypassed (SC-17 explicitly rejects a single green run as proof). This is the first of SC-17's two proofs — the second is WS-49's program-final re-proof over the terminal tree, after `apps/playground` and `packages/create-swift-agent` exist.

This workstream changes **no** test assertion, **no** product code, **no** test-runner architecture. It is a timing-margin repair, an audit, and a demonstration protocol.

## Traceability

- **SC-17** — `pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm test` all pass deterministically from a clean checkout, with the apps/server index-export import-graph test no longer able to fail on a timing margin under parallel load; demonstrated by repeated cache-bypassed full-suite runs rather than a single green run. (WS-51 delivers the first of the two required proofs; WS-49 delivers the terminal-tree re-proof.)

## Dependencies

**None — WS-51 is the program root.** Every other workstream's checkpoint is judged on the gate this workstream stabilizes; it is a hard dependency of both otherwise-rootless workstreams (WS-43 and WS-44). Nothing in the repository blocks it.

Checkpoint rule (applies here and to every workstream in this program): all four commands — `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` — must be green at this workstream's checkpoint.

## Context Files (Agent MUST read before implementing)

- `C:\dev\swift-agent\CLAUDE.md` — conventions (forced verification; NO SEMANTIC SEARCH — grep every reference category when touching a name; report, don't absorb, product defects).
- `C:\dev\swift-agent\docs\programs\oss-direction-manifest.json` — `constraints.canonicalGate`, `successCriteria[SC-17]`, and `workstreams[WS-51]` (scope includes/excludes are canonical there).
- `C:\dev\swift-agent\apps\server\src\__tests__\index.test.ts` — the flaky test: 12 lines, one `it()` with `await import('../index.js')` under the vitest default timeout.
- `C:\dev\swift-agent\apps\server\src\index.ts` — what the import pulls in: the barrel re-exporting `buildContainer`, `startServer`, `loadServerConfig`, `redactConfig`, `registerHealthCheck` (and therefore the whole app graph). Confirms the test's *purpose* is asserting the programmatic export surface stays intact — the dynamic-import-at-runtime shape is part of what it proves.
- `C:\dev\swift-agent\apps\server\src\main.ts` — the `isDirectRun` guard (lines 148–161): importing the module does NOT boot the server or open DB/Redis connections. The cost is pure module-graph evaluation, which is why the fix is a time budget, not a mock.
- `C:\dev\swift-agent\apps\server\vitest.config.ts` — the suite's config: `globals: true`, `environment: 'node'`, `passWithNoTests: true`, and **no `testTimeout`** — so the 5000ms vitest default governs. This is where the suite-level fix lands.
- `C:\dev\swift-agent\apps\server\package.json` — `"test": "vitest run"`; the suite turbo fans out to.
- `C:\dev\swift-agent\turbo.json` — `test` depends on `build` and is cached; `pnpm test` = `turbo run test` runs every package's suite in parallel, which is the load source. The stability proof must bypass this cache (`--force`).
- `C:\dev\swift-agent\package.json` — root scripts: `"test": "turbo run test"`; also `test:integration` / `test:acceptance`, which run under **separate** configs and are NOT part of the configured gate (see exclusions).
- `C:\dev\swift-agent\test\vitest.integration.config.ts` — evidence the excluded integration tree already carries its own raised `testTimeout: 30000`; do not touch it, but it is precedent for the suite-level-timeout convention.
- The other package vitest configs (`packages/{shared,db,models,runtime,gateway,api,observability,sdk,react}/vitest.config.ts`, `examples/quickstart/backend/vitest.config.ts`) — the audit surface: same minimal shape as apps/server's, no `testTimeout` anywhere.

## Package

`apps/server` (per the manifest). Other packages' test files/configs are **read** during the audit; they are modified only if the audit actually finds the same shape there — expected to be none per the authoring-time grep.

## Files Touched

- `apps/server/vitest.config.ts` **(MODIFY)** — add a suite-level `testTimeout` (30_000, matching the integration config's precedent) with a doc comment naming the convention: any test in this suite that evaluates the full server module graph gets its budget from here, not from the vitest default; the number exists because parallel turbo load inflates module evaluation, and new tests must not undercut it with per-test timeouts.
- `apps/server/src/__tests__/index.test.ts` **(MODIFY — comment only)** — add a short comment above the `await import` stating why the suite-level timeout exists (module-graph evaluation ~2.5s in isolation, unbounded under parallel turbo load) so a future reader does not "simplify" the config back to the default. **The assertions are byte-for-byte unchanged.**
- Other package test files / vitest configs **(MODIFY only if the audit finds the same shape)** — apply the identical convention (suite-level `testTimeout` + comment). Do not touch configs whose suites the audit clears.

No product source file changes. No new files.

## Existing Interfaces to Consume

**The flaky test — the complete file** (`apps/server/src/__tests__/index.test.ts`):

```typescript
import { describe, it, expect } from 'vitest';

describe('index exports', () => {
  it('exports buildContainer and startServer for programmatic use', async () => {
    const mod = await import('../index.js');
    expect(typeof mod.buildContainer).toBe('function');
    expect(typeof mod.startServer).toBe('function');
    expect(typeof mod.loadServerConfig).toBe('function');
    expect(typeof mod.redactConfig).toBe('function');
    expect(typeof mod.registerHealthCheck).toBe('function');
  });
});
```

**The governing config — no timeout configured, so the 5000ms default applies** (`apps/server/vitest.config.ts`):

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    passWithNoTests: true,
  },
});
```

**The parallel fan-out that supplies the load** (`turbo.json`):

```json
{
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", "tsconfig.tsbuildinfo"] },
    "typecheck": { "dependsOn": ["^build"] },
    "test": { "dependsOn": ["build"] },
    "lint": {}
  }
}
```

**The import-does-not-boot guard that makes this purely a timing problem** (`apps/server/src/main.ts:148-161`):

```typescript
// Only bootstrap when this module is the process entry (`node dist/main.js`).
// Guarding this prevents a plain `import` (e.g. `index.ts` re-exporting
// `startServer` for programmatic use, or tests) from booting the whole server
// and attempting real DB/Redis connections.
const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  startServer().catch((err) => { /* ... */ });
}
```

**Precedent for the suite-level-timeout convention** (`test/vitest.integration.config.ts:9`, an excluded tree — read-only):

```typescript
testTimeout: 30000,
```

## Design Notes

- **Why a raised suite-level `testTimeout`, not the other two convention options.** The manifest permits three shapes: an explicit per-test timeout, a hoisted static import, or a raised suite-level `testTimeout`. Choose the suite-level timeout:
  - A **hoisted static import** would remove the timing margin entirely (module evaluation happens at collection, outside any test budget), but it changes what the test exercises — the dynamic-import-at-runtime path is the programmatic-consumer shape the test exists to prove, and the exclusion list forbids changing what a test asserts; keeping the dynamic import is the conservative reading.
  - A **per-test timeout** (`it('...', { timeout: 30_000 }, ...)`) fixes only this test; the next heavy test added to the suite reintroduces the flake. The convention requirement ("so new tests do not reintroduce the flake") points at the config level.
  - The **suite-level `testTimeout: 30_000`** matches the repository's own precedent (`test/vitest.integration.config.ts`), is mechanical (covers future tests in the suite automatically), and costs nothing on the happy path — vitest timeouts are ceilings, not sleeps; green runs get no slower.
- **Why 30_000 and not a "measured" number.** The failure mode is unbounded contention (N vitest workers × module-graph evaluation on a loaded CI box), so no margin derived from the ~2.5s isolated measurement is defensible. 30s is the value the repository already uses for its container-backed integration suite and is far above any plausible module-evaluation time while still bounding a genuine hang (an accidental real DB connection would still fail, loudly, within the run).
- **The audit is two greps plus a judgment pass, not one grep** (CLAUDE.md rule 10 — no semantic search):
  1. `await import\(` across `**/*.test.ts` and separately across `**/__tests__/**` (catches non-`.test.ts` helpers evaluated by tests);
  2. dynamic `import(` without `await` (a returned promise `expect(...).resolves` shape would hit the same timeout);
  3. a judgment pass over each package's heaviest static-import test — a test file whose top-of-file static imports pull an app-scale graph is evaluated at collection (not under `testTimeout`), so static imports are NOT the flake shape; do not "fix" them. Record the audit's findings (files checked, matches, dispositions) in the PR description.
- **Genuine defects found while auditing are reported, not absorbed.** If the audit turns up a real server/SDK bug (e.g. a module with import-time side effects that SHOULD be guarded like `main.ts`'s `isDirectRun`), file/report it and leave it — fixing product defects is explicitly excluded from this workstream.
- **The stability proof bypasses the turbo cache.** `turbo.json` caches `test` outputs; a repeat of `pnpm test` after one green run replays cache hits and proves nothing about timing. Every proof run must use `pnpm exec turbo run test --force` (and the one-time `--force` variants of build/typecheck where caching applies) so each run genuinely re-executes every suite in parallel — the exact load profile that produced the flake.
- **What "deterministic" does NOT require here.** The gate excludes the root `test/` tree: `pnpm test:integration` (Testcontainers) and `pnpm test:acceptance` run under their own configs and are known-flaky-by-environment (see project memory: `rest-ws-parity` WS-frame timeout under full parallel load). They are out of scope and must not be touched or gated on.
- **No parallelism retuning.** Do not add `--concurrency` flags, vitest `poolOptions`, `fileParallelism` changes, or turbo concurrency limits. The manifest excludes retuning beyond what removing the margin requires — the margin removal is the timeout, full stop. Slowing the whole gate down to mask the margin would be the wrong fix even if it worked.

## Implementation Steps

1. **Reproduce or bound the baseline (best effort, timeboxed).** Run `pnpm exec turbo run test --force` two or three times and note whether the index-test flake reproduces on this machine. Reproduction is NOT required to proceed — the failure is load-dependent and documented in the manifest — but a captured failing log strengthens the PR narrative.
2. **Apply the suite-level fix (`apps/server/vitest.config.ts`).** Add `testTimeout: 30_000` under `test:`, with a doc comment:
   ```typescript
   export default defineConfig({
     test: {
       globals: true,
       environment: 'node',
       passWithNoTests: true,
       // WS-51 (SC-17): index.test.ts dynamically imports ../index.js, which
       // evaluates the full server module graph (~2.5s in isolation, unbounded
       // under `turbo run test` parallel load). The vitest 5000ms default made
       // the gate flaky-red. Suite-level so future heavy tests inherit the
       // budget — do not remove or undercut with per-test timeouts.
       testTimeout: 30_000,
     },
   });
   ```
3. **Annotate the test (`apps/server/src/__tests__/index.test.ts`).** Add a comment above the `await import` referencing the config's timeout rationale. Change nothing else — imports, `describe`/`it` names, and all five `expect` lines stay identical.
4. **Run the audit.** Execute the greps and the judgment pass from Design Notes across every workspace package's test files (`packages/*`, `apps/*`, `examples/*` — NOT the root `test/` tree). For each match, classify: (a) same shape → apply the identical convention in that package's vitest config with the same comment; (b) benign (small module graph, already-raised timeout) → record as cleared; (c) genuine product defect → report, do not fix. As of authoring the expected result is zero additional matches; verify rather than assume.
5. **Run the four gate commands once, cache-bypassed where applicable:** `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm exec turbo run test --force`. Fix any failure introduced by the edits (there should be none — config and comments only).
6. **Execute the stability demonstration.** Run `pnpm exec turbo run test --force` at least **5 consecutive times**, back to back (so runs overlap the OS's normal background load). All 5 must be green. If ANY run fails: diagnose — if it is the index-test margin, the fix is wrong (step 2 missed the governing config); if it is a different, genuinely flaky test, that is a new audit finding — loop back to step 4 for it; if it is a real product defect, report it and state clearly that the gate's determinism claim is blocked on that report. Record all run outcomes (pass/fail + duration) in the PR description.
7. **Grep-verify the convention landed everywhere intended** (NO SEMANTIC SEARCH): search `testTimeout` across `**/vitest.config.ts` and confirm exactly the audited-and-fixed set carries it; search `await import(` in test files once more to confirm no instance remains outside a raised-timeout suite.

## Tests

This workstream adds no new test files — its deliverable is that the existing suite becomes deterministic. Verification is the demonstration protocol:

1. **Unchanged assertions (guard against scope creep).** `git diff` for `apps/server/src/__tests__/index.test.ts` shows comment-only changes: no `expect` line, test name, or import statement modified. Same check for any file the audit touched.
2. **Single-suite check.** `pnpm --filter @swiftagent/server test` passes, and the index test's reported duration is well under the new 30s budget.
3. **Repeated cache-bypassed full-suite runs (SC-17).** ≥5 consecutive `pnpm exec turbo run test --force` runs, all green, outcomes recorded. A turbo cache-hit run does not count toward the 5.
4. **Full gate.** `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` all green at checkpoint.
5. **Negative scope check.** `git status` shows no modification under root `test/` (integration/acceptance/smoke trees) and no product source change.

## Acceptance Criteria

1. `apps/server`'s vitest suite carries a suite-level `testTimeout` (30_000) with a doc comment naming the import-graph/parallel-load rationale, so the index-export test can no longer fail on a timing margin under parallel turbo load (SC-17).
2. `apps/server/src/__tests__/index.test.ts` still performs the dynamic `await import('../index.js')` and its five export assertions are unchanged — no assertion weakened, no test skipped, quarantined, or marked expected-to-fail (SC-17; scope excludes).
3. The repository-wide audit for the same shape (bare `await import()` of a heavy module graph in a default-timeout test, plus the un-awaited dynamic-import variant) has been executed across all workspace packages, with findings and dispositions recorded; every confirmed instance carries the same convention (SC-17).
4. The convention is mechanical and documented at the config level (suite-level timeout + comment), not an ad-hoc per-test number, so newly added tests in the affected suites inherit the budget (SC-17).
5. Stability is demonstrated by at least 5 consecutive green runs of the full test suite with the turbo cache bypassed (`turbo run test --force`), recorded in the PR — not by a single green run (SC-17).
6. No vitest workspace restructuring, runner replacement, or parallelism/concurrency retuning was performed; the root `test/` integration tree (which runs separately via `pnpm test:integration` under Testcontainers) is untouched (scope excludes).
7. Any genuine product defect discovered during the audit is reported in the PR/issue tracker rather than fixed or silently absorbed in this workstream (scope excludes).
8. `pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm test` are all green at checkpoint (program-wide checkpoint rule; SC-17).
