# WS-38: Package Publishing Pipeline

## Goal

Make publishing the client packages **reproducible** and **repoint it from public npm to the org's private GitHub Packages registry** (`npm.pkg.github.com`), driven by **Changesets** (config supplied by WS-37). Today `.github/workflows/publish-sdks.yml` publishes `@swiftagent/sdk` and `@swiftagent/react` to **public npm** (`https://registry.npmjs.org`), derives the version from a GitHub release tag, and would be silently blocked anyway because all three packages are marked `"private": true`. This workstream does exactly the following and nothing more:

1. **Fixes package metadata** on the publishable set — `@swiftagent/sdk`, `@swiftagent/react`, and the workspace dep they pull in, `@swiftagent/shared` — so each removes `"private": true`, declares a `files` allowlist, a `publishConfig` pointing at GitHub Packages, and the `repository`/`license`/`description`/`author` fields a published package must carry (SC-04). It does **not** touch the `exports`/`main`/`types` map shape — WS-36 owns that surface.
2. **Adds scope→registry config** to root `.npmrc` (`@swiftagent:registry=https://npm.pkg.github.com`) — the committed mapping only; the auth token is **never** committed and is injected in CI (SC-04).
3. **Rewrites `.github/workflows/publish-sdks.yml`** into a Changesets-driven release that authenticates to GitHub Packages via `setup-node` + `NODE_AUTH_TOKEN=${{ secrets.GITHUB_TOKEN }}` (with `permissions: packages: write`), builds the publishable set, and runs `changeset publish` — preserving idempotency (already-published versions are skipped) and relying on pnpm's automatic `workspace:*`→concrete-version rewrite at publish time (SC-04).
4. **Adds a dry-run verification gate** (a CI step + a documented local command) that `pnpm pack`s the three packages and asserts the tarball contains only `dist` + `README.md` (no `src`/tests/tsconfig), that `workspace:*` deps were resolved to concrete versions in the packed `package.json`, and that the type-declaration outputs (`dist/*.d.ts`) are present alongside the ESM JS (`dist/*.js`) — the "dual = JS + d.ts" outputs (SC-04).
5. **Adds a PR prerelease (snapshot) publish flow** so the three packages are *actually published to GitHub Packages* on pull requests — under a Changesets **snapshot** version (`0.0.0-pr-<shortsha>`) and a distinct dist-tag (`pr`), never touching `latest`. This exists specifically so **WS-42's acceptance test always installs the published packages from `npm.pkg.github.com` (never a local tarball)**, even before a stable version exists on `main`. The stable merge-to-`main` flow (item 3) is unchanged; the snapshot flow reuses the same registry, scope, `publishConfig`, token, and `packages: write` permission model, differing only in version + tag (SC-04, enabling SC-09).

**Scope boundary.** The publishable set is exactly three packages: `@swiftagent/sdk`, `@swiftagent/react`, `@swiftagent/shared` (a transitive workspace dep the other two import). The other six workspace packages (`@swiftagent/api`, `db`, `gateway`, `models`, `observability`, `runtime`, and the `apps/server` app) stay `"private": true` and are **not** published. The finalized public export surface (WS-36) and the Changesets config + versioning policy (WS-37) are **consumed as dependencies, not authored here**.

## Traceability

- **SC-04** — The publishable packages (`@swiftagent/sdk`, `@swiftagent/react`, and their workspace deps) build correct dual ESM + type outputs (`dist/*.js` + `dist/*.d.ts`), declare `files`/`publishConfig`, resolve `workspace:*` to concrete versions at publish, and publish to GitHub Packages (`npm.pkg.github.com`) driven by Changesets, gated by dry-run verification.
- **SC-09** (enabled) — WS-42's acceptance test installs `@swiftagent/*` from the **real** GitHub Packages registry on *every* run, including pull requests, with no local-tarball fallback anywhere. This workstream enables that by publishing a Changesets **snapshot** prerelease (`@swiftagent/*@pr`, version `0.0.0-pr-<shortsha>`) on PR builds; WS-42 owns the install-and-run test itself.
- **SC-10** — Monorepo type-checking, linting, unit tests, and integration tests pass (`pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:integration`) — none of this workstream's metadata/`.npmrc`/workflow changes may regress them.

## Dependencies

- **WS-36 (finalized exports/surface)** — freezes the public API surface and owns the `exports`/`main`/`types` map in each publishable `package.json`. **This workstream MUST NOT alter the `exports` map shape.** It only *adds sibling top-level keys* (`files`, `publishConfig`, `repository`, `license`, `description`, `author`) and *removes* `"private"`. If a merge conflict arises on the `exports` block, WS-36 wins that block. The current maps are: `@swiftagent/sdk` and `@swiftagent/react` each expose a single `"."` entry (`{ types, import }`); `@swiftagent/shared` exposes `"."` **and** `"./redis"`. Whatever WS-36 finalizes those to, the `files: ["dist","README.md"]` allowlist must still ship every path they reference — verify in the pack gate.
- **WS-37 (Changesets config + versioning policy)** — adds `@changesets/cli` as a root devDependency, `.changeset/config.json`, and the root `package.json` scripts this workstream invokes (`changeset`, `changeset version`, `changeset publish`). **This workstream consumes those; it does not author them.** If `.changeset/config.json` or the `changeset publish` script is absent when the build agent starts, WS-37 has not landed — **STOP and report** rather than hand-rolling a Changesets config (a divergent config would fight WS-37). The one thing this workstream must confirm in WS-37's config is that Changesets is told to publish to the same private registry (see Design Notes — `changeset publish` resolves the registry from `publishConfig`/`.npmrc`, so no Changesets-config change is strictly required, but confirm WS-37 did not hardcode `registry.npmjs.org`).

**The build agent MUST confirm WS-36 and WS-37 have landed (finalized `exports` maps present; `.changeset/config.json` + `changeset publish` root script present) before expecting a green publish.** The metadata/`.npmrc`/workflow edits can be authored ahead of a live publish, but a real GitHub Packages publish requires both.

## Context Files (Agent MUST read before implementing)

