# WS-47: One-Click Deploy Template

## Goal

Let an adopter deploy the Swift Agent runtime into **their own managed-host account** from a README button or a single command — on **exactly one pinned instance** with managed Postgres and Redis attached, running the **published WS-50 GHCR image** (never building from source on the host), applying **forward-only migrations as an explicit release step**, and passing a health check.

Three cohesive deliverables:

1. **A recorded host decision.** A documented comparison of **Fly.io vs Railway** against fixed criteria — managed Postgres + Redis, WebSocket support, single-instance guarantee, idle cost, template format — with the decision recorded **before** any implementation. A host that cannot guarantee a single running instance is disqualified outright.
2. **The deploy template.** Host configuration (`fly.toml` / `railway.json` or equivalent) that deploys `image: ghcr.io/…@sha256:…` from WS-50 — pulling with **documented registry credentials** until the owner's one-time GHCR visibility click makes the package public (decision 6), so the deploy never depends on package visibility — provisions managed Postgres and Redis, runs `node packages/db/dist/migrate.js` as the release step, pins **exactly one instance with autoscaling disabled** (rationale cited from `docs/runbooks/realtime-operations.md` §6), and passes the `/health` check. Plus complete secret/env documentation including a correct public `wss://` `PUBLIC_WEBSOCKET_URL`.
3. **Proof and docs.** A reproducible fresh-deploy verification, single-instance behaviour verified **by observation across a rolling deployment and a restart** (not by configuration value alone — that is precisely when a managed host silently runs two), a README deploy button, and a self-host guide section.

This workstream deploys the reusable **template**, not the playground (WS-49 deploys the demo instance using this template). Nothing under `infra/` changes.

## Traceability

- **SC-07** — The deploy template provisions the runtime with managed Postgres and Redis on the chosen host, applies forward-only migrations as an explicit release step, and passes a health check, reproducibly from the documented button or command; the host pulls the image with documented registry credentials until the owner's visibility click, and the docs say those credentials become unnecessary post-click.
- **SC-12** — The template (one of the exactly two managed, publicly-hosted surfaces this program creates) pins to exactly one running instance with autoscaling disabled, verified by observing a single serving instance across a rolling deployment and a restart, with documentation citing `docs/runbooks/realtime-operations.md` §6.
- **Gate** — `pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm test` all green at the checkpoint.

## Dependencies

- **WS-43 — Local Stack Coherence.** Provides the corrected env wiring the template reuses: the **single listener on `API_PORT` (3000)** serving REST + WebSocket, a correct `PUBLIC_WEBSOCKET_URL` shape, `AUTO_MIGRATE` semantics, and the smoke pattern that proves a streaming turn. The template's env block mirrors that corrected wiring rather than re-deriving it. WS-43's **local bootstrap (dev API key, fixture provider, seeded agent) must be inert or absent** in this deploy — the template carries its own provisioning story (an operator brings real provider keys and creates their own workspace/agents).
- **WS-50 — Public Container Image.** Provides the published GHCR image at a sha256 manifest-list digest, the image name, and the documented registry-credential story for authenticated pulls. The template deploys that image by digest and never builds from source on the host.

## Context Files (Agent MUST read before implementing)

- `C:\dev\swift-agent\CLAUDE.md` — conventions (forced verification; phased execution; grep every reference).
- `C:\dev\swift-agent\docs\programs\oss-direction-manifest.json` — canonical scope: `workstreams[WS-47]`, `successCriteria[SC-07, SC-12]`, `constraints.singleInstance`, `constraints.forwardOnlyMigrations`, `constraints.ghcrVisibility`, `outOfScope[]`.
- `C:\dev\swift-agent\docs\runbooks\realtime-operations.md` — **read §1 and §6 closely**: all realtime state (connections, replay buffers, session locks, in-flight runs) is process-local; Redis pub/sub is wired but dormant; ECS is pinned to `desired_count = 1` because a second task breaks session invariants with no error. This is the rationale the template's docs must cite verbatim-by-reference.
- `C:\dev\swift-agent\docs\runbooks\migrations.md` — forward-only migrations; `node packages/db/dist/migrate.js` is the single schema path with a drift preflight that refuses to apply on divergence; deploy surfaces run migrate as an **explicit release step**. The template's release command is exactly this.
- `C:\dev\swift-agent\tasks\oss-direction\ws-50-public-container-image.md` — the image name, digest-pin convention, and registry-credential documentation this template consumes.
- `C:\dev\swift-agent\apps\server\Dockerfile` — the deployed artifact: `EXPOSE 3000`, `HEALTHCHECK` on `/health`, `CMD node apps/server/dist/main.js`, migrate entry at `packages/db/dist/migrate.js` inside the image. The host health check and release command map onto these.
- `C:\dev\swift-agent\apps\server\src\main.ts` (around line 99) — single listener on `API_PORT`; the host must route BOTH HTTP and WebSocket upgrade traffic to that one port.
- `C:\dev\swift-agent\apps\server\src\config.ts` — the env surface the template must document: `DATABASE_URL`, `REDIS_URL` (optional), `API_PORT`, `CLIENT_JWT_SECRET`, `PUBLIC_WEBSOCKET_URL`, provider keys (`OPENAI_API_KEY`/`ANTHROPIC_API_KEY`/`GOOGLE_API_KEY`), `AUTO_MIGRATE` (line 130 — but the template uses the explicit release step, see Design Notes).
- `C:\dev\swift-agent\docker-compose.yml` — the WS-43-repaired + WS-50-repointed local wiring the template's env block mirrors (service-to-service URLs become managed-service URLs).
- `C:\dev\swift-agent\.github\workflows\deploy-dev.yml` — the AWS/ECR path that continues unchanged; read only to avoid collision and to see the migrate-as-release-step precedent.
- `C:\dev\swift-agent\test\smoke\realtime-smoke.ts` — the bounded smoke-check shape (`SMOKE_BASE_URL` + API key → POST /v1/sessions → WS stream assertions) reusable for the fresh-deploy verification.
- `C:\dev\swift-agent\README.md` — Self-hosting ladder table where the deploy button and self-host guide section land.

