# WS-50: Public Container Image

## Goal

Make the `apps/server` image a first-class, operator-facing artifact: build it **multi-arch** (linux/amd64 + linux/arm64) in a GitHub Actions workflow that publishes to **ghcr.io automatically** — on every push to the repository default branch and on release tags, with **no manual trigger and no approval step** — then, in a **staged two-step bootstrap within this workstream**, repoint `docker-compose.yml` from `build:` to `image: ghcr.io/…@sha256:…` pinned at the **manifest-list digest** the first publish produced. Ship the operator documentation (pull, pin, upgrade-by-committing-a-new-digest), the documented **one-time owner UI step** that makes the GHCR package publicly readable, and a **ready-to-run logged-out `docker pull` verification command** the owner runs immediately after clicking — while this workstream's checkpoint **never performs, waits on, or asserts** that click (program decisions 5 and 6).

Three cohesive deliverables:

1. **The publish pipeline.** A new workflow builds `apps/server/Dockerfile` with buildx for `linux/amd64,linux/arm64`, pushes to `ghcr.io`, emits version tags plus a moving tag as human-readable **aliases** (with the explicit caveat that GHCR tags — version tags included — are mutable), and enables the platform's free provenance/attestation. Publishing is automatic because the image commits to no API surface and its references are replaceable; the licence concern is handled causally — this workstream depends on WS-44, so Apache-2.0 is in the tree before any image publishes.
2. **The digest-pinned compose.** After the first publish exists, a second commit repoints the root `docker-compose.yml` (as repaired by WS-43) from `build:` to the published image at its sha256 **manifest-list digest** — never a tag — with a documented compose override/profile so contributors can still build from source. Until the owner's visibility click, CI compose pulls authenticate to GHCR with documented registry credentials.
3. **Equivalence and documentation.** A pulled image (pulled with documented registry credentials) starts, migrates, and serves REST + WebSocket identically to a locally built one, proven against the WS-43 smoke check. README/self-host docs cover pull, pin, upgrade, the one-time visibility step as a repository-configuration prerequisite, and the post-click anonymous-pull verification command.

This workstream changes **no** Dockerfile build strategy, **no** runtime code, and **nothing** under `infra/` or the ECR-based AWS workflows.

## Traceability