- `C:\dev\swift-agent\CLAUDE.md` — mechanical overrides and conventions. Especially: **forced verification** (run `pnpm typecheck` / `pnpm lint` / `pnpm test`, and here also the pack dry-run, before claiming done — write-success ≠ compile-success); **grep discipline** (§10 — when repointing the registry, grep separately for `registry.npmjs.org`, `NPM_TOKEN`, `--access public`, `--provenance`, `release:`/`tag_name`, and `"private"` so nothing stale survives); **re-read before edit** (§6/§9). ESM-only (`"type":"module"`), pnpm 9.15.4 workspaces + Turborepo, Node 22, `@swiftagent/*` scope, IDs/Zod conventions (not directly relevant here but do not violate).
- `C:\dev\swift-agent\.github\workflows\publish-sdks.yml` — the **current** public-npm, release-tag-driven publish workflow being rewritten. Full text pasted under *Existing Interfaces to Consume*.
- `C:\dev\swift-agent\.github\workflows\ci.yml` — mirror its setup pattern: workflow-level `env: NODE_VERSION: '22'`, `PNPM_VERSION: '9.15.4'`; `pnpm/action-setup@v4`; `actions/setup-node@v4` with `cache: pnpm`; `pnpm install --frozen-lockfile`; `pnpm build` (with `TURBO_TOKEN`/`TURBO_TEAM` env for remote cache). The pack dry-run gate should be added as a job here (or a small dedicated workflow) so it runs on PRs — see Implementation Steps.
- `C:\dev\swift-agent\packages\sdk\package.json`, `C:\dev\swift-agent\packages\react\package.json`, `C:\dev\swift-agent\packages\shared\package.json` — the three manifests to edit. Full text pasted under *Existing Interfaces to Consume*.
- `C:\dev\swift-agent\.npmrc` — root pnpm config; currently has **no** registry config. Full text pasted below.
- `C:\dev\swift-agent\package.json` (root), `C:\dev\swift-agent\pnpm-workspace.yaml`, `C:\dev\swift-agent\turbo.json` — root workspace/build config; understand where WS-37's `changeset` scripts live and how `build` fans out via Turborepo (`build.dependsOn: ["^build"]`, `outputs: ["dist/**", "tsconfig.tsbuildinfo"]`).
- `C:\dev\swift-agent\tasks\realtime-cloud-delivery\ws-35-deployment-realtime-smoke.md` and `C:\dev\swift-agent\tasks\product-x\ws-12-ci-cd-deployment.md` — reference specs for structure/density. WS-12 §Part D is the *original* (public-npm) publish spec this workstream supersedes.

## Package

`packages/sdk` (`package.json`), `packages/react` (`package.json`), `packages/shared` (`package.json`), `.github/workflows` (`publish-sdks.yml` rewrite; optional pack-gate job in `ci.yml`), root `.npmrc`, and (READMEs) the three publishable packages. No source (`src/`) changes.

## Files Touched

- `packages/sdk/package.json` **(MODIFY)** — remove `"private": true`; add `publishConfig`, `files`, `repository`, `license`, `description`, `author`. Do **not** touch `name`/`version`/`type`/`main`/`types`/`exports`/`scripts`/`dependencies`/`devDependencies` shape (version stays Changesets-managed at `0.0.1`; do not hardcode a bump).
- `packages/react/package.json` **(MODIFY)** — same metadata additions; keep `sideEffects: false`, `peerDependencies.react`, and the `exports` map untouched.
- `packages/shared/package.json` **(MODIFY)** — same metadata additions; keep the two-entry `exports` map (`"."` + `"./redis"`) untouched. `files: ["dist","README.md"]` must cover **both** `dist/index.*` and `dist/redis-client.*` (they both live under `dist/`, so the directory allowlist suffices — verify in the pack gate).
- `packages/sdk/README.md` **(NEW)**, `packages/react/README.md` **(NEW)**, `packages/shared/README.md` **(NEW)** — minimal READMEs. Required because `files` lists `README.md`; without them the packed tarball would silently omit the file (pnpm warns but does not fail) and the published package would have no registry description page. One short paragraph each (name, one-line purpose, install line pointing at GitHub Packages) is sufficient — do not gold-plate.
- `.npmrc` **(MODIFY)** — add the single line `@swiftagent:registry=https://npm.pkg.github.com`. **Do not** add any `//npm.pkg.github.com/:_authToken=...` line (forbidden — token is CI-injected).
- `.github/workflows/publish-sdks.yml` **(MODIFY — full rewrite)** — Changesets-driven, GitHub-Packages-targeted release (see Implementation Steps for the exact new YAML).
- `.github/workflows/ci.yml` **(MODIFY — additive)** — add a `Publish dry-run (pack)` job (or step) that runs the pack gate on every PR/push, so a broken `files`/metadata/`workspace:*`-resolution regression is caught **before** a release. (If the agent prefers a separate `publish-dryrun.yml`, that is acceptable — pick one and keep the assertions identical to the documented local command.)
- `.github/workflows/publish-sdks-prerelease.yml` **(NEW)** — a **sibling** workflow that runs on `pull_request` and publishes a Changesets **snapshot** prerelease of the three packages to GitHub Packages under the `pr` dist-tag (version `0.0.0-pr-<shortsha>`). **Chosen as a separate workflow rather than a PR-triggered job inside `publish-sdks.yml`** because: (a) `publish-sdks.yml` is `on: push: [main]` and intentionally has `contents: write` to commit version bumps back — the snapshot flow must **not** commit anything to git (`changeset version --snapshot` mutates versions ephemerally) and needs only `packages: write`, so keeping least-privilege separation is cleaner than branching permissions/triggers inside one file; (b) it lets the PR job expose a workflow **output** (the published snapshot version) that WS-42's install step can consume, without entangling the stable release job. The stable `publish-sdks.yml` is left exactly as specced.

## Existing Interfaces to Consume

This is the **"before"** state — every statement below matches the files as read on 2026-07-20.

### Current `.github/workflows/publish-sdks.yml` (public npm, release-tag-driven — being replaced)

