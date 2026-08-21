# Runbook: Public Container Image (GHCR)

The `apps/server` image is a first-class operator artifact: built multi-arch
in CI, published automatically to GHCR, and consumed by digest — locally via
`docker-compose.yml` and on managed hosts via the `deploy/` template (WS-47).

## 1. Image name and architectures

- **Name:** `ghcr.io/wildorder/swift-agent` (derived in the workflow from
  `github.repository` so forks publish under their own owner). This is the
  single canonical name used by the publish workflow, the compose pin, this
  runbook, and the WS-47 deploy template.
- **Architectures:** `linux/amd64` and `linux/arm64`, published as one
  manifest list. Docker resolves the right platform automatically.
- **Publisher:** `.github/workflows/publish-image.yml` — automatic on every
  push to `main` (moving `latest` alias) and on `v*` release tags (semver
  aliases). No manual trigger, no approval step; see the workflow header for
  why this is deliberate.
- **Provenance:** the platform's free build provenance/attestation is
  enabled (`provenance: true` + `attest-build-provenance`). No cosign key
  management, no SBOM pipeline.

## 2. Pulling the image

Until the owner performs the one-time visibility step (§5), the GHCR package
is **private** and every pull must authenticate:

- **GitHub Actions:** `docker/login-action` with `registry: ghcr.io`,
  `username: ${{ github.actor }}`, `password: ${{ secrets.GITHUB_TOKEN }}`.
- **Locally:** a classic PAT with `read:packages`:

  ```bash
  docker login ghcr.io -u <github-username>
  # paste the PAT as the password
  docker compose pull
  ```

- **Managed-host deploys (WS-47):** the host's registry-credential
  mechanism with the same `read:packages` PAT — see `deploy/README.md`.

Once the package is public (§5), these credentials become unnecessary and
strangers can pull anonymously. That is a **post-click property**: nothing in
this repository claims the click has happened.

## 3. The digest pin — why never a tag

`docker-compose.yml` pins the server image at its sha256 **manifest-list
digest**:

```yaml
image: ghcr.io/wildorder/swift-agent@sha256:<manifest-list-digest>
```

- GHCR provides **no immutable-tag enforcement** — package versions can be
  removed and replaced, so every tag, `latest` and version tags included, is
  mutable. Tags exist so humans can read them; the only reference that
  cannot drift is the digest.
- The digest pinned is the **manifest-list (image index) digest** — the
  `steps.build.outputs.digest` the publish workflow echoes in its final
  step. A per-platform manifest digest would break the other architecture;
  the index digest resolves per-platform automatically.

## 4. Upgrading

A new publish produces a new digest. Upgrading is an explicit commit:

1. Take the manifest-list digest from the latest `Publish Container Image`
   run (the `Manifest-list digest` notice), or:

   ```bash
   docker buildx imagetools inspect ghcr.io/wildorder/swift-agent:latest
   ```

2. Edit `docker-compose.yml`'s `image:` line to the new digest and commit.

That explicitness is the point — the compose stack never silently changes
what it runs.

## 5. One-time owner step: make the package public

A newly published GHCR package defaults to **private** — packages inherit
repository access *permissions*, not visibility, so the repository being
public changes nothing. GitHub exposes **no API** for changing package
visibility; the only supported mechanism is the UI:

> GitHub → the `swift-agent` package → **Package settings** → **Danger
> Zone** → **Change visibility** → **Public**

- Possible only after the first publish has created the package.
- **Irreversible** once public.
- Performed once, by the owner, as a repository-configuration prerequisite.

Immediately after clicking, verify the anonymous pull path with:

```bash
docker logout ghcr.io
docker pull ghcr.io/wildorder/swift-agent@sha256:<current-pinned-digest>
```

This command ships ready-to-run for the owner; it is **not** executed in CI
and its success is asserted nowhere in this repository.

## 6. Building from source (contributors)

The compose stack pulls by default. To build the server from the working
tree instead:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up --build
```

The `runner` service always builds from source (its builder-stage image
carries the dev toolchain the prod image deliberately prunes).

## 7. Migrations and scaling posture

- The image ships `packages/db/dist/migrate.js` and the `packages/db/drizzle`
  migration folder. The compose stack migrates via `AUTO_MIGRATE=true`;
  deploy surfaces run `node packages/db/dist/migrate.js` as an explicit
  release step instead — see `docs/runbooks/migrations.md`.
- The image must run as a **single instance**: all realtime state is
  process-local, and a second serving instance breaks session invariants
  silently — see `docs/runbooks/realtime-operations.md` §1/§6. Do not scale
  it horizontally.
