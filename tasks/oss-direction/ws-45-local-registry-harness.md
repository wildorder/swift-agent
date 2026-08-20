# WS-45: Local Package Consumption Harness

## Goal

Provide a **local npm registry** — a **real npm registry protocol endpoint (Verdaccio)**, explicitly NOT a directory of tarballs or `file:` dependencies, which do not satisfy SC-05 — so any consumer can install workspace packages as **real npm dependencies before anything is published**:

1. A Verdaccio registry **started and torn down by a committed script**, with ephemeral storage and no live-registry writes possible for `@swiftagent/*` or `create-swift-agent`.
2. The three packed packages (`@swiftagent/{sdk,react,shared}`) **published INTO it**, then **installed from it** into a throwaway consumer that imports and type-checks against the shipped `.d.ts` — reusing the registry-parameterized WS-44 install harness.
3. A **publish path general enough for ANY workspace package** — WS-46 later publishes `create-swift-agent` into this same registry and resolves it through **real `npx`** (SC-06), which only a registry-protocol endpoint supports. That requirement is load-bearing: it is why tarballs cannot substitute.
4. A **repeatable command wired into CI**, and documentation of the harness for scaffold and example verification.

The harness is **test-time only** — never a runtime or published dependency.

## Traceability

- **SC-05** — the harness is a real npm registry protocol endpoint (Verdaccio); it installs all three packages into a throwaway consumer that imports and type-checks against them; run as a repeatable command in CI.
- **(Enables SC-06)** — the general publish path and `npx`-capable registry are the substrate WS-46's `create-swift-agent` verification stands on; SC-06 itself is WS-46's to satisfy.

## Dependencies

- **WS-44 — Public Release Readiness (Gated).** Provides: (a) the public posture metadata this harness publishes — `access: public`, Apache-2.0, `registry.npmjs.org` `publishConfig` (overridden per-invocation with `--registry`, see Design Notes), and an `.npmrc` that no longer routes `@swiftagent:*` to GitHub Packages (which would otherwise hijack the consumer install); (b) the **registry-parameterized install harness** — `test/acceptance/install-published.ts` accepts `SWIFTAGENT_INSTALL_REGISTRY` and an opt-in gate `SWIFTAGENT_RUN_INSTALL_PROOF`, with auth optional — which this workstream points at the local endpoint instead of forking; (c) `scripts/verify-pack.mjs`'s updated assertions, confirming the tarballs this harness publishes are the release-correct artifacts.

## Context Files (Agent MUST read before implementing)