```yaml
name: Publish SDKs

on:
  release:
    types: [published]

permissions:
  contents: read
  id-token: write # Required for npm provenance

env:
  NODE_VERSION: '22'
  PNPM_VERSION: '9.15.4'

jobs:
  publish:
    name: Publish SDK Packages
    runs-on: ubuntu-latest
    steps:
      - name: Checkout at release tag
        uses: actions/checkout@v4
        with:
          ref: ${{ github.event.release.tag_name }}

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
          registry-url: https://registry.npmjs.org

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Extract version from tag
        id: version
        run: |
          TAG="${{ github.event.release.tag_name }}"
          VERSION="${TAG#v}"
          echo "version=${VERSION}" >> "$GITHUB_OUTPUT"

      - name: Set package versions
        run: |
          pnpm --filter @swiftagent/sdk exec npm version "${{ steps.version.outputs.version }}" --no-git-tag-version --allow-same-version
          pnpm --filter @swiftagent/react exec npm version "${{ steps.version.outputs.version }}" --no-git-tag-version --allow-same-version

      - name: Build SDK packages
        run: |
          pnpm --filter @swiftagent/sdk... build
          pnpm --filter @swiftagent/react... build

      - name: Publish @swiftagent/sdk
        run: |
          PUBLISHED=$(npm view @swiftagent/sdk version 2>/dev/null || echo "")
          if [ "$PUBLISHED" != "${{ steps.version.outputs.version }}" ]; then
            pnpm publish --filter @swiftagent/sdk --no-git-checks --provenance --access public
          else
            echo "⏭ @swiftagent/sdk@${{ steps.version.outputs.version }} already published, skipping."
          fi
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Publish @swiftagent/react
        run: |
          PUBLISHED=$(npm view @swiftagent/react version 2>/dev/null || echo "")
          if [ "$PUBLISHED" != "${{ steps.version.outputs.version }}" ]; then
            pnpm publish --filter @swiftagent/react --no-git-checks --provenance --access public
          else
            echo "⏭ @swiftagent/react@${{ steps.version.outputs.version }} already published, skipping."
          fi
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

**What to carry over vs. drop.** Keep: the workflow-level `env` (`NODE_VERSION`/`PNPM_VERSION`), the `pnpm/action-setup@v4` + `actions/setup-node@v4 (cache: pnpm)` + `pnpm install --frozen-lockfile` + build-before-publish shape, and the **idempotency** idea (skip already-published versions — Changesets does this natively). Drop: `on: release`/tag-name version derivation, the `npm version` step (Changesets owns versioning), `registry-url: https://registry.npmjs.org`, `--access public`, `secrets.NPM_TOKEN`. Reconsider `--provenance`: npm provenance is a **public-npm/sigstore** feature and does **not** apply to GitHub Packages — drop it (and drop the `id-token: write` permission it required), and add `permissions: packages: write` instead.

### Current `packages/sdk/package.json`

```json
{
  "name": "@swiftagent/sdk",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src/",
    "clean": "rm -rf dist .turbo"
  },
  "dependencies": {
    "@swiftagent/shared": "workspace:*",
    "fastify": "^5",
    "jose": "^6",
    "zod": "^3.24",
    "zod-to-json-schema": "^3.24"
  },
  "devDependencies": {
    "@types/node": "^25.5.2",
    "typescript": "^5.5.0",
    "vitest": "^3.0.0"
  }
}
```

### Current `packages/react/package.json`

```json
{
  "name": "@swiftagent/react",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "sideEffects": false,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src/",
    "clean": "rm -rf dist .turbo"
  },
  "dependencies": {
    "@swiftagent/shared": "workspace:*"
  },
  "peerDependencies": {
    "react": "^18 || ^19"
  },
  "devDependencies": {
    "@testing-library/react": "^16.3.2",
    "@types/react": "^19.2.14",
    "happy-dom": "^20.8.9",
    "react": "^19.2.4",
    "react-dom": "^19.2.4",
    "typescript": "^5.5.0",
    "vitest": "^3.0.0"
  }
}
```

### Current `packages/shared/package.json`

```json
{
  "name": "@swiftagent/shared",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./redis": {
      "types": "./dist/redis-client.d.ts",
      "import": "./dist/redis-client.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src/",
    "clean": "rm -rf dist .turbo"
  },
  "dependencies": {
    "ioredis": "^5.0.0",
    "nanoid": "^5",
    "zod": "^3.24"
  },
  "devDependencies": {
    "@types/node": "^25.5.2",
    "typescript": "^5.5.0",
    "vitest": "^3.0.0"
  }
}
```

### Current root `.npmrc`

```ini
strict-peer-dependencies=true
auto-install-peers=true
shamefully-hoist=false
```

### Current root `package.json` (relevant excerpt)

```json
{
  "name": "swift-agent",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.15.4",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "clean": "turbo run clean",
    "test:integration": "vitest run --config test/vitest.integration.config.ts"
  }
}
```

> The root stays `"private": true` — it is the workspace root, never published. Only the three package manifests lose `"private"`. WS-37 adds `changeset`/`changeset version`/`changeset publish` (or `release`) scripts here — do not duplicate them.

### `turbo.json` (build task — relevant excerpt)

```json
{
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", "tsconfig.tsbuildinfo"] }
  }
}
```

> `build` runs `tsc` per package and emits `dist/*.js` (ESM) **and** `dist/*.d.ts` — these are the "dual" outputs SC-04 refers to. There is no CommonJS build and this workstream must **not** add one.

## Design Notes

- **GitHub Packages vs. public npm — why we repoint.** The org already runs a private registry at `npm.pkg.github.com`. These client packages are pre-1.0 (`0.0.1`) and internal-facing; they belong on the private scoped registry, not public npm. GitHub Packages requires the package `name` scope to match the owning org — `@swiftagent` maps to the org that owns this repo, which is exactly the current package scope, so no rename is needed. Access control is by **repo/org membership + registry scope**, not an npm `--access` flag; consequently `access` in `publishConfig` is largely advisory for GitHub Packages (`"restricted"` documents intent). Drop `--access public` and `--provenance` (provenance is a public-npm/sigstore feature that does not apply here).

- **`"private": true` must be removed — it is a hard publish block.** pnpm/npm refuse to publish any package with `"private": true` (the publish is skipped, not errored, which is worse — a green CI run that shipped nothing). All three publishable manifests must drop the field. The **workspace root** `package.json` and the six non-publishable packages keep `"private": true` — that is what keeps them from ever being published. Grep for `"private"` across `packages/*/package.json` after the edit and confirm exactly the six non-publishable packages (+ root + apps) still have it and the three publishable ones do not.

