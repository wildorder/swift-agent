# Swift Agent — Program Plan (SDK & Developer Experience)

## Program Overview

**Product:** Swift Agent — a hosted real-time agent runtime that lets developers embed streaming, tool-calling, multi-model AI agents into any application.

**Program scope:** Deliver the "working agent in minutes" developer experience by turning the internally-working SDKs into publicly consumable, versioned, documented, and verified products. The runtime, gateway, realtime transport, and both SDK packages (`@swiftagent/sdk`, `@swiftagent/react`) already exist and work end to end (see as-built), but they are not yet a finished developer surface: the SDK's fluent `app.sessions.*` / `app.runs.*` API advertised in the vision is not fully realized, package public entry points and `exports` maps are unlocked, there is no versioning or SDK↔server compatibility policy, publishing is a partial workflow, there is no maintained example application, docs drift from the shipped API, and setup/runtime error messages are not actionable. This program **finalizes the two SDK public API surfaces, establishes a versioning and compatibility policy, hardens the publish pipeline, ships a maintained in-repo example app, aligns all documentation to the actual APIs, improves setup and runtime error messages, and adds an automated quickstart acceptance test** that exercises the full "define agent → session → stream" path as the program's definition of done. No runtime-loop, protocol, or schema changes are in scope.

---

## Strategic Goals

1. **A finished, stable public SDK surface** — `@swiftagent/sdk` and `@swiftagent/react` expose exactly the API the vision advertises (`createAgentApp`/`defineAgent`/`tool`, fluent `app.sessions.*`/`app.runs.*`, `useAgentChat`/`createChatSession`), with locked `exports` maps that hide internals.
2. **Predictable versioning & compatibility** — A documented semver + deprecation policy and a machine-checkable SDK↔server/protocol compatibility signal, so upgrades never silently break integrations.
3. **Frictionless install & publish** — Every publishable package builds correct dual (ESM + types) outputs, resolves workspace dependencies to real versions, and publishes reproducibly through a release-driven pipeline.
4. **A living reference integration** — A maintained example application (backend agent + tools + React frontend) that stays green in CI and doubles as the canonical quickstart.
5. **"Minutes, not weeks" is verified, not asserted** — Docs match the shipped API, setup/runtime errors are actionable, and an automated acceptance test proves the full quickstart works.

---

## Architecture Changes

The runtime loop, provider abstraction, gateway/stream protocol, realtime transport, persistence, and AWS infrastructure already exist and are unchanged by this program. The changes here are to the **developer-facing surface**: SDK public APIs, package metadata/build outputs, release tooling, example code, documentation, and error ergonomics.

### 1. SDK API Finalization & Surface Lockdown

The vision advertises a fluent server SDK — `app.sessions.create()`, `app.sessions.get()`, `app.sessions.messages.list()`, `app.runs.create()` — but the as-built SDK exposes a lower-level `ControlPlaneClient` and the app factory (`createAgentApp`, `defineAgent`, `tool`, `startToolRunner`). This program builds the advertised fluent surface as thin, typed wrappers over the existing `ControlPlaneClient` (no new server endpoints — it consumes the existing `/v1/sessions`, `/v1/sessions/:id`, `/v1/sessions/:id/messages`, and `/v1/sessions/:id/runs` routes). Both SDKs get explicit `package.json` `exports` maps, a single documented public entry point per package, `internal`-marked modules made unreachable, and a public type surface reviewed for stability. `@swiftagent/react` exports are audited the same way (`useAgentChat`, `createChatSession`, `useConnection` and their public types only).

### 2. Versioning & Compatibility Policy

Establish and document a semantic-versioning policy across the published packages, a deprecation/removal policy, and — critically for a client/server product — an **SDK↔server compatibility policy** tied to the existing `RUNNER_PROTOCOL_VERSION` and the `ChatEvent`/stream protocol. Surface version/compat constants from `@swiftagent/shared` so the SDK and runner can assert compatibility at registration/connect time and fail with a clear, actionable message on mismatch (rather than an opaque protocol error). Introduce **Changesets** as the source of truth for version bumps and changelogs.

