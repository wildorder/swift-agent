# Deploying Swift Agent to Fly.io

Deploy the Swift Agent runtime into **your own Fly.io account** on exactly
one pinned instance, with managed Postgres and Redis attached, running the
published GHCR image (never building from source on the host), applying
forward-only migrations as an explicit release step, and passing a health
check.

Host decision: **Fly.io** — recorded with rationale in
[HOST-COMPARISON.md](./HOST-COMPARISON.md). The template is
[fly.toml](./fly.toml); the verification script is
[verify-deploy.sh](./verify-deploy.sh).

## 1. Prerequisites

- A Fly.io account and `flyctl` (`fly auth login`).
- **Registry credentials for the image pull.** The image is
  `ghcr.io/wildorder/swift-agent@sha256:<digest>` (see
  `docs/runbooks/container-image.md`). Until the owner's one-time GHCR
  visibility click, the package is **private**, so the deploy must
  authenticate: create a GitHub classic PAT with `read:packages` and run

  ```bash
  docker login ghcr.io -u <github-username>   # paste the PAT
  ```

  `fly deploy` resolves your local Docker credentials for the registry pull.
  Once the package is public, these credentials become unnecessary and the
  deploy works credential-free — that is a post-click property; nothing here
  claims the click has happened.

## 2. Create the app and managed databases

```bash
fly apps create swift-agent-runtime          # or your own name; update fly.toml
fly mpg create --name swift-agent-db --region iad     # Managed Postgres
fly redis create --name swift-agent-redis --region iad  # Upstash Redis
```

Each create command prints its connection string. `fly mpg attach` /
`fly redis status` show them again later.

## 3. Set secrets

```bash
fly secrets set -a swift-agent-runtime \
  DATABASE_URL='<from fly mpg>' \
  REDIS_URL='<from fly redis>' \
  CLIENT_JWT_SECRET="$(openssl rand -hex 32)" \
  ANTHROPIC_API_KEY='<your provider key>'   # at least one provider key
```

### Full env/secret table

| Variable | Where | Value |
|---|---|---|
| `DATABASE_URL` | secret | Fly Managed Postgres connection string |
| `REDIS_URL` | secret | Upstash Redis connection string |
| `CLIENT_JWT_SECRET` | secret | operator-generated, e.g. `openssl rand -hex 32` |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` | secret | at least one |
| `RUNNER_TOKEN_PRIVATE_KEY` | secret | only when agents use remote tools; PEM PKCS8 or JWK JSON |
| `API_PORT` | fly.toml `[env]` | `3000` — the single REST + WebSocket listener |
| `PUBLIC_WEBSOCKET_URL` | fly.toml `[env]` | `wss://<app-name>.fly.dev/v1/stream` — see below |
| `NODE_ENV` | fly.toml `[env]` | `production` |

**Deriving `PUBLIC_WEBSOCKET_URL`:** clients receive this value verbatim
(the API appends only `?token=…`), so it must be the public `wss://` origin
**including the `/v1/stream` path**: `wss://<app-name>.fly.dev/v1/stream`.
Fly terminates TLS at the edge; the app listens on plain 3000 behind it. No
custom domains or TLS beyond the host defaults.

## 4. Deploy

```bash
fly deploy -c deploy/fly.toml
```

What happens, in order:

1. Fly pulls the digest-pinned image (authenticated per §1; never a source
   build on the host).
2. The **release command** runs `node packages/db/dist/migrate.js` —
   forward-only migrations with a drift preflight
   (`docs/runbooks/migrations.md`). A fresh managed database is empty and
   not drifted, so the preflight passes on first deploy; on divergence it
   refuses and blocks the deploy, which is the correct failure mode
   (reconciliation: migrations runbook §5). `AUTO_MIGRATE` stays unset.
3. The single Machine is replaced in place (`strategy = "immediate"`) and
   must pass the `/health` check.

**Upgrading:** a new image publish produces a new digest — edit the
`image =` digest in `fly.toml` and `fly deploy` again.

## 5. Why exactly one instance (do not scale this)

All realtime state is process-local: connections, replay buffers, session
locks, and in-flight runs. Redis pub/sub is wired but dormant. A second
instance breaks session invariants **silently** — this is why the AWS
reference deployment pins `desired_count = 1`. See
`docs/runbooks/realtime-operations.md` §1 and §6. Horizontal scale is
Phase 2 and out of scope.

The template pins this by configuration — one `[[vm]]` with `count = 1`,
`auto_stop_machines = "off"`, `auto_start_machines = false`,
`min_machines_running = 1`, no `[http_service.concurrency]`, and
`strategy = "immediate"` (bluegreen/canary would boot a second Machine
mid-deploy) — **and verifies it by observation** (§6), because a managed
host silently running two instances is precisely the failure mode
configuration values alone cannot rule out.

## 6. Verification

```bash
# 1. Health (bounded poll):
./deploy/verify-deploy.sh health https://<app-name>.fly.dev

# 2. Provision operator credentials (one-off task on the app image; the
#    WS-43 dev bootstrap is local-only and is inert here). This uses the
#    provisioning entry the image ships:
fly machine run ghcr.io/wildorder/swift-agent@sha256:<digest> \
  -a swift-agent-runtime --rm \
  -e DATABASE_URL='<from fly mpg>' -e SMOKE_API_KEY="$(openssl rand -hex 24)" \
  "node" "packages/db/dist/provision-smoke.js"

# 3. Bounded streaming smoke (session create → WebSocket → streamed turn):
./deploy/verify-deploy.sh smoke https://<app-name>.fly.dev <api-key> smoke-echo

# 4. SC-12 observation — run the loop, then in another terminal perform
#    (a) a rolling deployment (fly deploy) and (b) a restart
#    (fly machine restart <id>); the loop fails if two Machines ever serve:
./deploy/verify-deploy.sh observe swift-agent-runtime https://<app-name>.fly.dev 300
```

Capture the observation output for both the deploy and the restart as the
single-instance evidence. At rest, `fly machines list` must show exactly one
Machine.

## 7. Provisioning story (yours, not the dev bootstrap)

The local compose stack's self-provisioning bootstrap (dev API key, fixture
model, seeded agent) is development-only and **absent** from this deploy —
the image only activates it under `LOCAL_FIXTURE_PROVIDER`, which hard-fails
in cloud environments. As the operator you bring real provider keys and
create your own workspace/API key/agents: the one-off provisioning task in
§6 creates a workspace + API key (+ a zero-cost `smoke-echo` agent for
verification), and from there you register real agents against `/v1` with
your API key using the SDK (`@swiftagent/sdk`).