## Package

`deploy/` (NEW directory — host config, comparison doc, verification script), `docs/` (self-host guide content), `README.md`. `apps/server` is consumed unchanged (no source changes).

## Files Touched

- `deploy/HOST-COMPARISON.md` **(NEW)** — the Fly.io vs Railway comparison against the five fixed criteria, with the decision and its date recorded. Written and committed **before** any host config.
- `deploy/fly.toml` (or `deploy/railway.json`/equivalent per the decision) **(NEW)** — the host configuration: GHCR image by digest, single-instance pinning, autoscaling disabled, health check on `/health`, WebSocket-compatible service config, migrate release command.
- `deploy/README.md` **(NEW)** — the template's own guide: prerequisites (host account, GHCR registry credentials until the click — cross-reference the WS-50 runbook), the one-command/button deploy procedure, managed Postgres + Redis provisioning commands, the full secret/env table (including how to construct the public `wss://` `PUBLIC_WEBSOCKET_URL`), the single-instance rationale citing `docs/runbooks/realtime-operations.md` §6, upgrade path (new digest → redeploy), and the fresh-deploy verification procedure.
- `deploy/verify-deploy.sh` (or `.mjs`) **(NEW)** — the reproducible fresh-deploy verification: health check green, then a bounded streaming smoke (reusing the `test/smoke` pattern) against the deployed URL; plus the single-instance observation procedure (see Design Notes) runnable during a rolling deploy and a restart.
- `README.md` **(MODIFY)** — add the deploy button (the host's standard "Deploy" button/badge markup pointing at the template) and a Self-host guide section linking `deploy/README.md`; update the ladder table's rung status.

## Existing Interfaces to Consume

**The env surface** (from `apps/server/src/config.ts` / `ENV_KEYS`, mirrored from the repaired compose):

```yaml
# The template's env block documents/wires (managed-host values):
DATABASE_URL:          # from the host's managed Postgres
REDIS_URL:             # from the host's managed Redis (optional for MVP; wire it)
API_PORT: '3000'       # the single REST+WS listener (main.ts:99)
CLIENT_JWT_SECRET:     # operator-generated secret
PUBLIC_WEBSOCKET_URL:  # wss://<app-hostname>  — MUST be wss:// and publicly correct
OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_API_KEY:  # operator-supplied, at least one
NODE_ENV: production
```

**The migrate release step** (`docs/runbooks/migrations.md`; present inside the image):

```bash
node packages/db/dist/migrate.js   # forward-only; drift preflight refuses on divergence
```

**The image reference** (from WS-50; digest form, never a tag):

```
ghcr.io/<owner>/<image>@sha256:<manifest-list-digest>
```

**The health endpoint** (Dockerfile HEALTHCHECK / `apps/server/src/health.ts`): `GET /health` → 200 `{ status: 'ok', checks: { db, redis, … } }`, 503 when degraded — the host health check targets it directly.

**The smoke shape** (`test/smoke/realtime-smoke.ts`): `SMOKE_BASE_URL` + API key → `POST /v1/sessions` → connect returned `websocketUrl` → `send_message` → assert `message_started → token(s) → message_completed`, all bounded. The fresh-deploy verification reuses this flow (an operator-created key/agent, not the WS-43 dev bootstrap).

## Design Notes

- **Decision before implementation.** `deploy/HOST-COMPARISON.md` is the first commit of this workstream. Evaluate exactly the five fixed criteria: (1) managed Postgres + Redis (native offering or first-party marketplace — for Fly that is Fly Postgres/Managed Postgres + Upstash Redis; for Railway, native Postgres + Redis plugins); (2) WebSocket support on the routed port; (3) **single-instance guarantee** — can the platform be configured so exactly one instance exists, including during its rolling-deploy strategy, and can autoscaling be fully disabled? A host that cannot is disqualified; (4) idle cost for an always-on demo; (5) template format — does a README button exist (Railway templates; Fly launch button) and how much does it automate? Record the winner, the date, and the disqualifying/deciding facts. All later files assume the recorded winner; if implementation falsifies a recorded fact, update the comparison doc first, then the config.
- **Never build on the host.** The host config references the WS-50 image by digest. Do not include a host-side Dockerfile build path — the whole point of the operator artifact is that the adopter pulls a prebuilt, provenance-attested image. Upgrading the template means bumping the digest.
- **Registry credentials until the click (decision 6).** Until the owner's one-time GHCR visibility click, the package is private, so the host must authenticate to pull: document the host's mechanism (e.g. `fly deploy` resolving local `docker login ghcr.io` credentials / Fly's registry-auth secrets; Railway's private-registry credential fields) using a PAT with `read:packages`. State explicitly that once the package is public these credentials become unnecessary and the button works credential-free — as a post-click property, never as a claim the click happened. The deploy therefore never depends on package visibility.
- **Single instance is a configuration AND an observation.** Configuration: exactly one machine/replica, autoscaling off (Fly: `auto_stop_machines = false`, `auto_start_machines = false`, `min_machines_running = 1`, exactly one machine in one region, no `[http_service.concurrency]`-triggered scaling; Railway: `numReplicas = 1`, no autoscaling). Rolling deploys are the trap: a default "start the new instance before stopping the old" strategy runs **two** instances mid-deploy — on Fly choose `strategy = "immediate"` (or single-machine rolling, which stops-then-starts), and verify whichever host mechanism guarantees ≤1. Observation (SC-12 requires it): during (a) a rolling deployment and (b) a restart, continuously poll both the host's instance listing (`fly machines list --json` / Railway API) and the serving path, and assert at no sample point do two instances serve traffic. Script this in `verify-deploy.sh` as a repeatable procedure with its output captured as evidence. Configuration value alone is explicitly insufficient.
- **Why one instance — cite, don't restate.** `docs/runbooks/realtime-operations.md` §6: connections, replay buffers, session locks, and in-flight runs are process-local; Redis pub/sub is wired but dormant; a second instance breaks session invariants silently. The template docs cite §1/§6 and state that horizontal scale is Phase 2 and out of scope.
- **Migrations: explicit release step, not AUTO_MIGRATE.** The image supports `AUTO_MIGRATE=true` (config.ts:130), but the deploy surface follows the runbook's posture: migrate as an explicit release step (Fly `[deploy] release_command = "node packages/db/dist/migrate.js"`; Railway pre-deploy command). The drift preflight then blocks the deploy on divergence, which is the correct failure mode; the runbook's reconciliation procedure (`migrations.md` §5) is the documented escape hatch. Leave `AUTO_MIGRATE` unset/false in the template. A fresh managed database is empty and NOT drifted — the preflight passes on first deploy; verify this in the fresh-deploy run.
- **`PUBLIC_WEBSOCKET_URL` must be the public `wss://` origin.** The server hands this URL to clients in session responses; a wrong value reproduces the exact defect WS-43 fixed locally. The template sets it to `wss://<app-hostname>` (host TLS terminates at the edge; the app listens on plain 3000 behind it) and the docs show how to derive it from the app name. No custom domains or TLS beyond the host's defaults.
- **Provisioning story is the operator's, not WS-43's.** The WS-43 dev bootstrap (known dev API key, deterministic fixture, seeded agent) is development-only and must be inert/absent here. The self-host guide documents the real path: deploy → create a workspace/API key/agent via the management or bootstrap path the runtime actually ships → run agent code against it. The fresh-deploy verification uses operator-style provisioning, not the dev fixture.
- **Reproducibility.** "Reproducible from the documented button or command" means: a clean host account + the documented steps → healthy deploy, twice if needed. Capture the exact command transcript in the guide. Where the button flow and CLI flow differ, document both and verify at least the CLI flow end-to-end.

## Out of Scope (restating every manifest exclude)

- Deploying the playground itself (owned by WS-49) — this delivers the reusable template, not the demo instance.
- Any change under `infra/` or to the AWS dev/staging/prod Terraform stack and its workflows.
- Multi-instance, autoscaling, or multi-region configuration — process-local session state makes this incorrect until Phase 2.
- Custom domains or TLS termination beyond the host's defaults.
- Playground abuse controls and guest-session policy (owned by WS-49).

## Implementation Steps

1. **Write `deploy/HOST-COMPARISON.md`** against the five fixed criteria; record the decision and date. Commit before any host config exists.
2. **Author the host configuration** for the chosen host: WS-50 image by digest; port 3000 service with WebSocket-capable routing; `/health` health check (interval/timeout consistent with the Dockerfile's HEALTHCHECK cadence); migrate release command; single-instance pinning with autoscaling disabled and a deploy strategy that never runs two instances; env/secret declarations per the table above.
3. **Document provisioning of managed Postgres + Redis** — the exact host commands that create them and produce `DATABASE_URL`/`REDIS_URL`, wired as secrets.
4. **Document registry credentials** for the pre-click authenticated pull (PAT with `read:packages`, host-side wiring), cross-referencing the WS-50 runbook, with the post-click "credentials become unnecessary" statement.
5. **Write `deploy/README.md`** — prerequisites, button + CLI deploy procedure, env/secret table with the `wss://` `PUBLIC_WEBSOCKET_URL` derivation, single-instance rationale citing `realtime-operations.md` §6, upgrade path (new digest), and the verification procedure.
6. **Build `deploy/verify-deploy.sh`** — (a) poll `/health` until ok (bounded); (b) run a bounded streaming smoke against the public URL (session create → WS → streamed turn) using operator-provisioned credentials; (c) the single-instance observation loop: sample the host's instance listing and the serving path while a redeploy and a restart are performed, failing if >1 instance is ever observed serving.
7. **Execute a fresh deploy end to end** in a real host account: provision, deploy, migrate (preflight passes on the empty DB), health green, smoke green. Then perform a rolling deployment and a restart with the observation loop running; capture the evidence.
8. **Update `README.md`** — deploy button, self-host guide section, ladder table status. Grep for every doc surface referencing self-hosting rungs (README, docs/quickstart.md ladder mentions) to keep them consistent — but leave the program-wide documentation pass (SC-10 wording) to WS-49.
9. **Verify the gate.** `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` all green.

## Tests

1. **Fresh-deploy verification (SC-07).** From a clean host account, the documented command/button sequence produces a deploy whose release step runs `node packages/db/dist/migrate.js` (log evidence), whose `/health` returns `ok`, and which completes a bounded streaming smoke over the public `wss://` URL.
2. **Migrations-as-release-step assertion (SC-07).** The host config contains the migrate release command; the deploy log shows it ran before the new instance served traffic; `AUTO_MIGRATE` is not enabled in the template env.
3. **Authenticated-pull independence (SC-07).** The deploy succeeds while the GHCR package is private, using the documented registry credentials — demonstrating the deploy does not depend on package visibility.
4. **Single-instance by observation (SC-12).** With the observation loop sampling the host instance listing and serving path: (a) across a rolling deployment, and (b) across a restart, at no point do two instances serve traffic; exactly one instance exists at rest. Captured output committed or linked as evidence.
5. **Configuration pinning (SC-12).** The host config file asserts one instance and autoscaling disabled (machine-readable check or documented inspection), and `deploy/README.md` cites `realtime-operations.md` §6.
6. **Gate.** `pnpm build && pnpm typecheck && pnpm lint && pnpm test` green.

## Acceptance Criteria

1. `deploy/HOST-COMPARISON.md` compares Fly.io vs Railway against exactly the fixed criteria (managed Postgres + Redis, WebSocket support, single-instance guarantee, idle cost, template format) and records the decision **before** implementation commits (SC-07).
2. The host configuration deploys the WS-50 GHCR image **by digest**, never building from source on the host; pulls authenticate with documented registry credentials until the owner's visibility click, and the docs state those credentials become unnecessary post-click (SC-07, decision 6).
3. Managed Postgres and Redis are provisioned and wired; forward-only migrations run as an explicit release step per `docs/runbooks/migrations.md`; the deployed app passes its `/health` check — all reproducible from the documented button or command (SC-07).
4. The deployment pins exactly one running instance with autoscaling disabled, and that is verified **by observation** across a rolling deployment and a restart — never by configuration value alone (SC-12).
5. The template's documentation cites the single-instance rationale from `docs/runbooks/realtime-operations.md` §6 and states horizontal scale is Phase 2 (SC-12).
6. Secret/env documentation is complete, including a correct public `wss://` `PUBLIC_WEBSOCKET_URL` derivation (SC-07).
7. `README.md` carries the deploy button and a self-host guide section linking the template guide (SC-07).
8. No playground deployment, no `infra/` changes, no multi-instance/autoscaling/multi-region config, no custom domains/TLS beyond host defaults, no abuse controls (all owned elsewhere or out of scope).
9. `pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm test` all pass (gate).