- **SC-14** — A multi-arch (linux/amd64 + linux/arm64) `apps/server` image builds and publishes to ghcr.io automatically from a workflow requiring no manual trigger, and a pulled image (pulled with documented registry credentials until the owner's visibility click) starts, migrates, and serves REST + WebSocket identically to a locally built one.
- **SC-15** — `docker-compose.yml` consumes the published ghcr.io image pinned at its sha256 manifest-list digest, adopted via the staged bootstrap; the one-time owner UI visibility step is documented together with a ready-to-run logged-out `docker pull` verification command; every in-program consumer authenticates before the click; a clean-checkout run pulls rather than builds; a documented override still lets contributors build locally.
- **Gate** — `pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm test` all green at the checkpoint.

## Dependencies

- **WS-43 — Local Stack Coherence.** Provides the **repaired** `docker-compose.yml` (single listener on `API_PORT` 3000; correct `PUBLIC_WEBSOCKET_URL`; no phantom 3001 port), the **self-provisioning local bootstrap** (model config, workspace, dev API key, tool-bearing agent, runner keys, deterministic tool-calling fixture), and the **compose smoke check** that asserts `tool_call_started` and `tool_call_completed` with no pre-supplied `SMOKE_API_KEY`. WS-50 repoints that repaired compose from `build:` to `image:` and reuses that smoke check for the pulled-image equivalence proof. WS-50 does **not** repair ports, `PUBLIC_WEBSOCKET_URL`, or the bootstrap — it consumes them.
- **WS-44 — Public Release Readiness.** Guarantees the repository `LICENSE` (Apache-2.0) and public posture metadata are **in the tree before any image publishes** — the causal replacement for a manual approval gate. WS-50 must not start publishing until WS-44 has landed.

## Context Files (Agent MUST read before implementing)

- `C:\dev\swift-agent\CLAUDE.md` — conventions (forced verification via the four gate commands; grep every reference when touching a name; phased execution).
- `C:\dev\swift-agent\docs\programs\oss-direction-manifest.json` — canonical scope: `workstreams[WS-50]`, `successCriteria[SC-14, SC-15]`, `constraints.artifactAudience`, `constraints.ghcrVisibility` (decisions 5 and 6), `outOfScope[]`.
- `C:\dev\swift-agent\apps\server\Dockerfile` — the build being published: two-stage (builder runs `pnpm turbo run build --filter=@swiftagent/server...`; runner copies dist + `packages/db/drizzle` and runs `pnpm install --frozen-lockfile --prod`), `EXPOSE 3000`, `HEALTHCHECK` via `wget http://localhost:3000/health`, `CMD ["node", "apps/server/dist/main.js"]`. Do NOT change its build strategy or the `--prod` prune beyond what multi-arch requires.
- `C:\dev\swift-agent\docker-compose.yml` — the file this workstream repoints. **As of authoring it is still the pre-WS-43 broken state** (`build:`, ports `3000` + `3001`, `PUBLIC_WEBSOCKET_URL: ws://localhost:3001`); re-read it after WS-43 lands and repoint the repaired version. The `swift-agent` service's `build:` block becomes `image: ghcr.io/…@sha256:…`.
- `C:\dev\swift-agent\.github\workflows\deploy-dev.yml` — the existing **ECR** image build for AWS dev; UNTOUCHED by this program. Read it only to confirm the new GHCR workflow does not collide (different registry, different trigger semantics) and to see the migration-as-release-step pattern (`node packages/db/dist/migrate.js`).
- `C:\dev\swift-agent\.github\workflows\publish-sdks.yml` — contrast case: npm release is manual `workflow_dispatch` after WS-44; the image workflow is deliberately automatic. Do not copy its trigger.
- `C:\dev\swift-agent\apps\server\src\main.ts` (around line 99) — the single listener on `API_PORT` serving REST + WebSocket; the equivalence check exercises both on port 3000.
- `C:\dev\swift-agent\apps\server\src\config.ts` (line 130) — `AUTO_MIGRATE` is read from env (`'true'`); the compose stack migrates via this flag, and the pulled image must honor it identically.
- `C:\dev\swift-agent\docs\runbooks\migrations.md` — forward-only migrations, `node packages/db/dist/migrate.js` as the single schema path, drift preflight. Cite it in operator docs; the image ships `packages/db/dist/migrate.js` and `packages/db/drizzle` so operators can run migrate as an explicit step too.
- `C:\dev\swift-agent\docs\runbooks\realtime-operations.md` — §1 and §6 single-instance posture; the operator docs this workstream writes must not imply the image can be scaled horizontally.
- `C:\dev\swift-agent\test\smoke\realtime-smoke.ts` — the smoke-check shape (bounded waits, ChatEvent assertions) that WS-43 extends for compose; the pulled-image equivalence check runs the WS-43 compose smoke against a stack whose server container is the **pulled** image.
- `C:\dev\swift-agent\README.md` — where operator docs and the self-host section land ("Self-hosting" ladder table; the `docker compose up` rung). WS-49 owns the program-wide documentation pass; WS-50 adds only the image-operator content.
- `C:\Users\tocon\.claude\projects\C--dev-swift-agent\memory\MEMORY.md` — note "Workspace deps must be declared": undeclared `@swiftagent/*` imports pass CI (tsconfig paths) but crash the `--prod`-pruned production image with `ERR_MODULE_NOT_FOUND`. The pulled-image equivalence check is exactly the net that catches this class of defect — do not weaken it.

## Package

`apps/server` (image source, unmodified), `.github/workflows` (NEW workflow), root `docker-compose.yml` + a compose override file, `docs/` and `README.md` (operator documentation).

## Files Touched

- `.github/workflows/publish-image.yml` **(NEW)** — the GHCR publish workflow: triggers `push: branches: [<default branch>]` and `push: tags: ['v*']` (verify the actual default branch with `gh repo view --json defaultBranchRef` before hardcoding — the repo has both `dev` and `main`; `publish-sdks.yml` treats `main` as the release branch). NO `workflow_dispatch`, NO `environment:` approval. `permissions: packages: write, contents: read, id-token: write, attestations: write`.
- `docker-compose.yml` **(MODIFY, second stage only)** — `swift-agent` service: `build:` block replaced by `image: ghcr.io/<owner>/<image>@sha256:<manifest-list-digest>`. Everything else (env, healthchecks, depends_on — as repaired by WS-43) unchanged.
- `docker-compose.build.yml` **(NEW)** — contributor override restoring `build: { context: ., dockerfile: apps/server/Dockerfile }`; documented as `docker compose -f docker-compose.yml -f docker-compose.build.yml up --build`. (A compose `profiles:` variant is acceptable instead; pick one and document it.)
- `docs/runbooks/container-image.md` **(NEW)** — operator runbook: pull, digest pin, upgrade path (commit a new digest), tag-alias mutability caveat, registry-credential instructions for authenticated pulls, the one-time visibility UI step, and the ready-to-run logged-out verification command. Match the numbered-section house style of `docs/runbooks/migrations.md`.
- `README.md` **(MODIFY)** — Self-hosting section: the `docker compose up` rung now pulls the published image (stated as: authenticated in-program, credential-free for strangers **once the owner has performed the documented visibility click**); link the runbook.
- `.github/workflows/ci.yml` **(MODIFY, if CI runs the compose smoke)** — wherever CI brings up the compose stack after the repoint, add a `docker/login-action` step against `ghcr.io` using `GITHUB_TOKEN` so CI compose pulls authenticate (decision 6). Do not add an anonymous-pull assertion anywhere.

## Existing Interfaces to Consume

**The image build source** (`apps/server/Dockerfile`) — published as-is; note the `--prod` prune and the migrate entry the image carries:

```dockerfile
# Runner stage (excerpt)
COPY --from=builder /app/packages/db/dist packages/db/dist
COPY --from=builder /app/packages/db/drizzle packages/db/drizzle
RUN pnpm install --frozen-lockfile --prod
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1
CMD ["node", "apps/server/dist/main.js"]
```

**The compose service being repointed** (`docker-compose.yml`, current pre-WS-43 state shown; the repoint applies to the WS-43-repaired version):

```yaml
swift-agent:
  build:
    context: .
    dockerfile: apps/server/Dockerfile
  # after WS-50 stage 2:
  # image: ghcr.io/<owner>/<image>@sha256:<manifest-list-digest>
```

**`AUTO_MIGRATE`** (`apps/server/src/config.ts:130`) — `const autoMigrate = env['AUTO_MIGRATE'] === 'true';` — the compose stack's migration mechanism; unchanged and honored identically by the pulled image.

**The migrate release step** (per `docs/runbooks/migrations.md` and `deploy-dev.yml`) — `node packages/db/dist/migrate.js`, present inside the image at `/app/packages/db/dist/migrate.js`.

**The ECR path** (`.github/workflows/deploy-dev.yml`) — `docker build … $ECR_REGISTRY/swiftagent/server:dev-$SHA` on push to `dev`; continues unchanged and is not multi-arch. Do not modify it.

## Design Notes

- **Image name.** Use `ghcr.io/${{ github.repository_owner }}/swift-agent-server` or `ghcr.io/${{ github.repository }}` — pick ONE, use it everywhere (workflow, compose pin, docs, WS-47 consumes it). The program docs refer to the package under `wildorder/swift-agent`; derive the name from `github.repository` rather than hardcoding the owner so forks build cleanly. Record the final name in the runbook — WS-47 depends on it.
- **Multi-arch mechanics.** `docker/setup-qemu-action` + `docker/setup-buildx-action` + `docker/build-push-action` with `platforms: linux/amd64,linux/arm64`. The Dockerfile is `node:22-alpine`-based and needs **no change** for arm64 (no native build steps beyond what pnpm handles per-platform); if a native dependency surfaces during the arm64 build, fix it with the minimal buildx-level accommodation — changing the build strategy or the `--prod` prune is excluded. The arm64 leg under QEMU is slow; enable GHA cache (`cache-from/cache-to: type=gha`) to keep it tolerable.
- **The digest that matters is the MANIFEST-LIST digest.** `docker/build-push-action`'s `steps.<id>.outputs.digest` on a multi-platform push IS the manifest-list (image index) digest — that is the value the compose pin uses. Do not pin a per-platform manifest digest: it would break the other architecture. Compose resolves `image: …@sha256:<index-digest>` to the right platform automatically.
- **Tag strategy — aliases only.** Publish `latest` (moving, tracks default branch) and `vX.Y.Z` (on release tags) via `docker/metadata-action`. Document explicitly: **GHCR provides no immutable-tag enforcement — package versions can be removed and replaced, so every tag, version tags included, is mutable. The only reference that cannot drift is the sha256 manifest-list digest.** Tags exist so humans can read them; the pin is never a tag.
- **Staged bootstrap — publish first, pin second, same workstream.** The digest does not exist until the first push. Sequence: (1) land `publish-image.yml`, let it run on the default branch, capture the manifest-list digest from the run output (or `docker buildx imagetools inspect`); (2) a second commit repoints `docker-compose.yml` to that digest and adds the build override. Both commits belong to this workstream. The documented upgrade path forever after is: a new publish produces a new digest → commit the new digest. That explicitness is the point.
- **Automatic publish is deliberate.** The npm release gate protects a semver API commitment; a container image commits to no API surface and its references are replaceable, so it publishes with no trigger and no approval. Do NOT add `workflow_dispatch`-only triggers, `environment:` protection rules, or approval steps. The Apache-2.0-before-publish requirement is satisfied causally by the WS-44 dependency, not procedurally.
- **Visibility: document, never perform or assert (decisions 5 and 6).** A newly published GHCR package defaults to **private** — packages inherit repository access *permissions*, not visibility, so the repository being public changes nothing. GitHub exposes **no API operation** to change package visibility (the REST packages API offers list/get/delete/restore/version only) — do not script `gh api` calls for it. The one supported mechanism is the manual UI step **Package settings → Danger Zone → Change visibility → Public**, irreversible once public, possible only after the first push creates the package. Document it as a one-time repository-configuration prerequisite the owner performs after the first publish. The checkpoint does not block on, wait for, or assert the outcome of that click, and nothing in this workstream claims an anonymous pull succeeded.
- **The verification command ships; it does not run as acceptance evidence.** The runbook carries a ready-to-run, logged-out check for the owner to run immediately after clicking, e.g.:

  ```bash
  docker logout ghcr.io
  docker pull ghcr.io/<owner>/<image>@sha256:<digest>
  ```

  Deliver and document it; do NOT execute it in CI or cite its success anywhere.
- **Authenticated pulls for every in-program consumer.** Until the click, every pull authenticates: the equivalence check and CI compose pulls use `docker login ghcr.io` with `GITHUB_TOKEN` (in Actions) or a classic PAT with `read:packages` (locally); the WS-47 deploy uses the host's registry-credential mechanism. Document all three in the runbook, and state that the credentials become unnecessary once the package is public.
- **Provenance at no extra cost.** Set `provenance: true` (default `mode=min` is fine) on `build-push-action`, and optionally `actions/attest-build-provenance` — both platform-free. NO cosign key management, NO SBOM pipeline.
- **Why the equivalence check is load-bearing.** The `--prod` prune means an undeclared `@swiftagent/*` workspace dependency passes `pnpm typecheck`/CI (tsconfig paths resolve it) but crashes the production image at startup with `ERR_MODULE_NOT_FOUND` (this has happened; see the workspace-dep memory note). Pulling the published image and running the full WS-43 smoke against it — start, migrate, streaming turn with tool events over REST + WS — is the only check in the program that exercises the artifact strangers actually receive.
- **Default branch caution.** Active development happens on `dev`; `publish-sdks.yml` releases from `main`. Verify the repository's configured default branch before wiring the trigger, and state in the workflow comment which branch publishes the moving tag.

## Out of Scope (restating every manifest exclude)

- Gating the image push behind a manual trigger or human approval — deliberately authorized; the npm gate exists to protect a semver API commitment and does NOT transfer to a build artifact whose tags are replaceable.
- Treating GitHub REPOSITORY visibility as sufficient or necessary for package visibility — the repository is already public, but packages default private regardless; only the documented one-time package-settings UI step makes the package pullable (decision 5).
- Attempting to change package visibility via `gh api` or any REST call — no such operation exists in GitHub's packages API; do not script what the platform only offers in the UI.
- Waiting on the owner's visibility click, running the anonymous-pull verification as acceptance evidence, or claiming anywhere that the anonymous pull succeeded — the click and its verification are the owner's post-program actions (decision 6).
- Publishing any image other than `apps/server` (no playground, scaffold, or migration images).
- Changing `apps/server/Dockerfile`'s build strategy or the `--prod` prune behaviour beyond what multi-arch requires.
- Signing infrastructure beyond what the platform offers for free (no cosign key management, no SBOM pipeline).
- Repairing compose ports, `PUBLIC_WEBSOCKET_URL`, or the local bootstrap (owned by WS-43) — this consumes that corrected wiring.
- Any change under `infra/` or to the ECR-based AWS deploy workflows, which continue unchanged.

## Implementation Steps

1. **Author `.github/workflows/publish-image.yml`.** Triggers: push to the verified default branch + `v*` tags. Jobs: checkout → `docker/setup-qemu-action` → `docker/setup-buildx-action` → `docker/login-action` (ghcr.io, `GITHUB_TOKEN`) → `docker/metadata-action` (tags: `latest` on default branch, semver on tags) → `docker/build-push-action` with `file: apps/server/Dockerfile`, `context: .`, `platforms: linux/amd64,linux/arm64`, `push: true`, `provenance: true`, GHA cache. Echo `steps.build.outputs.digest` prominently in the run log (this is the manifest-list digest the pin needs).
2. **Land the workflow and obtain the first publish.** Merge; confirm the run pushes both architectures (`docker buildx imagetools inspect ghcr.io/<owner>/<image>:latest` shows a manifest list with amd64 + arm64 entries). Record the manifest-list digest.
3. **Pulled-image equivalence check (authenticated).** With `docker login ghcr.io` (documented credentials): run the WS-43 compose stack with the server service overridden to the pulled image (`image: …@sha256:<digest>`), verify it starts, migrates (AUTO_MIGRATE and/or explicit `node packages/db/dist/migrate.js`), serves `/health` = ok, and passes the WS-43 compose smoke (streaming turn asserting `tool_call_started` + `tool_call_completed`) — then run the identical smoke against a locally built image and confirm identical outcomes. Wire this as a CI job or a committed script; it must authenticate and must not depend on package visibility.
4. **Stage 2 — commit the digest pin.** Repoint `docker-compose.yml`'s `swift-agent` service from `build:` to `image: ghcr.io/<owner>/<image>@sha256:<digest>`; add `docker-compose.build.yml` (or a profile) restoring source builds; add the ghcr login step to any CI job that now pulls via compose.
5. **Author `docs/runbooks/container-image.md`.** Sections: image name + supported architectures; pull (authenticated pre-click, anonymous post-click — stated as exactly that); the digest pin and why tags never satisfy it; upgrade = commit a new digest; registry credentials for in-program consumers (Actions `GITHUB_TOKEN`, local PAT with `read:packages`, WS-47 host credentials — cross-reference); the ONE-TIME owner visibility step (Package settings → Danger Zone → Change visibility → Public; no API exists; irreversible; only possible after first publish); the ready-to-run logged-out `docker pull` verification command; build-from-source override; single-instance cross-reference to `realtime-operations.md` §6.
6. **Update `README.md`.** Self-hosting section: `docker compose up` now pulls the published, digest-pinned image; link the runbook; note the contributor build override. Keep wording consistent with decision 6 (credential-free pull is a post-click property; never claim it already holds).
7. **Verify the gate.** `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` all green; grep for every reference to the old `build:`-based compose flow (docs, CI, scripts — direct references, string literals, workflow steps) and reconcile each.

## Tests

1. **Workflow publish proof (CI evidence).** The `publish-image.yml` run on the default branch succeeds with no manual input; its log shows a multi-platform push and the manifest-list digest (SC-14).
2. **Multi-arch manifest assertion.** `docker buildx imagetools inspect` (scripted, authenticated) on the published reference shows entries for both `linux/amd64` and `linux/arm64` (SC-14).
3. **Pulled-image equivalence (authenticated).** The committed check from step 3: pulled image starts → migrates → `/health` ok → WS-43 compose smoke passes with both tool events; identical result against the locally built image (SC-14).
4. **Compose pin shape test.** A lightweight repo test (or CI grep step) asserting `docker-compose.yml`'s server service uses `image: ghcr.io/…@sha256:` and contains no `build:` block and no tag-based `image:` reference (SC-15).
5. **Build-from-source override.** `docker compose -f docker-compose.yml -f docker-compose.build.yml build` succeeds locally (SC-15).
6. **Gate.** `pnpm build && pnpm typecheck && pnpm lint && pnpm test` green.

## Acceptance Criteria

1. A GitHub Actions workflow builds `apps/server/Dockerfile` and publishes to ghcr.io **automatically** on the default branch and on release tags — no `workflow_dispatch`-only trigger, no environment approval — and it ran only after WS-44's Apache-2.0/LICENSE landed (SC-14).
2. The published image is multi-arch: the manifest list contains `linux/amd64` and `linux/arm64` (SC-14).
3. A pulled image — pulled with the **documented registry credentials** — starts, migrates, and serves REST + WebSocket identically to a locally built one, proven by the WS-43-derived smoke asserting `tool_call_started` and `tool_call_completed` (SC-14).
4. `docker-compose.yml` pins `image: ghcr.io/…@sha256:<manifest-list-digest>` — the digest, never a tag — committed as the second stage of the staged bootstrap after the digest existed; the documented upgrade path is committing a new digest (SC-15).
5. Version tags and a moving tag are published as human-readable aliases with the documented caveat that GHCR tags (version tags included) are mutable and only the digest cannot drift (SC-15).
6. A documented compose override/profile lets contributors build from source, and a clean-checkout `docker compose up` pulls rather than builds — authenticated in-program, and stated in the docs as credential-free for strangers once the owner has performed the visibility click (SC-15).
7. The one-time owner UI step (Package settings → Danger Zone → Change visibility → Public) is documented as a repository-configuration prerequisite performed after the first publish, together with the ready-to-run logged-out `docker pull` verification command; no workstream artifact performs, waits on, or asserts the click or the anonymous pull's success (SC-15, decisions 5 and 6).
8. Every in-program consumer that pulls before the click (equivalence check, CI compose pulls, the WS-47 deploy) has documented GHCR credentials, and the docs state they become unnecessary post-click (SC-14, SC-15).
9. Free platform provenance/attestation is enabled; no cosign keys, no SBOM pipeline; the Dockerfile's build strategy and `--prod` prune are unchanged; `infra/` and the ECR workflows are untouched.
10. `pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm test` all pass (gate).