### 3. Package Publishing Pipeline

The existing `publish-sdks.yml` publishes SDKs but is not a finished release process. This program makes publishing reproducible and targets **GitHub Packages** (`npm.pkg.github.com`), the org's existing private registry: correct dual ESM + `.d.ts` build outputs, `files` allowlists, `publishConfig` (scoped `@swiftagent` registry, provenance), `workspace:*` → concrete-version resolution at pack time, dist-tag strategy, `read:packages`/`write:packages` token wiring (`.npmrc` scope config), and a `pnpm pack` / dry-run verification gate. The publishable set is `@swiftagent/sdk`, `@swiftagent/react`, and the workspace dependencies they pull in (e.g. `@swiftagent/shared`) — not the full nine-package surface. The pipeline is driven by Changesets (from the versioning workstream) so a stable release is: merge changesets → version bump → build → publish to GitHub Packages (`latest` tag). In addition, **PR builds publish a Changesets snapshot prerelease** (`0.0.0-pr-<sha>`) to the same registry under a non-`latest` `pr` dist-tag, so the quickstart acceptance test can install a real registry artifact on every PR (not a local tarball). Publishing to the **public** npm registry is a later flip, out of scope here.

### 4. Maintained Example Application

Add an in-repo `examples/quickstart` application: a backend that defines an agent with one or two tools using `@swiftagent/sdk` and starts the tool runner, plus a minimal React frontend using `@swiftagent/react` (`useAgentChat`) that connects to a session and streams a response. It consumes the finalized public APIs only (no deep imports), is wired into CI (typecheck/build, and — via the acceptance workstream — an end-to-end run) so it cannot rot, and is the literal source the quickstart docs walk through.

### 5. Documentation Alignment with Actual APIs

Reconcile every developer-facing doc with the shipped surface: the quickstart, per-package READMEs (`@swiftagent/sdk`, `@swiftagent/react`, and the public support packages), the API-surface tables in the vision, and any site content. Divergences (e.g. the fluent `app.*` surface, the canonical `websocketUrl` contract) are corrected to match code, with snippets drawn from the maintained example so docs and example stay in lockstep.

### 6. Setup & Runtime Error Messages

Make failure modes teach the developer how to fix them. Setup errors (missing/invalid `SWIFT_AGENT_API_KEY`, missing required env keys, malformed agent/tool config caught by Zod) name the offending key and the remediation. Runtime errors (connection refused/unauthorized, token expiry, tool-runner unreachable, tool handler throw, model/provider failure) surface as typed `SwiftAgentError` variants with human-readable messages through both the server SDK and the React client (`lastError`), rather than raw stack traces or opaque codes.

### 7. Quickstart Acceptance Flow

Add an automated acceptance test that walks the documented quickstart end to end against the example app and a running stack (Testcontainers Postgres/Redis + local runtime). To validate the real install step, it **installs the published packages from GitHub Packages** (from WS-38, using a `read:packages` token) rather than the workspace symlinks — on PRs via the `pr`-tagged snapshot prerelease, on main via the stable `latest` release; there is no local-tarball fallback. It then: registers the agent → creates a session → connects via the client → sends a message → asserts the `message_started → token → message_completed` event sequence and a tool-call round-trip. The model call uses a deterministic echo/streaming stub agent so the run is fast and non-flaky. It runs in CI and is the program's executable definition of "working agent in minutes."

---

## Technology Choices