- **`publishConfig` pins the registry per-package (defense in depth).** Add `"publishConfig": { "registry": "https://npm.pkg.github.com", "access": "restricted" }` to each of the three manifests. This makes each package self-describing about where it publishes, independent of `.npmrc` — so a stray local `.npmrc` cannot misdirect a publish to public npm. The root `.npmrc` scope mapping (`@swiftagent:registry=...`) governs **install/resolution** of `@swiftagent/*`; `publishConfig.registry` governs **publish** of that specific package. Set both to the same host.

- **`files` allowlist — ship only `dist` + README.** Add `"files": ["dist", "README.md"]` to each manifest. Without an explicit `files` list, npm packs the whole package directory minus `.npmignore`/defaults — pulling in `src/`, `tsconfig.json`, test files, and `.turbo/`. The allowlist guarantees the tarball is just the compiled `dist/` (JS + d.ts) and the README. `package.json` is always included by npm regardless. `LICENSE` is auto-included by npm if present at the package root; since we declare `license` as an SPDX string and do not ship per-package LICENSE files, the SPDX field suffices — do not add per-package LICENSE files unless the org requires it (out of scope here). The pack gate asserts no `src`/tests leak in.

- **`workspace:*` auto-resolves to a concrete version at publish — do not hand-roll it.** All three publishable packages depend on `@swiftagent/shared: workspace:*` (sdk and react → shared). pnpm rewrites `workspace:*` to the shared package's **actual published version** in the packed `package.json` at `pnpm publish` / `pnpm pack` time (`workspace:*` → e.g. `0.0.1`, `workspace:^` → `^0.0.1`). Do **not** manually replace `workspace:*` with a version literal in the committed source — that breaks local development and duplicates state Changesets/pnpm already own. The dry-run gate's job is to **verify** the rewrite happened: unpack the packed tarball's `package.json` and assert `dependencies["@swiftagent/shared"]` is a concrete semver, not the literal string `workspace:*`. Because `@swiftagent/shared` is itself published in the same run, that concrete version is installable from the same registry — this is why `shared` must be in the publishable set even though it is not a headline SDK.

- **Changesets flow — publish on merge to `main` (chosen), not the PR-bot flow.** Two options exist: (a) the `changesets/action` "Version Packages" PR-bot flow (the action opens/updates a release PR that aggregates changesets; merging it triggers publish), and (b) a straight `changeset publish` run on push to `main`. **Choose (b)** for this workstream: the repo already runs a `dev → staging → main` promotion chain (WS-12) where reaching `main` is the deliberate release gate, so `on: push: branches: [main]` + `changeset version` (to consume accumulated changesets and bump versions) + `changeset publish` is the smallest change that fits the existing model, avoids adding a bot-authored PR loop, and keeps the human release decision at the existing `staging → main` PR. `changeset publish` is **natively idempotent** — it only publishes packages whose current version is not already on the registry, so re-runs are safe (this replaces the old `npm view ... && skip` shell guard). Justification recap: (b) reuses the existing merge-to-`main`-is-release convention, is fewer moving parts, and needs no `GITHUB_TOKEN` PR-write permission beyond `packages: write` (+ `contents: write` only if we let `changeset version` commit the version bumps back — see next note).

- **Prerelease (snapshot) publish on PRs — why it exists and how it differs from stable.** WS-42's acceptance test must install the client packages **from the real GitHub Packages registry on every run** (no local `pnpm pack` tarball fallback anywhere), which requires *something* to be published even on a PR, before any stable version has been cut on `main`. Changesets solves this with **snapshot releases**: `changeset version --snapshot pr` stamps every publishable package with an ephemeral version `0.0.0-pr-<shortsha>` (the `0.0.0-` prefix guarantees it sorts **below** every real release and is never selected by a plain `^`/`latest` range), then `changeset publish --tag pr --no-git-tag` uploads them to the **same** `npm.pkg.github.com` registry under the **`pr` dist-tag**. Because the tag is `pr` (not `latest`), a snapshot publish **never moves `latest`** and never shadows a stable version. Concretely, in a PR job (pnpm equivalent):
  ```bash
  pnpm changeset version --snapshot pr        # 0.0.0-pr-<shortsha> on all three
  pnpm changeset publish --tag pr --no-git-tag  # publish under dist-tag `pr`, no git tag/commit
  ```
  (`--no-git-tag` — or not granting the job `contents: write` — keeps the snapshot flow from writing anything to git; the version bump is discarded when the runner is torn down.) `workspace:*` is still rewritten to a concrete version at publish, so a snapshot `@swiftagent/sdk@0.0.0-pr-<sha>` correctly depends on the snapshot `@swiftagent/shared@0.0.0-pr-<sha>` published in the same run.

- **Dist-tag strategy — `pr`/snapshot vs `latest`.** Stable (merge-to-`main`) publishes land on the default **`latest`** dist-tag via the normal `changeset publish`. PR snapshots land on the **`pr`** dist-tag only. This is the single invariant that keeps the two flows from colliding: consumers doing a normal install always resolve `latest`; only an explicit `@pr` (or an exact `0.0.0-pr-<sha>` pin) opts into a snapshot. The snapshot job must therefore **never** pass a tag that resolves to `latest` and never run a plain `changeset publish` without `--tag pr`.

- **How WS-42 discovers the version/tag to install.** Two supported paths, both pointing at the real registry: (a) **by tag** — WS-42 installs `@swiftagent/sdk@pr` (and `@swiftagent/react@pr`), letting the `pr` dist-tag resolve to whatever snapshot the current PR published; simplest, and correct because each PR re-publishes `pr` before WS-42 runs. (b) **by exact version** — the prerelease workflow exposes a job **output** `snapshot-version` (`0.0.0-pr-<shortsha>`, derived from `git rev-parse --short HEAD`) that a downstream WS-42 job reads via `needs.<job>.outputs.snapshot-version` and installs as an exact pin, avoiding any tag-race if multiple PR runs interleave. Document both; WS-42 picks. Either way the install is `@swiftagent:registry=https://npm.pkg.github.com` + a `read:packages` token — **no tarball path exists**.

