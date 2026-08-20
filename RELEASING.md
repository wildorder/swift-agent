# Releasing

How `@swiftagent/*` packages ship to **public npm** (`registry.npmjs.org`).
There is exactly **one** release path, and it is manual.

## The single release path

The owner triggers the **`Publish SDKs`** workflow
([`.github/workflows/publish-sdks.yml`](./.github/workflows/publish-sdks.yml))
via **`workflow_dispatch`** — once per release, from the Actions tab (or
`gh workflow run "Publish SDKs"`). Nothing publishes automatically: there is no
push- or PR-triggered publish anywhere in the repository (program decision 4 —
the manual trigger *is* the release path, not a gate in front of one).

The dispatched run:

1. Verifies the `NPM_TOKEN` secret exists (fails loud if not — see
   prerequisites).
2. Builds **all** workspace packages (`pnpm build`), so every publishable
   package is covered generically.
3. Applies accumulated changesets (`pnpm changeset version`).
4. Runs `pnpm changeset publish` — which publishes **every non-`private`
   workspace package** whose version is not yet on the registry. Today that is
   `@swiftagent/sdk`, `@swiftagent/react`, and `@swiftagent/shared`; when
   WS-46 adds `create-swift-agent` (public posture, non-private), the same
   dispatch releases it with **no workflow edit**.
5. Commits the version bumps back to the branch.

`workspace:*` dependency ranges are rewritten to concrete semver versions by
pnpm at publish time — the same mechanism `scripts/verify-pack.mjs` verifies on
every CI run via `pnpm pack`.

## Prerequisites (owner-owned, performed OUTSIDE the repo)

These were deliberately **not** performed by the workstream that armed this
pipeline:

1. **Create/claim the npm organization** for the `@swiftagent` scope on
   npmjs.com.
2. **Provision an npm automation token** (type: Automation, publish rights on
   the scope).
3. **Store it as the `NPM_TOKEN` repository secret** in GitHub
   (Settings → Secrets and variables → Actions).

Until all three are done, dispatching either publish workflow fails at the
"Assert NPM_TOKEN is provisioned" step with a clear message. No `@swiftagent/*`
version exists on the public registry until the first dispatch completes.

## Snapshot prereleases

**`Publish SDKs (Snapshot Prerelease)`**
([`.github/workflows/publish-sdks-prerelease.yml`](./.github/workflows/publish-sdks-prerelease.yml))
is also `workflow_dispatch`-only. It publishes ephemeral `0.0.0-pr-<shortsha>`
versions under the **`pr`** dist-tag (never `latest`). The former per-PR
auto-snapshot was retired when publishing moved to public npm: auto-publishing
real, publicly visible versions on every PR is not acceptable.

## Pre-release verification (what runs before anyone publishes)

- **`node scripts/verify-pack.mjs`** (every CI run): packs all three packages
  and asserts tarball contents, `workspace:*` rewriting, public-npm/Apache-2.0
  metadata, and LICENSE/NOTICE presence + byte-identity with the root files.
- **`pnpm publish --dry-run --no-git-checks`** (run per package directory):
  exercises the full pnpm publish path minus the upload.
- **WS-45 local registry (planned hand-off):** a local Verdaccio registry will
  drive the identical acceptance install harness per PR by setting
  `SWIFTAGENT_INSTALL_REGISTRY` + `SWIFTAGENT_RUN_INSTALL_PROOF=1` (see
  `test/acceptance/install-published.ts`), restoring the published-artifact
  install proof without touching public npm.