- `C:\dev\swift-agent\CLAUDE.md` — conventions; note the root `test/` tree is excluded from `pnpm typecheck`/`lint` and validated only by running its suites.
- `C:\dev\swift-agent\docs\programs\oss-direction-manifest.json` — `workstreams[WS-45]` includes/excludes; `successCriteria` SC-05 and SC-06; `technology.localRegistry` (Verdaccio, test-time only).
- `C:\dev\swift-agent\tasks\oss-direction\ws-44-public-release-readiness.md` — the harness parameterization contract this workstream consumes (`SWIFTAGENT_INSTALL_REGISTRY`, `SWIFTAGENT_RUN_INSTALL_PROOF`, optional auth).
- `C:\dev\swift-agent\test\acceptance\install-published.ts` — (post-WS-44) the consumer factory to reuse: throwaway dir outside the workspace, consumer `.npmrc` generation, bounded `npm install`, import assertion (`consumer-entry.mjs`), shipped-`.d.ts` typecheck (`consumer-check.ts` + `tsconfig`), loud logging of resolved versions.
- `C:\dev\swift-agent\test\acceptance\install-registry.acceptance.test.ts` — the opt-in gate + loud-skip pattern; this workstream flips the gate ON in its CI lane.
- `C:\dev\swift-agent\scripts\verify-pack.mjs` — the `pnpm pack`-based packing path and Windows `pnpm.cmd`/`shell: true` handling to mirror in the new script; the three-package roster shape.
- `C:\dev\swift-agent\package.json` — root scripts (`test:acceptance`, `test:acceptance:install` precedent) where the new harness command is registered; devDependencies where `verdaccio` is added.
- `C:\dev\swift-agent\.npmrc` — (post-WS-44) must contain NO `@swiftagent:registry` routing; the harness supplies registry routing per-invocation only.
- `C:\dev\swift-agent\.github\workflows\ci.yml` — job structure (`build-lint` → `unit-tests` → `integration-tests` → `acceptance-tests` → pack gate) into which the local-registry job is wired; the acceptance job's Docker/timeout posture.
- `C:\dev\swift-agent\docs\programs\oss-direction-program.md` — "New local registry harness" paragraph in Architecture Changes (the registry-protocol requirement's rationale).

## Package

`scripts`, `.github/workflows`, `test` (per the manifest's package list). The root `package.json` gains one devDependency (`verdaccio`) and one script entry. **No `docs/` change** — the harness documentation lives inside the `test` tree (see Files Touched), since `docs` is not in this workstream's package list.

## Files Touched

- `scripts/local-registry.mjs` **(NEW)** — the committed orchestrator: `start`, `stop`, `publish <package-dir>...`, and `verify` (full end-to-end) subcommands.
- `test/local-registry/verdaccio.yaml` **(NEW)** — the Verdaccio config (package rules, uplink, storage, auth — see Design Notes).
- `test/local-registry/README.md` **(NEW)** — harness documentation for scaffold (WS-46) and example verification.
- `package.json` **(MODIFY)** — add `verdaccio` to `devDependencies`; add script `"verify:local-registry": "node scripts/local-registry.mjs verify"`.
- `.github/workflows/ci.yml` **(MODIFY)** — a new `local-registry` job running `pnpm verify:local-registry` (needs `build-lint`; no Docker, no registry secrets).
- `test/acceptance/install-published.ts` **(MODIFY, only if a gap surfaces)** — the WS-44 parameterization should suffice; if the local flow needs a small extension (e.g. accepting a dummy-token env for Verdaccio), extend rather than fork, and keep the public-npm default behavior byte-compatible.

## Existing Interfaces to Consume

**The registry-parameterized consumer factory** (post-WS-44 `test/acceptance/install-published.ts`) — the WS-44 spec's contract:

```typescript
// Registry resolved from env, defaulting to public npm:
const REGISTRY = process.env['SWIFTAGENT_INSTALL_REGISTRY'] ?? 'https://registry.npmjs.org';
// Auth optional: the consumer .npmrc gets an _authToken line ONLY when
// NODE_AUTH_TOKEN is set. The registry-install proof runs only when
// SWIFTAGENT_RUN_INSTALL_PROOF=1.
export async function installPublishedPackages(): Promise<InstalledConsumer>; // throwaway dir + bounded npm install
export async function typecheckConsumer(consumerDir: string): Promise<void>;   // shipped-.d.ts typecheck
export async function importAndDrive(consumerDir: string, driveEnv?): Promise<void>; // ESM import + symbol assertions
```

**The packing path** (`scripts/verify-pack.mjs`) — reuse its roster and its Windows-safe spawn shape:

```javascript
const PACKAGES = [
  { name: '@swiftagent/sdk', dir: 'packages/sdk' },
  { name: '@swiftagent/react', dir: 'packages/react' },
  { name: '@swiftagent/shared', dir: 'packages/shared' },
];
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
// execFileSync(..., { shell: true }) — required for Windows .cmd shims.
```

**Verdaccio programmatic/CLI start** — `verdaccio --config test/local-registry/verdaccio.yaml --listen 127.0.0.1:<port>` (spawned as a child process by the orchestrator; Verdaccio 6.x, added as a root devDependency).

## Design Notes

- **A real registry protocol endpoint is the criterion, not a convenience.** SC-05 states it outright: "a directory of tarballs or `file:` dependencies does not satisfy this." The reason is WS-46: `npx create-swift-agent` must resolve through real npx against this registry, and npx speaks only the registry protocol. Every design decision below serves that: HTTP endpoint, standard publish/install verbs, scope-agnostic package rules.

- **Verdaccio configuration (`test/local-registry/verdaccio.yaml`).** Three properties are load-bearing:
  1. **No uplink for our packages.** Package rules for `@swiftagent/*` AND `create-swift-agent` (pre-provisioned for WS-46) declare `access: $all`, `publish: $all`, and **no `proxy`** — a lookup for our names must resolve locally or 404, never leak to `registry.npmjs.org` (where, pre-release, nothing exists — and post-release, the wrong artifact would mask a local-publish failure).
  2. **An npmjs uplink for everything else** (`'**': { access: $all, proxy: npmjs }`) so the throwaway consumer's `typescript` devDependency — and, for WS-46, a generated project's full dependency tree — installs through the same single registry endpoint. This is what lets `npx --registry <local>` work wholesale.
  3. **Ephemeral, permissive, loopback-only.** Storage in a fresh temp dir per run (wiped on teardown); listen on `127.0.0.1` on a configurable port (default 4873, overridable via `SWIFTAGENT_LOCAL_REGISTRY_PORT` to dodge collisions); auth relaxed for test use (`max_users: -1` with publish open to `$all`, plus a dummy `_authToken` written by the orchestrator into the publish-side npmrc, since npm clients insist on a token for `publish` even when the server does not verify it). Loopback binding is the security boundary — document that this registry must never be exposed beyond localhost/CI.

- **The orchestrator (`scripts/local-registry.mjs`).** Subcommands:
  - `start` — spawn Verdaccio with the committed config, temp storage dir, chosen port; poll `GET http://127.0.0.1:<port>/-/ping` until ready (bounded, ~30s); write a state file (PID + port + storage dir) into the temp area.
  - `stop` — kill the child, delete the storage dir; idempotent (safe when nothing is running).
  - `publish <package-dir>...` — for each dir: run `pnpm publish --registry http://127.0.0.1:<port> --no-git-checks` from that directory (pnpm, so `workspace:*` is rewritten exactly as the real release will rewrite it). **This is the generality requirement:** the subcommand takes ANY workspace package directory — WS-46 will call it with `packages/create-swift-agent` — and must not hard-code the three-package roster; the roster is just the `verify` flow's default argument.
  - `verify` — the end-to-end SC-05 flow: start → publish the three packages → run the consumer proof (spawn `pnpm test:acceptance:install` or invoke the harness functions via `tsx`, with `SWIFTAGENT_INSTALL_REGISTRY=http://127.0.0.1:<port>` and `SWIFTAGENT_RUN_INSTALL_PROOF=1`) → stop. Teardown MUST run on failure paths too (`try/finally` + signal handlers) so a red run never leaks a listening process or temp dir, and re-runs are clean.
  - `publishConfig.registry` (post-WS-44: `registry.npmjs.org`) is overridden by the explicit `--registry` flag — pnpm's precedence makes the flag win; assert after publish (via `npm view @swiftagent/sdk version --registry http://127.0.0.1:<port>` or the Verdaccio API) that the version actually landed locally, so a silent fall-through to the wrong registry is impossible.

- **The consumer proof reuses WS-44's harness — resolution provenance asserted.** Point `installPublishedPackages()` at the local endpoint via env. Beyond "install succeeded, imports and type-checks pass" (which the harness already asserts), the verify flow additionally asserts the packages were **served by the local registry**: check the consumer's `node_modules/.package-lock.json` (or `npm ls --json`) `resolved` URLs start with `http://127.0.0.1:<port>/` for all three `@swiftagent/*` entries. That closes the SC-05 loophole where a stray npmrc or cache serves the artifact from elsewhere.

- **CI wiring.** A dedicated `local-registry` job in `ci.yml` (needs: `build-lint`, downloading or rebuilding `dist/` — the three packages must be built before packing; mirror the pack-gate job's build step `pnpm --filter @swiftagent/sdk... --filter @swiftagent/react... build`). It runs `pnpm verify:local-registry`. No Docker, no secrets, no `packages: read` — the whole flow is loopback HTTP. Keep it separate from `acceptance-tests` so a registry-harness failure is legible on its own and the Testcontainers suite's timing is unaffected.

- **Test-time only — enforced, not just stated.** `verdaccio` lands in the ROOT `devDependencies` only. It must not appear in any `packages/*/package.json` (the workspace-dep-declaration rule cuts the other way here: nothing under `packages/` may import it), and nothing under any package's `src/` may reference the harness. The harness scripts live in `scripts/` and `test/` — outside every publishable `files` allowlist — so no tarball can ship it.

- **What NOT to build here.** The scaffold CLI, its templates, and its publication (WS-46 — this workstream only leaves the registry able to accept it, via the general `publish` subcommand and the pre-provisioned `create-swift-agent` package rule). Publishing to real npm (the WS-44 workflow + owner trigger is the only release path). Any change to packaging metadata, license fields, or the pack allowlist (WS-44 owns those; if the harness exposes a packaging defect, report it against WS-44's surfaces rather than patching metadata here).

- **Documentation (`test/local-registry/README.md`).** How to run each subcommand; the port/env knobs; the package-rule design (why `@swiftagent/*` and `create-swift-agent` have no uplink); how WS-46 and example verification consume it (`publish packages/create-swift-agent`, then `npx --registry http://127.0.0.1:<port> create-swift-agent <name>`); the loopback-only warning; the teardown guarantees.

## Implementation Steps

1. **Add Verdaccio.** Root `package.json`: `verdaccio` devDependency (current 6.x); `pnpm install`.
2. **Author `test/local-registry/verdaccio.yaml`** per Design Notes: no-uplink rules for `@swiftagent/*` and `create-swift-agent`, npmjs uplink for `**`, ephemeral storage path injected by the orchestrator, loopback listen.
3. **Author `scripts/local-registry.mjs`** with `start` / `stop` / `publish <dirs>` / `verify`, Windows-safe spawning (mirror `verify-pack.mjs`'s `pnpm.cmd` + `shell: true` handling), readiness polling, state file, and guaranteed teardown.
4. **Wire the consumer proof.** In `verify`, publish the three built packages, then run the WS-44 harness with `SWIFTAGENT_INSTALL_REGISTRY` + `SWIFTAGENT_RUN_INSTALL_PROOF=1` (and the dummy-token env if the install path requires one), then assert local-registry `resolved` provenance. Extend `install-published.ts` minimally ONLY if a gap surfaces; keep the public-npm default path unchanged.
5. **Register the command.** Root script `verify:local-registry`; confirm `pnpm verify:local-registry` is green locally from a built tree, twice in a row (idempotence: second run republishes the same versions — Verdaccio treats an existing version as a conflict, so `publish` must either wipe storage per run [fresh temp dir already guarantees this] or use `--force`; the fresh-storage design makes re-runs clean by construction).
6. **Wire CI.** Add the `local-registry` job to `ci.yml` (needs `build-lint`; builds the three packages; runs the command). Confirm it passes.
7. **Document** in `test/local-registry/README.md`, including the WS-46 consumption pattern.
8. **Finish on the gate.** `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` all green (note: the new `scripts/`/`test/` files sit outside the typecheck/lint gate per repo convention — they are validated by the `verify` run itself; state this in the PR).

## Tests

1. **End-to-end verify (SC-05).** `pnpm verify:local-registry` from a built clean checkout: Verdaccio starts and answers `/-/ping`; all three packages publish into it; the throwaway consumer (outside the workspace) installs them **from the HTTP endpoint**, imports the public symbols, and type-checks against the shipped `.d.ts`; teardown leaves no process and no storage dir.
2. **Registry-protocol provenance (SC-05).** The consumer's resolved tarball URLs for all three `@swiftagent/*` packages begin with the local `http://127.0.0.1:<port>/` origin — proving a real registry install, not a tarball/`file:` path.
3. **No live-registry leak.** With the registry up, a request for `@swiftagent/sdk` returns the locally published version, and the Verdaccio config shows no proxy for the scope; a lookup for an unpublished `@swiftagent/*` name 404s locally rather than falling through to npmjs.
4. **General publish path (enables SC-06).** `node scripts/local-registry.mjs publish <some-other-workspace-dir>` publishes an arbitrary workspace package directory into the running registry (demonstrate with any suitable package or a temp fixture package with a `bin` entry, mimicking WS-46's shape) — proving the path is not hard-coded to the three-package roster.
5. **Failure-path teardown.** Kill the verify flow mid-run (or inject a failing publish): the orchestrator still stops Verdaccio and removes the temp storage; a subsequent `verify` run is green.
6. **Repeatability.** Two consecutive `verify` runs pass (fresh ephemeral storage per run).
7. **CI.** The new `ci.yml` `local-registry` job passes on the workstream's PR, with no Docker and no registry secrets.

## Acceptance Criteria

1. The harness is a Verdaccio-backed **real npm registry protocol endpoint**, started and torn down by a committed script (`scripts/local-registry.mjs` + `test/local-registry/verdaccio.yaml`); a directory of tarballs or `file:` dependencies appears nowhere in the install path, and resolved-URL provenance proves the registry served the packages (SC-05).
2. All three packed packages (`@swiftagent/{sdk,react,shared}`) are published into the local registry via `pnpm publish --registry …` (with `workspace:*` rewritten to concrete versions) and installed into a throwaway consumer outside the workspace that imports the public symbols and type-checks against the shipped `.d.ts`, reusing the WS-44-parameterized harness rather than a fork (SC-05).
3. The publish path accepts ANY workspace package directory — demonstrated on a package outside the three-package roster — and the registry config pre-provisions the unscoped `create-swift-agent` name with no npmjs uplink, so WS-46 can publish into it and resolve via real `npx` (SC-05; enables SC-06).
4. `pnpm verify:local-registry` is a single repeatable command, green twice consecutively locally and wired into `ci.yml` as its own job requiring no Docker and no registry credentials (SC-05).
5. The harness is test-time only: `verdaccio` is a root devDependency, referenced by nothing under any `packages/*/src` or any publishable `files` allowlist, and the registry listens on loopback only, with teardown guaranteed on failure paths (SC-05).
6. `test/local-registry/README.md` documents the subcommands, configuration knobs, the no-uplink scope rules, and the WS-46/scaffold consumption pattern; no packaging metadata, license field, or pack allowlist was changed, and nothing was published to the real npm registry (SC-05).
7. `pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm test` all pass; the new `test/`-tree files are validated by running the harness (they sit outside the typecheck/lint gate per repo convention), stated explicitly in the PR (dependency WS-44/WS-51 chain).