- **Retention / cleanup.** Snapshot versions accumulate one `0.0.0-pr-<shortsha>` per PR commit build and are pure throwaway. Because every snapshot sorts below `0.0.1` and is only reachable via the `pr` tag or an exact pin, they never affect stable consumers, so aggressive cleanup is safe. Recommend a periodic GitHub Packages retention policy (e.g. the `actions/delete-package-versions` action on a schedule, or the org's package-retention setting) that deletes prerelease versions matching `0.0.0-pr-*` older than N days. Configuring that retention job is **out of scope for this workstream** (documented so WS-42/ops can add it); this workstream only ensures snapshots are trivially GC-able by construction (distinct version prefix + tag).

- **Where the version bump lands.** With flow (b), `changeset version` mutates the three `package.json` versions + `CHANGELOG.md` files in the CI checkout. Either (i) commit those back to `main` in the same job (`contents: write` permission + a bot commit) so the repo's versions stay in sync, or (ii) let `changeset version` run ephemerally and only `changeset publish` (versions in git drift from the registry). **Choose (i)** — commit the version bump back — so `git` remains the source of truth for "what's published"; this needs `permissions: contents: write` in addition to `packages: write`. Document this. (If WS-37's config or the team prefers the PR-bot flow, that is a WS-37 policy call — this spec picks (b) as the default and the build agent should reconcile with whatever WS-37 actually shipped, not blindly override it.)

- **Token / permission model — never commit a token.** GitHub Packages auth in CI uses `NODE_AUTH_TOKEN`, which `actions/setup-node` (given `registry-url` + `scope`) wires into a generated `.npmrc` at `//npm.pkg.github.com/:_authToken=...`. Supply it from `${{ secrets.GITHUB_TOKEN }}` — the automatic per-run token — with workflow `permissions: packages: write` (and `contents: write` per the note above). The committed root `.npmrc` contains **only** the scope→registry mapping; the `_authToken` line exists solely in the CI-generated `.npmrc` and is never committed. For **cross-repo installs** (a *different* repo installing `@swiftagent/*` from GitHub Packages), `GITHUB_TOKEN` is not sufficient (it is scoped to its own repo) — those consumers need a PAT with `read:packages` (documented as `NPM_PKG_TOKEN`); that is a consumer-side concern, documented here but not configured by this workstream.

- **ESM-only: "dual" = JS + d.ts, not CJS + ESM.** The project is `"type": "module"` end to end. "Dual ESM + type outputs" in SC-04 means the two artifacts `tsc` already emits — `dist/*.js` (ESM) and `dist/*.d.ts` (type declarations). **Do not** add a CommonJS build, a `require` condition in `exports`, or a bundler. The pack gate asserts both `dist/*.js` and `dist/*.d.ts` exist for each package's entry points (`index.js`/`index.d.ts` for all three; additionally `redis-client.js`/`redis-client.d.ts` for `@swiftagent/shared`).

- **Local dev auth for installing `@swiftagent/*` from GitHub Packages.** Document (in the package READMEs and/or a short note): a developer installs by adding `@swiftagent:registry=https://npm.pkg.github.com` (already in the committed `.npmrc`) plus, in their **user-level** `~/.npmrc` (never the repo), `//npm.pkg.github.com/:_authToken=${GITHUB_PKG_TOKEN}` with a PAT bearing `read:packages`. This is the same registry CI publishes to.

## Implementation Steps

Ordered. Verify after each numbered group per CLAUDE.md forced-verification.

1. **Confirm dependencies landed.** Verify WS-36 finalized the `exports` maps (re-read the three `package.json` `exports` blocks — they may differ from the "before" pasted above if WS-36 has merged; **defer to the on-disk shape**) and WS-37 added `.changeset/config.json` + a `changeset publish` (and `changeset version`) root script. If either is missing, **STOP and report** which is incomplete — do not author a Changesets config or a divergent `exports` map.

2. **Edit `packages/shared/package.json` (MODIFY).** Remove `"private": true`. Add (as sibling top-level keys, leaving `exports`/`main`/`types`/`scripts`/`dependencies` untouched):
   ```json
   "description": "Shared types, Zod schemas, ID helpers, and Redis client for Swift Agent.",
   "license": "UNLICENSED",
   "author": "Swift Agent",
   "repository": {
     "type": "git",
     "url": "git+https://github.com/<org>/swift-agent.git",
     "directory": "packages/shared"
   },
   "files": ["dist", "README.md"],
   "publishConfig": {
     "registry": "https://npm.pkg.github.com",
     "access": "restricted"
   }
   ```
   Replace `<org>` with the actual GitHub org that owns the repo (confirm via `git remote -v`; the org must match the `@swiftagent` scope for GitHub Packages). Use `"license": "UNLICENSED"` for a private/internal package (or the org's real SPDX license if one is mandated — confirm; do not invent an open-source license for a `"restricted"` package).

3. **Edit `packages/sdk/package.json` and `packages/react/package.json` (MODIFY).** Same removal of `"private"` and same metadata block, with per-package `description` and `repository.directory` (`packages/sdk`, `packages/react`). Keep `@swiftagent/sdk`'s `dependencies` (incl. `@swiftagent/shared: workspace:*`, fastify/jose/zod/zod-to-json-schema) and `@swiftagent/react`'s `dependencies`/`peerDependencies.react`/`sideEffects: false` **exactly** as-is. Do not touch versions.

4. **Add READMEs (NEW).** Create `packages/sdk/README.md`, `packages/react/README.md`, `packages/shared/README.md` — one short paragraph each (package name, one-line purpose, and an install snippet noting the GitHub Packages registry). Required so the `files: ["dist","README.md"]` allowlist actually ships a README.

5. **Edit `.npmrc` (MODIFY).** Append the scope mapping, leaving the three existing lines intact:
   ```ini
   strict-peer-dependencies=true
   auto-install-peers=true
   shamefully-hoist=false
   @swiftagent:registry=https://npm.pkg.github.com
   ```
   Add **no** `_authToken` line. Confirm `pnpm install --frozen-lockfile` still succeeds with the scope mapping present (it should — resolution of `workspace:*` deps is local; the mapping only affects fetches of `@swiftagent/*` that are *not* in the workspace, of which there are none during dev).

6. **Rewrite `.github/workflows/publish-sdks.yml` (MODIFY — full replacement).** Target shape:
   ```yaml
   name: Publish SDKs

   on:
     push:
       branches: [main]

   # GitHub Packages publish needs packages:write; commit-back of the
   # Changesets version bump needs contents:write.
   permissions:
     contents: write
     packages: write

   concurrency:
     group: publish-sdks
     cancel-in-progress: false

   env:
     NODE_VERSION: '22'
     PNPM_VERSION: '9.15.4'

   jobs:
     publish:
       name: Version & Publish (GitHub Packages)
       runs-on: ubuntu-latest
       steps:
         - name: Checkout
           uses: actions/checkout@v4
           with:
             fetch-depth: 0 # Changesets needs full history to diff versions

         - name: Setup pnpm
           uses: pnpm/action-setup@v4
           with:
             version: ${{ env.PNPM_VERSION }}

         - name: Setup Node.js (GitHub Packages)
           uses: actions/setup-node@v4
           with:
             node-version: ${{ env.NODE_VERSION }}
             cache: pnpm
             registry-url: https://npm.pkg.github.com
             scope: '@swiftagent'

         - name: Install dependencies
           run: pnpm install --frozen-lockfile

         - name: Build publishable packages
           run: pnpm --filter @swiftagent/sdk... --filter @swiftagent/react... build
           env:
             TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}
             TURBO_TEAM: ${{ secrets.TURBO_TEAM }}

         # Consume accumulated changesets: bump versions + changelogs (WS-37 scripts).
         - name: Apply Changesets version bumps
           run: pnpm changeset version

         # changeset publish is idempotent: only versions not already on the
         # registry are published; workspace:* is rewritten to concrete versions
         # by pnpm at publish time.
         - name: Publish to GitHub Packages
           run: pnpm changeset publish
           env:
             NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

         # Commit the version bumps back so git stays the source of truth.
         - name: Commit version bumps
           run: |
             if ! git diff --quiet; then
               git config user.name "github-actions[bot]"
               git config user.email "github-actions[bot]@users.noreply.github.com"
               git add -A
               git commit -m "chore(release): version packages [skip ci]"
               git push
             else
               echo "No version changes to commit."
             fi
   ```
   Notes for the build agent: (a) `pnpm --filter @swiftagent/sdk... --filter @swiftagent/react... build` builds the two SDKs **and their workspace deps** (`...` includes `@swiftagent/shared`), so all three `dist/`s exist before publish. (b) `changeset publish` reads the registry from `publishConfig`/`.npmrc`; `setup-node`'s `registry-url` + `scope` generate the `_authToken` line consumed by `NODE_AUTH_TOKEN`. (c) If WS-37's root script names differ (e.g. a single `release` script wrapping `changeset publish`), call **that** script instead of `pnpm changeset publish` — reconcile with WS-37, do not invent script names. (d) `[skip ci]` on the version-bump commit prevents a CI loop.

7. **Add the pack dry-run gate (MODIFY `ci.yml`, or NEW `publish-dryrun.yml`).** A job that, on every PR/push, runs the pack verification (see Tests for exact assertions). Minimal shape mirroring `ci.yml`'s setup:
   ```yaml
     publish-dryrun:
       name: Publish dry-run (pack)
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: pnpm/action-setup@v4
           with: { version: ${{ env.PNPM_VERSION }} }
         - uses: actions/setup-node@v4
           with: { node-version: ${{ env.NODE_VERSION }}, cache: pnpm }
         - run: pnpm install --frozen-lockfile
         - run: pnpm --filter @swiftagent/sdk... --filter @swiftagent/react... build
           env:
             TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}
             TURBO_TEAM: ${{ secrets.TURBO_TEAM }}
         - name: Pack & verify tarballs
           run: pnpm --filter @swiftagent/sdk --filter @swiftagent/react --filter @swiftagent/shared pack
         # ...followed by the assertion script (Tests §1–§4), e.g. a small node/bash
         # script that untars each *.tgz and checks contents + resolved deps.
   ```
   The same commands must be runnable locally (documented command below), so the gate and local verification never diverge.

8. **Add the PR prerelease (snapshot) publish workflow (NEW `.github/workflows/publish-sdks-prerelease.yml`).** Runs on `pull_request`, publishes a snapshot of the three packages to GitHub Packages under the `pr` dist-tag, and exposes the published version as an output for WS-42. Target shape:
   ```yaml
   name: Publish SDKs (PR Prerelease)

   on:
     pull_request:

   # Snapshot publish needs ONLY packages:write — it must NOT commit to git.
   permissions:
     contents: read
     packages: write

   concurrency:
     group: publish-sdks-prerelease-${{ github.event.pull_request.number }}
     cancel-in-progress: true

   env:
     NODE_VERSION: '22'
     PNPM_VERSION: '9.15.4'

   jobs:
     prerelease:
       name: Snapshot Publish (GitHub Packages, tag=pr)
       runs-on: ubuntu-latest
       outputs:
         snapshot-version: ${{ steps.snap.outputs.version }}
       steps:
         - name: Checkout
           uses: actions/checkout@v4
           with:
             fetch-depth: 0 # Changesets needs history to diff

         - name: Setup pnpm
           uses: pnpm/action-setup@v4
           with:
             version: ${{ env.PNPM_VERSION }}

         - name: Setup Node.js (GitHub Packages)
           uses: actions/setup-node@v4
           with:
             node-version: ${{ env.NODE_VERSION }}
             cache: pnpm
             registry-url: https://npm.pkg.github.com
             scope: '@swiftagent'

         - name: Install dependencies
           run: pnpm install --frozen-lockfile

         - name: Build publishable packages
           run: pnpm --filter @swiftagent/sdk... --filter @swiftagent/react... build
           env:
             TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}
             TURBO_TEAM: ${{ secrets.TURBO_TEAM }}

         # Stamp ephemeral snapshot versions: 0.0.0-pr-<shortsha> on all three.
         - name: Apply snapshot versions
           run: pnpm changeset version --snapshot pr

         - name: Capture snapshot version
           id: snap
           run: echo "version=$(node -p "require('./packages/sdk/package.json').version")" >> "$GITHUB_OUTPUT"

         # Publish under dist-tag `pr`; --no-git-tag => no git writes. Never touches `latest`.
         - name: Publish snapshot to GitHub Packages
           run: pnpm changeset publish --tag pr --no-git-tag
           env:
             NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
   ```
   Notes for the build agent: (a) reconcile the snapshot commands with WS-37's actual script names — if WS-37 wrapped these in a `release:snapshot` script, call that instead of the raw `changeset` invocations (do not invent names). (b) A PR with **no** accumulated changeset files: `changeset version --snapshot` is a no-op on versions unless a changeset exists, which would make the snapshot publish a no-op and starve WS-42. If WS-37's policy allows it, pass `--snapshot pr` with the "empty changeset" tolerance (recent Changesets snapshots every package when at least one changeset is present); otherwise document that WS-42's PRs must include a changeset, or that the snapshot step force-stamps `0.0.0-pr-<sha>` on the three publishable packages directly. Confirm the exact behavior against the installed `@changesets/cli` version rather than assuming. (c) The `snapshot-version` output is what WS-42 consumes for the exact-pin install path; the `pr` dist-tag is the tag-based path.

9. **Grep sweep (CLAUDE.md §10).** After edits, grep the repo for stale public-npm/tag-release artifacts and confirm none remain in shipped config: `registry.npmjs.org`, `NPM_TOKEN`, `--access public`, `--provenance`, `id-token: write`, `github.event.release`, `tag_name`. Confirm `"private"` remains on exactly the non-publishable packages (root, `apps/server`, and the six non-published `packages/*`) and is gone from the three publishable ones. Confirm **no committed file** contains a line matching `//npm.pkg.github.com/:_authToken` or any literal token. For the snapshot workflow specifically: grep `publish-sdks-prerelease.yml` to confirm every `changeset publish` there carries `--tag pr` (never a bare publish that would move `latest`), that the job has `contents: read` (not `write`), and that no snapshot step commits or pushes to git.

10. **Forced verification (CLAUDE.md §4).** Run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, and the pack gate locally. Run `pnpm test:integration` if Docker/Testcontainers is available (per MEMORY: some `@swiftagent/server`/`@swiftagent/api` suite exit-1/failures are **pre-existing** — do not attribute them to this change, but do confirm this change introduces no *new* failures). Report the exact commands run and their results; do not claim done until green (modulo documented pre-existing failures).

## Tests

Publishing workflows are not unit-testable end-to-end without a live registry; verify via the pack dry-run (which exercises everything up to the actual upload) plus static checks.

1. **Pack contents allowlist (SC-04).** Run the documented local command:
   ```
   pnpm --filter @swiftagent/sdk --filter @swiftagent/react --filter @swiftagent/shared pack
   ```
   For each produced `*.tgz`, list its contents (`tar -tzf <file>`) and assert: it contains `package/dist/index.js` and `package/dist/index.d.ts`; for `@swiftagent/shared` it *also* contains `package/dist/redis-client.js` and `package/dist/redis-client.d.ts`; it contains `package/README.md` and `package/package.json`; and it contains **no** `package/src/`, no `*.test.*`/test files, no `tsconfig*.json`, and no `.turbo/`. (Equivalently, `pnpm publish --dry-run --no-git-checks` per package and read its printed file list — either is acceptable; keep CI and local identical.)

2. **`workspace:*` resolved to concrete versions (SC-04).** Untar each SDK tarball and read `package/package.json`; assert `dependencies["@swiftagent/shared"]` is a concrete semver (e.g. `0.0.1` or `^0.0.1`) and **not** the literal `workspace:*`. This proves pnpm's publish-time rewrite fired (the whole reason `@swiftagent/shared` is in the publishable set). Fail the gate if the literal `workspace:*` survives in any packed manifest.

3. **Dual JS + d.ts outputs present (SC-04).** For each package's entry point(s), assert both the ESM JS and the `.d.ts` exist in the tarball (`index.js`+`index.d.ts` ×3; plus `redis-client.js`+`redis-client.d.ts` for shared). Confirm **no** CommonJS artifact (`*.cjs`, no `require` condition added to `exports`) was introduced — the project is ESM-only.

4. **Metadata correctness (SC-04).** Assert each packed `package/package.json` has: **no** `"private"` field; a `publishConfig.registry` of `https://npm.pkg.github.com`; a `files` array containing `dist` and `README.md`; and non-empty `repository`, `license`, `description` fields. Assert the `exports`/`main`/`types` block is byte-identical to the on-disk (WS-36-owned) source — i.e. this workstream did not perturb it.

5. **No committed auth token — security gate.** Grep the entire repo (all tracked files, especially `.npmrc` and every workflow YAML) and assert **no** file contains `_authToken`, a `//npm.pkg.github.com/:_authToken=` line, or any literal npm/GitHub token. The only registry-auth reference permitted in committed files is `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` inside `publish-sdks.yml` (a secret **reference**, not a value). This test MUST fail the build if a token literal is ever committed.

6. **Workflow lint.** `actionlint` (or `yamllint`) the rewritten `publish-sdks.yml`, the new `publish-sdks-prerelease.yml`, and the pack-gate job so the new `permissions`, `setup-node` `registry-url`/`scope`, `changeset` steps, and pack step all parse. Confirm the old `on: release`/`tag_name`/`NPM_TOKEN`/`--access public` constructs are gone.

7. **PR snapshot produces an installable `@swiftagent/*@pr` (SC-09).** Exercise the snapshot flow so its output is a *real, installable* prerelease from GitHub Packages, while proving the stable flow is untouched:
   - **Version stamping (local, no publish):** run the snapshot version step against a scratch checkout (`pnpm changeset version --snapshot pr`, given a changeset present) and assert all three publishable `package.json` versions become `0.0.0-pr-<shortsha>` (matches `/^0\.0\.0-pr-[0-9a-f]{7,}$/`), sorts below `0.0.1`, and that `packages/*/package.json` for the six non-publishable packages are **unchanged**.
   - **Publish targeting (dry-run):** run `pnpm changeset publish --tag pr --no-git-tag --dry-run` (or `pnpm publish --dry-run --tag pr` per package) and assert the printed dist-tag is `pr` and the target registry is `https://npm.pkg.github.com` — never `latest`, never `registry.npmjs.org`. Assert no git tag/commit is produced.
   - **Pack/dry-run contents still hold on the snapshot manifest:** re-run the §1/§3 tarball assertions against a snapshot-versioned pack and confirm contents are identical (only `dist` + `README.md` + `package.json`; both `*.js` and `*.d.ts`; `redis-client.*` for shared; no `src`/tests/CJS).
   - **`workspace:*` still resolves concretely (§2) under snapshot:** assert the packed snapshot `@swiftagent/sdk`/`@swiftagent/react` manifests pin `@swiftagent/shared` to the **same** `0.0.0-pr-<shortsha>` (the snapshot published in the same run), not the literal `workspace:*`.
   - **Stable flow unaffected:** assert `publish-sdks.yml` still runs a plain `changeset publish` (no `--tag pr`) on `push: [main]`, so stable releases land on `latest` exactly as before; the snapshot workflow is the only source of the `pr` tag. (An end-to-end "install `@swiftagent/sdk@pr` from `npm.pkg.github.com` and import it" assertion is **owned by WS-42**; this workstream proves the snapshot is published to that registry under that tag/version so WS-42 can install it.)

8. **Monorepo gates unaffected (SC-10).** `pnpm typecheck`, `pnpm lint`, `pnpm test` pass; `pnpm test:integration` shows no *new* failures beyond the documented pre-existing ones (MEMORY: `@swiftagent/server` exit-1 and 3 `@swiftagent/api` failures are pre-existing). The `.npmrc` scope line and metadata edits must not regress install or build.

## Acceptance Criteria

1. **`"private"` removed from exactly the publishable set.** `packages/sdk/package.json`, `packages/react/package.json`, and `packages/shared/package.json` no longer contain `"private": true`; the workspace root and all non-publishable packages/apps still do (verified by grep). (SC-04)
2. **Publish metadata present on all three.** Each publishable manifest declares `publishConfig: { registry: "https://npm.pkg.github.com", access: "restricted" }`, `files: ["dist","README.md"]`, and non-empty `repository`/`license`/`description`/`author` — added **alongside**, without altering, the WS-36-owned `exports`/`main`/`types` map (byte-identical `exports` block). Each package has a `README.md`. (SC-04)
3. **`.npmrc` scope mapping committed; no token committed.** Root `.npmrc` contains `@swiftagent:registry=https://npm.pkg.github.com` and the three original lines; no committed file anywhere contains an `_authToken` line or literal token (the security gate, Test §5, passes). (SC-04)
4. **Workflow repointed to GitHub Packages + Changesets.** `.github/workflows/publish-sdks.yml` no longer references public npm (`registry.npmjs.org`), `NPM_TOKEN`, `--access public`, `--provenance`, `on: release`/`tag_name`, or `id-token: write`. It triggers on merge to `main`, sets `permissions: { contents: write, packages: write }`, uses `setup-node` with `registry-url: https://npm.pkg.github.com` + `scope: '@swiftagent'`, builds the publishable set before publish, runs the WS-37 Changesets version+publish scripts with `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`, and is idempotent via `changeset publish` (already-published versions skipped). (SC-04)
5. **`workspace:*` auto-resolves at publish.** The dry-run gate confirms each packed SDK tarball's `package.json` has `@swiftagent/shared` pinned to a concrete version, not `workspace:*` (Test §2). No manual version literal was hardcoded in committed source. (SC-04)
6. **Dry-run pack gate green.** The documented local command (`pnpm --filter @swiftagent/sdk --filter @swiftagent/react --filter @swiftagent/shared pack`) and its CI equivalent pass all assertions: only `dist` + `README.md` (+ `package.json`) in each tarball, no `src`/tests/tsconfig; both `dist/*.js` and `dist/*.d.ts` present (incl. `redis-client.*` for shared); no CJS artifact; metadata correct (Tests §1, §3, §4). (SC-04)
7. **ESM-only preserved.** No CommonJS build, no `require` condition, no bundler was introduced; "dual" is satisfied by the existing `tsc` JS + d.ts emit. (SC-04)
8. **Monorepo gates green.** `pnpm typecheck`, `pnpm lint`, `pnpm test` pass and `pnpm test:integration` introduces no new failures beyond documented pre-existing ones; the workflow lints clean under `actionlint`. (SC-10)
9. **PRs publish installable prerelease packages to GitHub Packages under a non-`latest` tag.** A `pull_request` build runs `.github/workflows/publish-sdks-prerelease.yml`, which stamps `0.0.0-pr-<shortsha>` on all three publishable packages (six non-publishable packages untouched) and publishes them to `https://npm.pkg.github.com` under the **`pr`** dist-tag with `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` and `permissions: { contents: read, packages: write }` — writing nothing to git, and never moving `latest`. The workflow exposes the published version as a `snapshot-version` output. The result is that `@swiftagent/sdk@pr` (and `@swiftagent/react@pr`) is installable from the real registry on every PR, so **WS-42 installs from GitHub Packages with no local-tarball fallback**. The stable merge-to-`main` flow (AC-4) is unchanged and remains the only source of `latest`. (SC-04, enabling SC-09)

## Assumptions

- **WS-37 has landed** with `.changeset/config.json` and root `changeset version`/`changeset publish` scripts, and its config does **not** hardcode `registry.npmjs.org` (it resolves the registry from `publishConfig`/`.npmrc`). If not, STOP and report.
- **WS-36 has landed** and the `exports` maps on disk are final; this spec's "before" `exports` blocks may be superseded — defer to on-disk shape.
- The GitHub org owning the repo **is** `@swiftagent` (scope must match org for GitHub Packages); the real org slug is confirmed via `git remote -v` and substituted for `<org>` in `repository.url`.
- The org uses a **private/internal** license posture for these packages (`"license": "UNLICENSED"`); if a specific SPDX license is mandated, use it instead.
- Merge-to-`main` is the intended release trigger (consistent with the WS-12 `dev → staging → main` promotion chain); the version bump is committed back to `main` (`contents: write`). If the team prefers the `changesets/action` PR-bot flow, that is a WS-37 policy decision to reconcile against, not overridden here.
- `secrets.GITHUB_TOKEN` with `packages: write` is sufficient for **same-repo** publish; **cross-repo** consumers need a `read:packages` PAT (`NPM_PKG_TOKEN`) — documented, not configured here.
- **Changesets `--snapshot` is available** in the installed `@changesets/cli` (WS-37) and honors `--tag`/`--no-git-tag` at publish. The snapshot flow assumes a changeset is present on the PR (or WS-37's config force-stamps the publishable set); if snapshotting requires a changeset and none exists, WS-42's PRs must include one — reconcile with WS-37 rather than inventing snapshot behavior.
- **Snapshot version scheme is `0.0.0-pr-<shortsha>` on the `pr` dist-tag**, chosen so prereleases sort below every stable version and are reachable only via `@pr` or an exact pin — never via `latest`. Retention/cleanup of accumulated `0.0.0-pr-*` versions is left to an ops/WS-42 retention policy (out of scope here); this workstream only guarantees they are GC-able by construction.
