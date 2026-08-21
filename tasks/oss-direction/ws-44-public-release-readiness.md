# WS-44: Public Release Readiness (Gated)

## Goal

Flip **every ACTIVE repository surface existing at this workstream's time** — the twelve enumerated in the manifest's `constraints.publishingSurfaces` and tabulated below — from the current private/restricted posture to a **public Apache-2.0 project**, in **one atomic workstream**, and **arm the release pipeline without firing it**.

Concretely, five cohesive deliverables:

1. **Package metadata + license flip.** `@swiftagent/{sdk,react,shared}` move from `publishConfig.registry = https://npm.pkg.github.com` / `access: restricted` / `"license": "UNLICENSED"` to `registry = https://registry.npmjs.org` / `access: public` / `"license": "Apache-2.0"`, backed by a repository `LICENSE` file (none exists today — verified: no `LICENSE*` at the repo root) with the standard Apache-2.0 appendix boilerplate, plus a `NOTICE` file per the Apache NOTICE convention.

2. **Every enforcing/normative/documentary surface moves with it.** `.changeset/config.json`, `docs/policies/versioning.md` §1 (also stale on a factual point — see Design Notes), `scripts/verify-pack.mjs` (whose assertions would otherwise fail the build the moment `publishConfig` changes), **`.npmrc` (FUNCTIONAL — its `@swiftagent:registry=https://npm.pkg.github.com` line overrides package metadata and would keep routing every consumer install to GitHub Packages)**, `AGENTS.md`'s Delivery convention (line 118–120), `docs/as-built.md`, `README.md`, `docs/quickstart.md`, and all three package READMEs.

3. **The release pipeline is armed, not fired.** `.github/workflows/publish-sdks.yml` (today: auto-publish to GitHub Packages on push to `main`) and `publish-sdks-prerelease.yml` (today: auto-snapshot to GitHub Packages on every PR) are retargeted to **public npm behind an explicit manual `workflow_dispatch` trigger** — the decided release path (program decision 4), pressed once by the owner, and designed so WS-46 can later add `create-swift-agent` to the same release. The `ci.yml` acceptance job that authenticates to GitHub Packages is updated. A release runbook (`RELEASING.md`) documents the single trigger and the owner-owned npm org/token provisioning. A verified `pnpm publish --dry-run` for each of the three packages — **pnpm, not npm**, because publication must rewrite `workspace:*` ranges — with the packed manifests inspected to confirm the rewriting (SC-04). **Nothing is published by this workstream.**

4. **Contribution terms.** `CONTRIBUTING.md` + a `DCO` file adopting the Developer Certificate of Origin 1.1, requiring a `Signed-off-by` trailer on every commit, stating that **contributors retain copyright** (so relicensing later requires their permission), with the rationale that Apache-2.0 §5 already makes contributions inbound=outbound so no CLA is needed. A CI check **enforces** the trailer on PR commits, asserted by the check actually running (SC-13). A DCO sign-off prompt is **AMENDED INTO the existing** `.github/pull_request_template.md` — it already exists with Description / Linked Workstream / Checklist sections; **do not create a second template**.

5. **The acceptance install harness follows the registry.** `test/acceptance/install-published.ts`, `test/acceptance/install-registry.acceptance.test.ts`, and `test/vitest.acceptance.config.ts` execute against the restricted registry today; they are retargeted and **parameterized by registry URL** so WS-45's local Verdaccio registry can drive the identical harness (see Design Notes — this parameterization is a deliberate hand-off to WS-45).

This workstream changes **no** package's public API surface, exports map, or build output. Packages created later (`create-swift-agent` in WS-46, `apps/playground` in WS-48) are born with their correct posture by those workstreams; WS-49 re-runs the posture search over the terminal tree.

## Traceability