- **Changesets (`@changesets/cli`)** — new dev dependency for version management, changelog generation, and release orchestration across the workspace. Chosen over hand-maintained versions/CHANGELOGs because it fits pnpm workspaces and encodes the versioning policy as tooling.
- **GitHub Packages (`npm.pkg.github.com`)** — the private npm registry the `@swiftagent` scope publishes to. Already in use by this org for other packages, so it needs no new infrastructure — only scope/registry config and `read:packages`/`write:packages` token wiring. The publish pipeline pushes here and the acceptance test installs from here (with a `read:packages` token). Chosen over a live public-npm dependency (irreversible, premature) and over standing up a separate registry (GitHub Packages is already the org's standard).
- **Vite** — dev/build tooling for the example React frontend (the library packages remain on their existing build setup). Chosen as the standard, minimal React dev server for a quickstart-grade app.

Otherwise **no new technology** — everything else uses the existing Node 22 / TypeScript strict / ESM, pnpm + Turborepo, Fastify 5, Zod, Vitest + Testcontainers, and GitHub Actions stack.

---

## Workstreams

| ID | Workstream | Dependencies | Estimated Effort |
|----|-----------|--------------|-----------------|
| WS-36 | SDK API Finalization & Surface Lockdown | as-built SDK baseline | M |
| WS-37 | Versioning & Compatibility Policy | WS-36 | S |
| WS-38 | Package Publishing Pipeline | WS-36, WS-37 | M |
| WS-39 | Maintained Example Application | WS-36 | M |
| WS-40 | Documentation Alignment with Actual APIs | WS-36, WS-39 | M |
| WS-41 | Setup & Runtime Error Messages | WS-36 | M |
| WS-42 | Quickstart Acceptance Flow | WS-38, WS-39, WS-40, WS-41 | M |

**Size key:** S = 1-2 days, M = 3-5 days, L = 5-10 days

### Workstream Details

**WS-36 — SDK API Finalization & Surface Lockdown**
Build the advertised fluent server-SDK surface (`app.sessions.create/get`, `app.sessions.messages.list`, `app.runs.create`) as typed wrappers over the existing `ControlPlaneClient` — no new server endpoints. Add explicit `package.json` `exports` maps and a single public entry point per SDK, mark/hide internal modules, and review the exported type surface for stability. Audit `@swiftagent/react` exports to the public set. Touches `packages/sdk`, `packages/react`, and (types only, if needed) `packages/api`, `packages/shared`.

**WS-37 — Versioning & Compatibility Policy**
Document a semver + deprecation/removal policy and an SDK↔server/protocol compatibility policy tied to `RUNNER_PROTOCOL_VERSION` and the stream protocol. Surface version/compat constants from `@swiftagent/shared` and add a compatibility assertion (registration/connect time) with an actionable mismatch error. Introduce Changesets config as the versioning source of truth. Touches `packages/shared`, `docs/` (policy doc), repo-root Changesets config.

**WS-38 — Package Publishing Pipeline**
Finalize reproducible publishing to **GitHub Packages** (`npm.pkg.github.com`, the org's existing private registry) for the publishable set (`@swiftagent/sdk`, `@swiftagent/react`, and workspace deps like `@swiftagent/shared`): dual ESM + `.d.ts` outputs, `files` allowlists, `publishConfig` (scoped `@swiftagent` registry + provenance), `workspace:*` → concrete-version resolution, dist-tag strategy, `.npmrc` scope config with `read:packages`/`write:packages` token wiring, and a `pnpm pack`/dry-run verification gate. Drive the release from Changesets. Public-npm publishing is a later flip (out of scope). Touches `.github/workflows/publish-sdks.yml`, the publishable `package.json`s (`packages/sdk`, `packages/react`, `packages/shared`), and repo-root release/registry config (`.npmrc`, Changesets).

**WS-39 — Maintained Example Application**
Create `examples/quickstart`: a backend defining an agent + tool(s) via `@swiftagent/sdk` with the tool runner, and a minimal React (Vite) frontend using `@swiftagent/react` `useAgentChat`. Consumes only public APIs; wired into CI typecheck/build so it cannot rot. Touches `examples/quickstart` (new), root workspace config (pnpm workspace globs, Turborepo), `.github/workflows` (build inclusion).

**WS-40 — Documentation Alignment with Actual APIs**
Reconcile the quickstart, per-package READMEs, the vision's API-surface tables, and site content with the finalized shipped surface; source code snippets from the maintained example so docs and example stay in lockstep. Touches `docs/`, per-package `README.md` files, and site/quickstart content.

**WS-41 — Setup & Runtime Error Messages**
Make setup and runtime failures actionable: typed `SwiftAgentError` variants with remediation-oriented messages for missing/invalid API key, missing env keys, malformed agent/tool config, connection/auth failures, tool-runner unreachable, tool-handler throw, and model/provider errors — surfaced through the SDK and the React client's `lastError`. Touches `packages/shared` (`SwiftAgentError`), `packages/sdk`, `packages/react`, and (message pass-through) `packages/api`.

**WS-42 — Quickstart Acceptance Flow**
Add an automated end-to-end acceptance test that runs the documented quickstart against the example app and a local stack (Testcontainers Postgres/Redis). It **installs the published packages from GitHub Packages (WS-38)** using a `read:packages` token to validate the real install step, then: register agent → create session → connect → send message → assert the `message_started → token → message_completed` sequence and a tool-call round-trip, using a deterministic echo/streaming stub agent. Wire into CI as a gate. Touches `test/acceptance` (new), `examples/quickstart` (test hooks), `.github/workflows/ci.yml`.

---

## Dependency Graph

```text
as-built SDK baseline (@swiftagent/sdk, @swiftagent/react, ControlPlaneClient)
        │
        ▼
WS-36 SDK API Finalization & Surface Lockdown
        │
        ├───────────────┬───────────────┬───────────────┐
        ▼               ▼               ▼               ▼
WS-37 Versioning   WS-39 Example   WS-41 Error     (feeds WS-40)
& Compat Policy    Application     Messages
        │               │               │
        ▼               ▼               │
WS-38 Publishing   WS-40 Docs          │
Pipeline (GitHub   Alignment           │
Packages)          │                   │
        │           │                   │
        └───────────┴─────────┬─────────┘
                              ▼
                       WS-42 Quickstart
                       Acceptance Flow
                       (installs from GitHub Packages)
```

WS-37/WS-39/WS-41 all fan out from the finalized SDK surface (WS-36) and run in parallel. WS-38 sequences after WS-37 (publishing consumes the Changesets/versioning setup). WS-40 depends on WS-36 (actual API) and WS-39 (snippets sourced from the example). WS-42 is the capstone: it installs the published packages from GitHub Packages (WS-38) and exercises the example (WS-39), aligned docs (WS-40), and improved errors (WS-41).

---

## Critical Path

**WS-36 → WS-37 → WS-38 → WS-42** (publishing now feeds the acceptance test's install step), co-equal with the docs chain **WS-36 → WS-39 → WS-40 → WS-42** — both four workstreams deep.

Minimum timeline: approximately 14–22 working days. WS-41 parallels both chains off WS-36 and re-joins at WS-42.

---

## Scope (In)

- Finalized public API surface for `@swiftagent/sdk` (incl. the fluent `app.sessions.*`/`app.runs.*` surface) and `@swiftagent/react`, with locked `exports` maps
- A documented versioning + deprecation policy and an SDK↔server/protocol compatibility policy, with a machine-checkable compat assertion and clear mismatch error
- Changesets-driven, reproducible publishing of the SDK packages + their deps to GitHub Packages (the org's existing private registry), with `files`/`publishConfig`, `workspace:*` resolution, and a dry-run verification gate
- A maintained in-repo example application (backend agent + tools + React frontend) kept green in CI
- All developer-facing docs aligned to the shipped API, with snippets sourced from the example
- Actionable, typed setup and runtime error messages across the SDK and React client
- An automated quickstart acceptance test that installs the published packages from GitHub Packages and exercises define agent → session → connect → stream + tool round-trip, wired into CI
- Monorepo typecheck/lint/unit/integration green

## Scope (Out)

- Any change to the runtime loop, model providers, executor resolution, gateway/stream protocol, or trace/span schema
- New server API endpoints (the fluent SDK wraps existing control-plane routes)
- Completing the `SummaryMemoryStrategy` stub (runtime tech debt, not DX) — remains as-is
- Horizontal multi-instance realtime scaling and durable execution (Phase 2)
- Publishing to the **public** npm registry (GitHub Packages private registry only; public is a later flip)
- Publishing the full nine-package surface (only the SDKs + their workspace deps are publishable here)
- A hosted docs site / marketing dashboard build-out (content alignment only)
- CLI or Terraform-provider surfaces (future automation consumers)
- Usage metering / billing / autoscaling

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Finalizing/locking `exports` breaks existing internal consumers (server app, tests) that deep-import SDK internals | High | Grep all deep imports before locking; keep internals reachable via an explicit `/internal` subpath if truly needed; run full monorepo typecheck/tests |
| The advertised fluent `app.*` surface can't cleanly wrap existing control-plane routes | Medium | Build as thin typed wrappers over `ControlPlaneClient`; reuse existing response schemas; no new endpoints |
| Changesets + `workspace:*` resolution mis-publishes (wrong versions, missing deps, broken types) | High | `pnpm pack` + dry-run gate; verify tarball contents and `exports`; publish provenance; the acceptance test installs the real published package from GitHub Packages and catches broken publishes |
| GitHub Packages auth (`read`/`write:packages`) trips up CI or local dev `.npmrc` | Medium | Scope registry config to `@swiftagent` only in `.npmrc`; use the built-in `GITHUB_TOKEN` for CI publish/install where possible; document local PAT setup; keep tokens in secrets, never committed |
| Example app rots or diverges from docs | Medium | Wire the example into CI build + the acceptance test; source doc snippets from the example rather than hand-writing |
| Compatibility policy adds friction or false-positive mismatches for local/dev | Medium | Version-gate on protocol constants only; warn-not-fail on minor drift; clear, scoped error messages |
| Acceptance test flakes on Testcontainers/model streaming and blocks CI | Medium | Use a deterministic echo/streaming stub agent; bounded timeouts + retries; captured diagnostics on failure |
| Docs alignment surfaces deeper API inconsistencies mid-program | Medium | Treat WS-36 as the single source of truth for the surface; docs conform to code, code changes only if a genuine bug is found |

---

## Success Criteria

- **SC-01:** `@swiftagent/sdk` and `@swiftagent/react` expose exactly the vision-advertised public surface (incl. fluent `app.sessions.*`/`app.runs.*`, `useAgentChat`, `createChatSession`) through explicit `exports` maps; internal modules are not reachable from the package root.
- **SC-02:** A versioning + deprecation policy and an SDK↔server/protocol compatibility policy are documented and committed.
- **SC-03:** Version/compatibility constants are surfaced from `@swiftagent/shared`, and the SDK/runner assert compatibility at registration/connect time, failing with an actionable message on mismatch.
- **SC-04:** The publishable packages (`@swiftagent/sdk`, `@swiftagent/react`, and their workspace deps) build correct dual ESM + type outputs, declare `files`/`publishConfig`, resolve `workspace:*` to concrete versions, and publish to GitHub Packages (`npm.pkg.github.com`) driven by Changesets, gated by dry-run verification.
- **SC-05:** A maintained example application (backend agent + tools via `@swiftagent/sdk`, React frontend via `@swiftagent/react`) exists in-repo, consumes only public APIs, and is kept green in CI.
- **SC-06:** The quickstart, per-package READMEs, and the vision's API-surface tables match the shipped APIs, with example-sourced snippets.
- **SC-07:** Setup errors (missing/invalid API key, missing env keys, malformed agent/tool config) produce actionable messages naming the offending key/field and the remediation.
- **SC-08:** Runtime errors (connection/auth, tool-runner unreachable, tool-handler throw, model/provider failure) surface as typed, human-readable errors through the SDK and the React client's `lastError`.
- **SC-09:** An automated quickstart acceptance test installs the published packages from GitHub Packages and exercises define agent → create session → connect → stream a response (incl. a tool-call round-trip) against a deterministic stub agent, running as a CI gate.
- **SC-10:** Type-checking, linting, and unit tests pass for every package this program touches, and the integration/acceptance suites introduce no new failures relative to the documented pre-existing baseline. (The known pre-existing failures — the `@swiftagent/server` vitest exit-1 and the 3 `@swiftagent/api` failures — are not regressions and are out of scope to fix here; a workstream may note them but must not be blocked by them.)