- **SC-03** — the three packages declare `publishConfig.registry = https://registry.npmjs.org` with `access: public`, carry `"license": "Apache-2.0"` backed by a repository `LICENSE` file (no `UNLICENSED` remains), and `node scripts/verify-pack.mjs` passes with updated assertions.
- **SC-04** — `pnpm publish --dry-run` succeeds for all three packages with packed-manifest inspection confirming `workspace:*` rewriting; the release workflow publishes to public npm ONLY from a manual `workflow_dispatch`; a release runbook documents the trigger and the owner-owned npm org/token provisioning; demonstrated without publishing anything.
- **SC-11 (WS-44's half)** — the twelve-surface sweep of every active surface existing at this workstream's time is exhaustive, with historical records preserved unchanged. (The terminal re-sweep is WS-49's; born-correct posture for later packages is WS-46's/WS-48's.)
- **SC-13** — `CONTRIBUTING.md` + `DCO` adopt DCO 1.1, state contributors retain copyright, and a CI check rejects a PR commit lacking `Signed-off-by` and accepts one that has it, asserted by the check actually running.

## Dependencies

- **WS-51 — Canonical Verification Gate Stability.** Provides a deterministic four-command gate: `pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm test` all pass reliably from a clean checkout (the `apps/server` index-import timing flake is removed). WS-44's checkpoint must finish with all four green, which is only falsifiable once the gate stops going red at random. WS-44 consumes the stable gate; it does not modify any test WS-51 touched.

## Context Files (Agent MUST read before implementing)

- `C:\dev\swift-agent\CLAUDE.md` — conventions (forced verification via typecheck + lint; NO semantic search — grep every reference category when changing a name; note the root `test/` tree is excluded from `pnpm typecheck`/`lint` and validated only by running `pnpm test:acceptance`, which needs Docker).
- `C:\dev\swift-agent\docs\programs\oss-direction-manifest.json` — CANONICAL scope: `workstreams[WS-44]` includes/excludes, `constraints.publishingSurfaces` (the twelve-surface set and the historical-records exclusion), `constraints.contributionTerms`, `constraints.npmGate` (decision 4 — trigger is the release path, not a gate), `successCriteria` SC-03/SC-04/SC-11/SC-13.
- `C:\dev\swift-agent\docs\programs\oss-direction-program.md` — Requirements decision 4; the twelve-surface posture table in Architecture Changes; the DCO/CONTRIBUTING rationale; the "Historical records are deliberately excluded" rule.
- `C:\dev\swift-agent\packages\sdk\package.json`, `C:\dev\swift-agent\packages\react\package.json`, `C:\dev\swift-agent\packages\shared\package.json` — the three manifests to flip: `"license": "UNLICENSED"`, `publishConfig` = GitHub Packages/restricted, no `private` field, `files` allowlist, `exports` maps (which must NOT change).
- `C:\dev\swift-agent\.changeset\config.json` — `"access": "restricted"` → `"public"`.
- `C:\dev\swift-agent\.npmrc` — line 4 is the functional routing surface: `@swiftagent:registry=https://npm.pkg.github.com`.
- `C:\dev\swift-agent\docs\policies\versioning.md` — §1 last bullet is the normative private-posture text AND the stale `"private": true` claim; §6 points release automation at "the private registry".
- `C:\dev\swift-agent\scripts\verify-pack.mjs` — `const REGISTRY = 'https://npm.pkg.github.com'` (line 28), the §4 metadata assertions (lines 110–126), and the header comment naming GitHub Packages.
- `C:\dev\swift-agent\AGENTS.md` — the Delivery convention (lines 118–120): "publish to GitHub Packages; every other package is `private`" — change the registry target, PRESERVE the every-other-package-private rule.
- `C:\dev\swift-agent\docs\as-built.md` — "Versioning & Publishing (WS-37/WS-38)" section (~lines 192–211) and "Known Limitations" (~lines 246–249) describe the restricted posture as current; this is an ACTIVE system-state doc, in-sweep.
- `C:\dev\swift-agent\README.md` — lines 46–51: the "Distribution is mid-migration" blockquote naming GitHub Packages as the only install path.
- `C:\dev\swift-agent\docs\quickstart.md` — §1 Install (lines 12–23) names GitHub Packages.
- `C:\dev\swift-agent\packages\sdk\README.md`, `C:\dev\swift-agent\packages\react\README.md`, `C:\dev\swift-agent\packages\shared\README.md` — identical "## Install" sections (lines 5–16) naming the private registry and a `read:packages` token.
- `C:\dev\swift-agent\.github\workflows\publish-sdks.yml` — auto-publishes to GitHub Packages on push to `main`; Changesets version + publish + commit-back.
- `C:\dev\swift-agent\.github\workflows\publish-sdks-prerelease.yml` — auto-snapshot (`0.0.0-pr-<sha>`, dist-tag `pr`) to GitHub Packages on every PR.
- `C:\dev\swift-agent\.github\workflows\ci.yml` — the `acceptance-tests` job (~lines 187–232): `permissions: packages: read`, setup-node with `registry-url: https://npm.pkg.github.com` + `scope: '@swiftagent'`, and `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`; also the `Publish dry-run (pack)` job (~line 242) running `node scripts/verify-pack.mjs`.
- `C:\dev\swift-agent\test\acceptance\install-published.ts` — `const REGISTRY = 'https://npm.pkg.github.com'` (line 27), the hard `NODE_AUTH_TOKEN` requirement (`hasRegistryAuth`), consumer `.npmrc` generation (lines 210–214), dist-tag resolution (`pr` on PRs, `latest` otherwise).
- `C:\dev\swift-agent\test\acceptance\install-registry.acceptance.test.ts` — the `describe.skipIf(!AUTH)` credential gate and loud-skip breadcrumb; the pattern to preserve for the "nothing published yet" state.
- `C:\dev\swift-agent\test\vitest.acceptance.config.ts` — comments name GitHub Packages; config otherwise unchanged.
- `C:\dev\swift-agent\.github\pull_request_template.md` — the EXISTING template (Description / Linked Workstream / Checklist) that gains a DCO sign-off prompt.
- `C:\dev\swift-agent\tasks\realtime-cloud-delivery\ws-33-redis-fanout-health.md` — house style for spec-conformant implementation reporting.

## Package

`packages/sdk`, `packages/react`, `packages/shared`, `.changeset`, `scripts`, `.github`, `.github/workflows`, `test/acceptance`, `docs`, plus repo-root files (`LICENSE`, `NOTICE`, `CONTRIBUTING.md`, `DCO`, `RELEASING.md`, `README.md`, `AGENTS.md`, `.npmrc`).

No source code under any package's `src/` changes. No `pnpm-lock.yaml` churn is expected (no dependency changes).

## The Twelve Surfaces — current state → target state

| # | Surface | File(s) | Current state (verified in tree) | Target state |
|---|---------|---------|----------------------------------|--------------|
| 1 | Package metadata | `packages/{sdk,react,shared}/package.json` | `"license": "UNLICENSED"`; `publishConfig: { registry: "https://npm.pkg.github.com", access: "restricted" }`; no `private` field | `"license": "Apache-2.0"`; `publishConfig: { registry: "https://registry.npmjs.org", access: "public" }`; still no `private` field; `exports`/`main`/`types`/`files` core untouched (add `LICENSE`/`NOTICE` to `files` — see Design Notes) |
| 2 | License | *(none)* → `LICENSE`, `NOTICE` | No `LICENSE*` or `NOTICE*` exists at the repo root (verified by glob) | Repository `LICENSE` = verbatim Apache License 2.0 including the standard appendix boilerplate; `NOTICE` per the Apache convention; per-package copies shipped in tarballs |
| 3 | Changesets | `.changeset/config.json` | `"access": "restricted"` | `"access": "public"` |
| 4 | Normative policy | `docs/policies/versioning.md` §1 (+§6) | "Packages are currently private. Every package is `"private": true` and publishes to a **restricted** (private) registry…" — additionally STALE: the three publishable packages carry **no** `private` field | §1 rewritten: three publishable packages are public (Apache-2.0, `registry.npmjs.org`, `access: public`, no `private` field); every OTHER workspace package is `"private": true`; §6's "private registry" pointer updated to the public release path + `RELEASING.md` |
| 5 | Pack verifier | `scripts/verify-pack.mjs` | `REGISTRY = 'https://npm.pkg.github.com'` asserted on every packed manifest (line 112); header comment names GitHub Packages | Asserts `registry.npmjs.org`, `access: public`, `license === 'Apache-2.0'`, and `package/LICENSE` + `package/NOTICE` in each tarball; comments updated |
| 6 | Registry routing (FUNCTIONAL) | `.npmrc` | Line 4: `@swiftagent:registry=https://npm.pkg.github.com` — overrides package metadata for every install | The scope-routing line is **removed** (default registry is npmjs); the three behavioral lines above it are kept verbatim |
| 7 | Repository directives | `AGENTS.md` lines 118–120 | "`@swiftagent/sdk`, `@swiftagent/react`, and `@swiftagent/shared` publish to GitHub Packages; every other package is `private`." | "…publish to **public npm** (`registry.npmjs.org`, Apache-2.0); every other package is `private`." — the second clause is PRESERVED verbatim in meaning |
| 8 | System-state doc | `docs/as-built.md` | Describes `access: restricted`, `UNLICENSED`, GitHub Packages publish workflows, "Private registry only" limitation as CURRENT | Rewritten wherever it asserts the restricted posture as current; the "Private registry only" known-limitation replaced by the armed-release state (one documented trigger away, per decision 4) |
| 9 | Entry docs | `README.md` lines 46–51; `docs/quickstart.md` §1 | Both name GitHub Packages + `read:packages` token as the only install path | Plain `pnpm add @swiftagent/sdk @swiftagent/react` from public npm, written for the released state; no version badge or claim that a version already exists on the registry |
| 10 | Shipped package docs | `packages/{sdk,react,shared}/README.md` | Identical "## Install" sections requiring `.npmrc` scope mapping + `read:packages` token | Plain public-npm install; the `.npmrc`/token instructions removed |
| 11 | Workflows | `ci.yml`, `publish-sdks.yml`, `publish-sdks-prerelease.yml` | `publish-sdks.yml` auto-publishes to GitHub Packages on push to `main`; prerelease auto-snapshots on every PR; `ci.yml` acceptance job authenticates to `npm.pkg.github.com` | Both publish workflows target `registry.npmjs.org` behind `workflow_dispatch` only, auth via `NPM_TOKEN` secret; `ci.yml` acceptance job's GitHub Packages auth removed (see Design Notes) |
| 12 | Install harness | `test/acceptance/install-published.ts`, `install-registry.acceptance.test.ts`, `test/vitest.acceptance.config.ts` | Hard-coded `REGISTRY = npm.pkg.github.com`, mandatory `NODE_AUTH_TOKEN`, dist-tag `pr`/`latest` from the auto-snapshot workflow | Registry parameterized (`SWIFTAGENT_INSTALL_REGISTRY`, default `https://registry.npmjs.org`), auth optional (public registries need none), gated to loud-skip until a published version exists; the identical harness serves WS-45's local registry |

## Files Touched

- `packages/sdk/package.json` **(MODIFY)** — `license`, `publishConfig`, `files` additions only.
- `packages/react/package.json` **(MODIFY)** — same.
- `packages/shared/package.json` **(MODIFY)** — same.
- `LICENSE` **(NEW)** — Apache License 2.0, verbatim, with the standard appendix.
- `NOTICE` **(NEW)** — `Swift Agent` + copyright line per the Apache NOTICE convention.
- `packages/sdk/LICENSE`, `packages/react/LICENSE`, `packages/shared/LICENSE` **(NEW)** — byte-identical copies of the root `LICENSE` (see Design Notes); likewise `NOTICE` copies.
- `.changeset/config.json` **(MODIFY)** — `access: public`.
- `docs/policies/versioning.md` **(MODIFY)** — §1 posture bullet rewritten + stale-fact fix; §6 pointer updated.
- `scripts/verify-pack.mjs` **(MODIFY)** — registry/access/license/LICENSE-file assertions + comments.
- `.npmrc` **(MODIFY)** — remove the `@swiftagent:registry` line.
- `AGENTS.md` **(MODIFY)** — Delivery convention registry target only.
- `docs/as-built.md` **(MODIFY)** — restricted-posture wording.
- `README.md` **(MODIFY)** — install blockquote (lines 46–51) rewritten for public npm; a License section/link added.
- `docs/quickstart.md` **(MODIFY)** — §1 Install rewritten.
- `packages/sdk/README.md`, `packages/react/README.md`, `packages/shared/README.md` **(MODIFY)** — Install sections rewritten.
- `.github/workflows/publish-sdks.yml` **(MODIFY)** — `on: workflow_dispatch`; setup-node `registry-url: https://registry.npmjs.org` (no `scope` needed); `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`; `permissions.packages: write` dropped.
- `.github/workflows/publish-sdks-prerelease.yml` **(MODIFY)** — `on: workflow_dispatch`; same registry/auth changes; snapshot dist-tag retained.
- `.github/workflows/ci.yml` **(MODIFY)** — acceptance job: drop `packages: read`, GitHub Packages `registry-url`/`scope`, and `NODE_AUTH_TOKEN`; update comments.
- `.github/workflows/dco.yml` **(NEW)** — PR-triggered DCO trailer check running `scripts/check-dco.mjs`.
- `scripts/check-dco.mjs` **(NEW)** — the committed Signed-off-by checker (with `--self-test`).
- `RELEASING.md` **(NEW)** — the release runbook.
- `CONTRIBUTING.md` **(NEW)** — contribution terms, DCO requirement, copyright-retention statement, dev workflow pointers.
- `DCO` **(NEW)** — Developer Certificate of Origin 1.1, verbatim.
- `.github/pull_request_template.md` **(MODIFY)** — add a DCO sign-off checklist item; keep the existing sections.
- `test/acceptance/install-published.ts` **(MODIFY)** — registry parameterization + optional auth.
- `test/acceptance/install-registry.acceptance.test.ts` **(MODIFY)** — gate + loud-skip rewording.
- `test/vitest.acceptance.config.ts` **(MODIFY — comments only)** — registry naming in comments.

## Existing Interfaces to Consume

**The three `publishConfig` blocks** (`packages/{sdk,react,shared}/package.json` — identical shape in all three):

```json
"license": "UNLICENSED",
"publishConfig": {
  "registry": "https://npm.pkg.github.com",
  "access": "restricted"
}
```

**The functional routing line** (`.npmrc`, complete file — line 4 is the surface):

```ini
strict-peer-dependencies=true
auto-install-peers=true
shamefully-hoist=false
@swiftagent:registry=https://npm.pkg.github.com
```

**The pack verifier's registry assertion** (`scripts/verify-pack.mjs`):

```javascript
const REGISTRY = 'https://npm.pkg.github.com';
// ...
if ('private' in packedJson) fail(pkg.name, 'packed manifest still has "private"');
if (packedJson.publishConfig?.registry !== REGISTRY)
  fail(pkg.name, `publishConfig.registry is "${packedJson.publishConfig?.registry}", expected ${REGISTRY}`);
```

Note `verify-pack.mjs` already proves `workspace:*` rewriting via `pnpm pack` (§2 assertion, lines 100–108) — the same pnpm mechanism SC-04's `pnpm publish --dry-run` relies on.

**The normative policy text** (`docs/policies/versioning.md` §1, last bullet — the stale claim is bolded here):

> **Packages are currently private.** Every package is `"private": true` and publishes to a **restricted** (private) registry once WS-38 turns publishing on. […] Do not remove `"private": true` as part of a feature change — flipping it is a release concern owned by WS-38.

(Reality check: `packages/{sdk,react,shared}/package.json` carry **no** `private` field at all; the nine other workspace packages are `"private": true`.)

**The AGENTS.md Delivery convention** (lines 118–120):

```markdown
**Delivery.** `@swiftagent/sdk`, `@swiftagent/react`, and `@swiftagent/shared`
publish to GitHub Packages; every other package is `private`. Releases go
through Changesets (`pnpm changeset`).
```

**The stable publish workflow's trigger + auth** (`.github/workflows/publish-sdks.yml`):

```yaml
on:
  push:
    branches: [main]
# ...
      - name: Setup Node.js (GitHub Packages)
        uses: actions/setup-node@v4
        with:
          registry-url: https://npm.pkg.github.com
          scope: '@swiftagent'
# ...
      - name: Publish to GitHub Packages
        run: pnpm changeset publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

**The CI acceptance job's registry auth** (`.github/workflows/ci.yml`, `acceptance-tests` job):

```yaml
    permissions:
      contents: read
      packages: read
# ...
      - name: Setup Node.js (GitHub Packages)
        uses: actions/setup-node@v4
        with:
          registry-url: https://npm.pkg.github.com
          scope: '@swiftagent'
# ...
      - name: Run acceptance tests
        run: pnpm test:acceptance
        env:
          NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

**The install harness's registry + credential gate** (`test/acceptance/install-published.ts`):

```typescript
const REGISTRY = 'https://npm.pkg.github.com';
// ...
export function hasRegistryAuth(): boolean {
  return Boolean(process.env['NODE_AUTH_TOKEN']);
}
// consumer .npmrc generation:
const npmrc =
  `@swiftagent:registry=${REGISTRY}\n` +
  `//npm.pkg.github.com/:_authToken=\${NODE_AUTH_TOKEN}\n` +
  'audit=false\nfund=false\n';
```

and its test-side gate (`install-registry.acceptance.test.ts`): `describe.skipIf(!AUTH)` with the loud-skip breadcrumb `describe.runIf(!AUTH)`.

**The existing PR template** (`.github/pull_request_template.md`, complete):

```markdown
## Description
## Linked Workstream / Issue
## Checklist
- [ ] Tests added or updated
- [ ] Database migration required: **yes / no**
- [ ] Environment variables added or changed: **yes / no**
- [ ] Breaking changes: **yes / no**
```

## Design Notes

- **Atomicity is the point.** A half-flipped repository is worse than a private one — `UNLICENSED` metadata behind a public registry target, or a policy doc contradicting shipped manifests. All twelve surfaces land in ONE workstream/PR, closed by repository-wide search (Implementation Step 12), not recollection. The risk register names two surfaces that would otherwise be missed: `verify-pack.mjs` (would go red the moment `publishConfig` changes — flip its assertions in the same change) and `.npmrc` (functional, silently overrides metadata).

- **Historical records are NOT rewritten.** Superseded program plans under `docs/programs/`, task specifications under `tasks/` (including `tasks/sdk-dev-ux/ws-38-package-publishing-pipeline.md`, which `verify-pack.mjs`'s header cites), and as-built snapshots describing the posture that WAS true are preserved as-is. The final grep sweep (Step 12) must therefore report hits under those trees as EXPECTED and untouched; only active normative, functional, and shipped-documentation surfaces change. `docs/as-built.md` itself is ACTIVE (it describes current state) and IS in-sweep.

- **LICENSE ships in each tarball.** Apache-2.0 §4(a) requires distributing a copy of the license with copies of the work. `pnpm pack` packs from the package directory, so the root `LICENSE` would not reach the tarballs. Commit byte-identical copies of `LICENSE` and `NOTICE` into each of the three package directories, add both to each `files` allowlist, and make `verify-pack.mjs` assert (a) `package/LICENSE` and `package/NOTICE` are present in each tarball and (b) each copy is byte-identical to the root file — the identity assertion prevents silent drift. The `LICENSE` text is the verbatim Apache License 2.0 including the appendix ("APPENDIX: How to apply the Apache License to your work") — the manifest's exclude ("apply it, including the NOTICE convention and the standard appendix boilerplate") makes the boilerplate mandatory, not optional.

- **`.npmrc`: remove the routing line rather than repoint it.** `registry.npmjs.org` is npm/pnpm's default; an explicit `@swiftagent:registry=https://registry.npmjs.org` line would be redundant and one more surface to keep in sync. Removing line 4 and keeping lines 1–3 verbatim is the minimal correct change. Workspace-internal `@swiftagent/*` resolution is unaffected (`workspace:*` protocol never consults a registry). Publish-time registry resolution then comes from each package's `publishConfig.registry` plus the workflow's setup-node `registry-url`.

- **Release workflows: `workflow_dispatch` is the release path, not a gate (decision 4).** Change `publish-sdks.yml`'s trigger from `push: branches: [main]` to `workflow_dispatch:` (optionally with a confirmation input, e.g. `confirm: type: choice` — keep it simple). Auth becomes `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` (an npm automation token the OWNER provisions — documented in `RELEASING.md`, NOT provisioned here; the workflow must fail with a clear message if the secret is absent). `permissions.packages: write` is no longer needed; `contents: write` stays for the Changesets version-bump commit-back. **Designed for WS-46:** `pnpm changeset publish` publishes every non-`private` workspace package with a version not yet on its registry — so when WS-46 adds public-postured `create-swift-agent`, the same trigger releases it with NO workflow edit, provided the build step covers it. Therefore widen the build step from the current two-filter form to build all publishable packages generically (e.g. `pnpm build`, or a filter WS-46 can extend), and say so in a comment.

- **The prerelease workflow loses its automatic trigger — accept the consequence explicitly.** Today `publish-sdks-prerelease.yml` snapshots to GitHub Packages on every PR, and the CI acceptance job installs that `pr` snapshot. Auto-publishing snapshots to PUBLIC npm on every PR is not acceptable (real publications, publicly visible, and this workstream must publish nothing), so the prerelease workflow also moves behind `workflow_dispatch` (snapshot dist-tag retained, e.g. `pr` or `snapshot`, never `latest`). Consequence: **the per-PR published-artifact install proof ceases until WS-45**, whose Verdaccio registry becomes the pre-release verification path — this is the designed hand-off, stated in the workflow's comments and in `RELEASING.md`.

- **Install harness: parameterize, don't fork.** In `install-published.ts`: replace the `REGISTRY` const with `process.env['SWIFTAGENT_INSTALL_REGISTRY'] ?? 'https://registry.npmjs.org'`; generate the consumer `.npmrc` with the scope mapping to that registry and the `_authToken` line ONLY when `NODE_AUTH_TOKEN` is set (public npm needs no token; WS-45's Verdaccio needs a dummy one it will supply via env). Replace the `hasRegistryAuth()` gate in the acceptance test with an explicit opt-in gate — `SWIFTAGENT_RUN_INSTALL_PROOF=1` — because after this flip and before the owner presses the trigger, NOTHING exists on `registry.npmjs.org` under `@swiftagent/*`, and a default-on test would fail every CI run while asserting a version exists (which no surface may claim, per `constraints.npmGate`). Keep the loud-skip breadcrumb pattern (`describe.runIf`) so a green run never silently implies the proof ran. `ci.yml` stops setting `NODE_AUTH_TOKEN`/registry auth for this job; the acceptance suite's OTHER scenarios (quickstart drive etc.) keep running unconditionally. Document in the harness header that WS-45 re-enables the proof against the local registry by setting `SWIFTAGENT_INSTALL_REGISTRY` + `SWIFTAGENT_RUN_INSTALL_PROOF`.

- **`pnpm publish --dry-run` — the SC-04 proof.** Run from each package directory: `pnpm publish --dry-run --no-git-checks` (the branch will not be `main` at implementation time; `--no-git-checks` is required and safe for a dry run). pnpm, NOT npm: only pnpm rewrites `workspace:*` dependency ranges to concrete versions, the same mechanism `verify-pack.mjs` exercises via `pnpm pack`. Inspect the packed manifest each dry run produces (or the `pnpm pack` tarball, which is the identical packing path) and confirm `@swiftagent/shared` in sdk's and react's manifests is a concrete semver, not `workspace:*`. Record the three command outputs in the PR. The dry run must NOT require auth; if pnpm insists on a token even for `--dry-run` against npmjs, supply a placeholder via env and state so — no real token exists yet.

- **DCO check: a committed script, not a bot.** The manifest deliberately rejects CLA-assistant bots and signing flows; a third-party DCO GitHub App is likewise avoided in favor of a small owned script. `scripts/check-dco.mjs`: given a commit range (in CI: `git log --format=%H%n%B%x00 origin/${{ github.base_ref }}..HEAD`, or the PR commits via `github.event`), assert every commit message contains a line matching `/^Signed-off-by: .+ <.+@.+>$/m`; print each offending SHA + first line; exit 1 on any failure. Support `--self-test`: create a temp git repo, make one commit WITH the trailer and one WITHOUT, run the check against each, and assert accept/reject respectively — this is how SC-13's "rejects … and accepts …, asserted by the check actually running" is demonstrated deterministically inside the workstream, independent of the live PR's commits. `.github/workflows/dco.yml` runs on `pull_request` (checkout with `fetch-depth: 0`), executes `--self-test` first, then the real range check. Merge/revert commits authored by GitHub (`Merge pull request…`) may be exempted — state the exemption in the script's header and in CONTRIBUTING.md.

- **CONTRIBUTING.md content (minimum).** (1) DCO 1.1 adopted — every commit needs `Signed-off-by` (`git commit -s`), enforced by CI, with the `DCO` file quoted/linked; (2) the explicit statement that **contributors retain copyright in their contributions**, so the project cannot be relicensed without their permission — the knowingly-accepted consequence per `constraints.contributionTerms`; (3) the rationale: Apache-2.0 §5 licenses inbound contributions under the outbound terms, so no CLA is required and none is used; (4) dev-workflow basics (pnpm, the four gate commands, `pnpm changeset`); (5) a pointer to `RELEASING.md`. NO code of conduct, NO issue templates (excluded).

- **RELEASING.md content (minimum).** (1) The single release path: the owner triggers `Publish SDKs` via `workflow_dispatch` — once — which runs Changesets version + publish to public npm for every publishable package (the three now; `create-swift-agent` once WS-46 adds it); (2) the owner-owned prerequisites, documented but NOT performed here: create/claim the npm organization for the `@swiftagent` scope, provision an automation token, store it as the `NPM_TOKEN` repository secret; (3) the snapshot/prerelease dispatch path; (4) what the dry-run + local-registry (WS-45) proofs cover pre-release. No surface — here or anywhere — may claim a version already exists on the registry.

- **`versioning.md` §1 rewrite — fix the posture AND the stale fact.** The bullet becomes: the three publishable packages are public — Apache-2.0, `publishConfig.registry = https://registry.npmjs.org`, `access: public`, and (correcting the stale claim) they carry **no** `private` field; every other workspace package is `"private": true` and is never published. Retain the Changesets mechanics. §6's "the private registry" pointer and the WS-38 ownership language are updated to point at `RELEASING.md` and the manual `workflow_dispatch`; the historical WS-38 attribution may remain as attribution.

- **AGENTS.md: change one clause, preserve the other.** Only the registry target changes; "every other package is `private`" remains true after the flip (and after WS-46/WS-48, per the terminal roster) and MUST survive verbatim in meaning. Do not touch the rest of AGENTS.md.

- **Docs are written for the released state (decision 4).** README/quickstart/package READMEs present `pnpm add @swiftagent/sdk @swiftagent/react` from public npm as the supported path. Do not add version badges or any claim that a version is live; where useful, one line may note the release fires from the documented trigger (linking `RELEASING.md`). The full SC-10 documentation pass (playground links, deploy button, `npx create-swift-agent` quickstart, vision ladder) is WS-49's — WS-44 changes these files ONLY where they assert the restricted posture or a GitHub Packages install.

- **What must NOT change.** Any package's `exports` map, `main`/`types`, build output, or source (`verify-pack.mjs`'s byte-identity assertion on `exports`/`main`/`types` enforces this — keep that assertion); the license CHOICE (Apache-2.0 is decided); the npm org/token (owner-owned); historical records; anything owned by WS-45 (the Verdaccio harness itself); CLA/copyright assignment; code of conduct/issue templates/docs site. Pressing either publish trigger is forbidden.

## Implementation Steps

1. **Land the license.** Create root `LICENSE` (Apache-2.0 verbatim + appendix) and `NOTICE`. Copy both into `packages/{sdk,react,shared}/`.
2. **Flip the three manifests.** In each of `packages/{sdk,react,shared}/package.json`: `"license": "Apache-2.0"`; `publishConfig.registry = "https://registry.npmjs.org"`, `publishConfig.access = "public"`; append `"LICENSE"` and `"NOTICE"` to `files`. Touch nothing else in these files.
3. **Flip Changesets.** `.changeset/config.json`: `"access": "public"`.
4. **Update the pack verifier.** `scripts/verify-pack.mjs`: `REGISTRY` → `https://registry.npmjs.org`; add assertions for `publishConfig.access === 'public'`, `license === 'Apache-2.0'`, tarball contains `package/LICENSE` + `package/NOTICE` byte-identical to the root files; update the header comment; keep all existing assertions (forbidden-content, `workspace:*` rewriting, exports byte-identity). Run `node scripts/verify-pack.mjs` — must pass.
5. **Remove the `.npmrc` routing.** Delete line 4 (`@swiftagent:registry=…`); keep lines 1–3 verbatim. Run `pnpm install` to confirm the workspace still resolves.
6. **Rewrite the normative policy.** `docs/policies/versioning.md` §1 and §6 per Design Notes (posture + stale-fact fix).
7. **Update repository directives + system-state doc.** `AGENTS.md` Delivery convention (registry clause only); `docs/as-built.md` wherever the restricted posture is described as current (grep it for `restricted`, `UNLICENSED`, `npm.pkg.github.com`, `GitHub Packages` and rewrite each active claim).
8. **Rewrite the five README surfaces.** `README.md` blockquote, `docs/quickstart.md` §1, and the three package README Install sections — public-npm install, no token, no `.npmrc` step, no live-version claim. Add a short License section to `README.md` (Apache-2.0, link `LICENSE`, link `CONTRIBUTING.md`).
9. **Retarget the workflows.** `publish-sdks.yml` and `publish-sdks-prerelease.yml`: `workflow_dispatch` trigger, `registry-url: https://registry.npmjs.org`, `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`, permissions trimmed, build step generalized for future publishable packages, comments explaining the decision-4 trigger and the WS-45 hand-off. `ci.yml`: strip the acceptance job's GitHub Packages auth (permissions, setup-node registry/scope, `NODE_AUTH_TOKEN`), update comments.
10. **Update the install harness.** Parameterize the registry, make auth optional, switch to the `SWIFTAGENT_RUN_INSTALL_PROOF` opt-in gate with the loud-skip breadcrumb, update all three files' comments. Validate by RUNNING `pnpm test:acceptance` (Docker required — the root `test/` tree is outside typecheck/lint): the registry-install scenario must loud-skip; every other scenario must pass.
11. **Land contribution terms.** `CONTRIBUTING.md`, `DCO` (1.1 verbatim), `scripts/check-dco.mjs` (+ `--self-test`), `.github/workflows/dco.yml`, and the DCO checklist line amended into the EXISTING `.github/pull_request_template.md`. Author `RELEASING.md`. Sign all of this workstream's commits (`git commit -s`) so the live check passes on its own PR.
12. **Close the sweep by search.** Grep the repository for `npm.pkg.github.com`, `UNLICENSED`, `"access": "restricted"` / `access: restricted`, and `GitHub Packages` (all reference categories per CLAUDE.md rule 10: code, config, string literals, workflows, docs). Every remaining hit must be under a historical tree (`docs/programs/`, `tasks/`) — list the surviving hits and their historical justification in the PR. Any hit on an active surface is a defect in this workstream.
13. **Run the SC-04 dry-run proof.** `pnpm publish --dry-run --no-git-checks` in each of the three package dirs; inspect the packed manifests for concrete `@swiftagent/shared` versions; record outputs.
14. **Finish on the gate.** `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` — all green (deterministic per WS-51).

## Tests

1. **Pack gate (SC-03).** `node scripts/verify-pack.mjs` passes, now asserting: `registry.npmjs.org`, `access: public`, `license: Apache-2.0`, `package/LICENSE` + `package/NOTICE` present and byte-identical to root, no `private`, no forbidden content, `workspace:*` rewritten, exports byte-identity — for all three packages.
2. **Dry-run publish (SC-04).** `pnpm publish --dry-run --no-git-checks` succeeds in `packages/sdk`, `packages/react`, `packages/shared`; the packed manifests of sdk and react show `@swiftagent/shared` at a concrete semver (not `workspace:`-prefixed). Outputs captured in the PR.
3. **DCO self-test (SC-13).** `node scripts/check-dco.mjs --self-test` demonstrates: a commit WITHOUT `Signed-off-by` is rejected (non-zero exit, offending SHA named) and a commit WITH it is accepted.
4. **DCO live run (SC-13).** The `dco.yml` workflow executes on this workstream's own PR and passes (all its commits are signed off) — the check "actually running".
5. **Acceptance suite still green.** `pnpm test:acceptance` (Docker): the registry-install proof loud-skips (breadcrumb visible, `SWIFTAGENT_RUN_INSTALL_PROOF` unset), all other scenarios pass. Optionally prove the opt-in path fails loud (no packages exist on npmjs) WITHOUT recording that failure as a defect — it is the designed pre-release state.
6. **Workflow lint.** Both publish workflows parse (e.g. `gh workflow view` / actionlint if available) and contain NO automatic trigger (`push`/`pull_request` absent; `workflow_dispatch` present). Assert by inspection recorded in the PR.
7. **Sweep proof (SC-11, WS-44's half).** The Step-12 grep output is attached to the PR: zero active-surface hits; historical hits enumerated and untouched (verify `git status` shows no modification under `docs/programs/` or `tasks/` other than this spec's own tree if applicable).
8. **Gate (dependency WS-51).** `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` all pass.

## Acceptance Criteria

1. `packages/{sdk,react,shared}/package.json` each declare `publishConfig.registry = https://registry.npmjs.org`, `publishConfig.access = "public"`, and `"license": "Apache-2.0"`; a repository `LICENSE` (Apache-2.0 with the standard appendix) and `NOTICE` exist; per-package copies ship in the tarballs; no `UNLICENSED` remains on any active surface; `node scripts/verify-pack.mjs` passes with assertions updated to match (SC-03).
2. `.changeset/config.json` has `"access": "public"`, and `.npmrc` no longer routes `@swiftagent:registry` to GitHub Packages — the functional consumer-install path resolves to public npm (SC-03, SC-11).
3. `docs/policies/versioning.md` §1 states the public posture AND no longer claims every package is `"private": true`; `AGENTS.md`'s Delivery convention targets public npm while preserving the every-other-package-private rule; `docs/as-built.md`, `README.md`, `docs/quickstart.md`, and all three package READMEs describe the public install path with no restricted-registry or token instructions, and no surface claims a version already exists on the registry (SC-11).
4. `publish-sdks.yml` and `publish-sdks-prerelease.yml` publish to `registry.npmjs.org` ONLY from an explicit manual `workflow_dispatch`, authenticate via the (owner-provisioned, not-yet-existing) `NPM_TOKEN` secret, and are written so `pnpm changeset publish` will carry `create-swift-agent` once WS-46 adds it without workflow edits; the `ci.yml` acceptance job no longer authenticates to GitHub Packages; nothing was published and no trigger was pressed (SC-04).
5. `pnpm publish --dry-run` (pnpm, not npm) succeeded for all three packages with packed-manifest inspection confirming `workspace:*` → concrete-version rewriting, recorded in the PR (SC-04).
6. `RELEASING.md` documents the single manual trigger as the release path and the owner-owned npm organization/token provisioning as a prerequisite performed outside this workstream (SC-04).
7. `CONTRIBUTING.md` and `DCO` adopt the Developer Certificate of Origin 1.1, require `Signed-off-by` on every commit, state that contributors retain copyright (so relicensing requires their permission), and give the Apache-2.0 §5 no-CLA rationale; NO CLA, signing bot, code of conduct, or issue templates were added (SC-13).
8. A CI check (`scripts/check-dco.mjs` + `.github/workflows/dco.yml`) rejects a PR commit lacking a `Signed-off-by` trailer and accepts one that has it — demonstrated by the committed self-test AND by the workflow actually running on this workstream's PR; the DCO prompt is amended into the EXISTING `.github/pull_request_template.md` with its Description / Linked Workstream / Checklist sections intact and no second template created (SC-13).
9. The acceptance install harness (`install-published.ts`, `install-registry.acceptance.test.ts`, `vitest.acceptance.config.ts`) targets the public registry via a parameterizable `SWIFTAGENT_INSTALL_REGISTRY`, requires no auth token for public registries, and loud-skips behind an explicit opt-in until a published (or WS-45 local-registry) version exists; `pnpm test:acceptance` is green (SC-11).
10. A repository-wide search for `npm.pkg.github.com`, `UNLICENSED`, restricted-access declarations, and GitHub Packages install instructions finds hits ONLY under historical trees (`docs/programs/`, `tasks/`), which are preserved byte-for-byte; the search output is recorded (SC-11).
11. No package's public API surface, exports map, or build output changed; the license choice was not revisited; the npm org/token was not provisioned; the WS-45 harness was not built here; `pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm test` all pass (SC-03, SC-04, dependency WS-51).
