# Deploying the Public Playground (WS-49)

The hosted playground is **exactly two Fly.io services**, both pinned to one
instance, fully isolated from dev/staging/prod (separate apps, separate
database, separate secrets, nothing shared with `infra/`):

1. **The playground runtime** — [`runtime.fly.toml`](./runtime.fly.toml): the
   WS-47 template (`deploy/fly.toml`) instantiated for the playground, running
   the WS-50 GHCR image with its **own** managed Postgres + Redis and the
   **dedicated provider key** in its environment only.
2. **The playground app** — [`fly.toml`](./fly.toml): the mediator + static
   frontend built by [`apps/playground/Dockerfile`](../../apps/playground/Dockerfile)
   from the monorepo (the package depends on private workspace packages and is
   never published).

> **Owner-pending steps** are marked **[OWNER]** throughout. This document was
> authored before the first live deploy; the live URL, the recorded digest, the
> provider-cap value, and the SC-12 observation evidence are filled in when the
> owner executes those steps.

## 1. Credential topology (SC-09)

```
browser ──HTTP/WS──► playground app (mediator)     holds: SWIFT_AGENT_API_KEY (workspace key)
                        │                          browser holds: NOTHING (opaque guest id only)
                        └──WS──► playground runtime holds: ANTHROPIC_API_KEY (dedicated, capped)
                                                    via apps/server's standard config path
```

- The **browser holds no credential of any kind** — not the workspace key, not
  a client JWT, not the upstream `websocketUrl`, not a provider key. It gets an
  opaque `pg_…` guest id and the limits.
- The **mediator** holds the runtime **workspace API key** and keeps the minted
  `clientToken`/`websocketUrl` server-side, keyed by guest id.
- The **dedicated provider key** is configured **only** as environment on the
  runtime app (`ANTHROPIC_API_KEY` through `apps/server/src/config.ts`, the
  standard path). The mediator never sees provider traffic; there is **no
  provider proxy**.

## 2. Provision the runtime (the WS-47 template, instantiated)

Follow [`deploy/README.md`](../README.md) with the playground names:

```bash
fly apps create swift-agent-playground-runtime
fly mpg create --name swift-agent-playground-db --region iad
fly redis create --name swift-agent-playground-redis --region iad

fly secrets set -a swift-agent-playground-runtime \
  DATABASE_URL='<from fly mpg — the playground-ONLY database>' \
  REDIS_URL='<from fly redis>' \
  CLIENT_JWT_SECRET="$(openssl rand -hex 32)" \
  ANTHROPIC_API_KEY='<the DEDICATED playground key — see §5>' \
  RUNNER_TOKEN_PRIVATE_KEY='<EdDSA private JWK — public half goes to the app>'

# [OWNER] Set the image digest in runtime.fly.toml first (the WS-50 image has
# not been published yet; take the sha256 manifest-list digest from the first
# "Publish Container Image" run), then:
fly deploy -c deploy/playground/runtime.fly.toml
```

`release_command = "node packages/db/dist/migrate.js"` applies the
**forward-only** migration chain — including the WS-49 ledger migration
(`playground_spend_days`, `playground_spend_reservations`) — before the new
Machine serves traffic; the drift preflight refuses on divergence
([`docs/runbooks/migrations.md`](../../docs/runbooks/migrations.md)).

Then provision the workspace + API key for the mediator (one-time, against the
runtime's `/v1` management surface or via the seeded provisioning scripts), and
record `RUNNER_WORKSPACE_ID`.

## 3. Provision the playground app

```bash
fly apps create swift-agent-playground
fly secrets set -a swift-agent-playground \
  SWIFT_AGENT_API_KEY='<workspace key minted on the runtime>' \
  DATABASE_URL='<the SAME playground-only Postgres — the ledger lives there>' \
  RUNNER_TOKEN_PUBLIC_KEY='<public half of the runtime keypair>' \
  RUNNER_WORKSPACE_ID='<ws_…>'
fly deploy -c deploy/playground/fly.toml
```

No provider key is ever set on this app.

## 4. Guardrails: every cap and its default value

All env-tunable on the playground app (`fly.toml [env]`; parsed by
`apps/playground/backend/src/mediator/config.ts`). Every limit is enforced
**only** in the mediator and produces its typed refusal frame:

| Limit | Env | Default | Refusal reason |
|---|---|---|---|
| Guest session TTL | `PLAYGROUND_SESSION_TTL_SECONDS` | 600 (10 min) | `session_expired` |
| Session mints per IP | `PLAYGROUND_IP_MINTS_PER_WINDOW` / `_IP_WINDOW_SECONDS` | 10 per 3600 s | `rate_limit_ip` (HTTP 429 body) |
| Sends per session | `PLAYGROUND_SESSION_SENDS_PER_WINDOW` / `_SESSION_WINDOW_SECONDS` | 6 per 60 s | `rate_limit_session` |
| Messages per session | `PLAYGROUND_MESSAGES_PER_SESSION` | 20 | `message_cap` |
| Chars per message | `PLAYGROUND_MESSAGE_MAX_CHARS` | 500 | `message_cap` |
| Output tokens per session (est. chars/4) | `PLAYGROUND_TOKENS_PER_SESSION` | 8 000 | `token_cap` (+ upstream `cancelRun`) |
| **Global daily spend ceiling** | `PLAYGROUND_DAILY_CEILING_MICRO_USD` | 5 000 000 µ$ = **$5.00/day** | `daily_ceiling` |

Rate/cap counters are in-memory (single instance — §7); the **daily ceiling is
Postgres-persisted** in the ledger and survives restarts
(`docs/runbooks/realtime-operations.md` §1 is exactly why the ledger must not
be in-memory).

### The reservation formula (concrete numbers)

Before any upstream forward, the mediator atomically reserves the
**conservative per-run maximum** against the day's ceiling
(`packages/db` → `createPlaygroundSpendRepo.reserve`, one transaction, atomic
conditional `UPDATE` — concurrent sessions cannot race past the ceiling):

```
reservationMicroUsd = ceil( maxInputTokensPerRun  × inputPriceUsdPerMTok
                          + maxOutputTokensPerRun × outputPriceUsdPerMTok )
```

(USD-per-MTok is numerically micro-USD-per-token, so the arithmetic is exact
integers.) With the deployed defaults:

| Input | Value | Where it comes from |
|---|---|---|
| Model | `anthropic/claude-3-5-haiku` | the deliberately **cheap** default (§5) |
| Input price | **$0.80 / MTok** | Anthropic's published Claude 3.5 Haiku pricing |
| Output price | **$4.00 / MTok** | same source |
| `maxOutputTokensPerRun` | **10 240** | agent `maxTokens: 1024` × the runtime's `DEFAULT_MAX_TOOL_ITERATIONS = 10` (`packages/runtime/src/types.ts`) |
| `maxInputTokensPerRun` | **30 000** | ≈3 000 tokens/round (500-char message cap ≈125 tok + system prompt + last-50 memory + tool schemas, re-sent every round) × 10 rounds |

```
reservation = ceil(30 000 × 0.8 + 10 240 × 4.0) = 64 960 µ$ ≈ $0.065 per run
$5.00 ceiling ÷ $0.065 ≈ 76 runs/day before `daily_ceiling` refuses
```

**Every reservation settles at its FULL reserved amount** — for all four
terminal statuses (`completed`, `failed`, `cancelled`, `timed_out`) and, after
`PLAYGROUND_ABANDONED_AFTER_SECONDS` (300), for abandoned never-terminal runs
(the startup + interval sweep). There is **no decrement API**; observed
`tokenUsage` is recorded as observability only and never reduces a charge
(`packages/runtime/src/loop.ts` structurally under-counts multi-round runs —
which is exactly why the ledger never trusts it).

## 5. Cheap model, dedicated key, provider-side budget cap

- **Cheap default model:** `anthropic/claude-3-5-haiku`
  (`PLAYGROUND_MODEL`-overridable). Rationale: cheapest current-generation
  Anthropic model ($0.80/$4.00 per MTok — an order of magnitude below Sonnet),
  fully sufficient for the demo's three toy tools; minimising blast radius
  before any limiter fires is the point. Worst case per run = the reservation:
  ≈ $0.065.
- **Dedicated key:** the `ANTHROPIC_API_KEY` on the runtime app is used by the
  playground and **nothing else**.
- **[OWNER] Provider-side budget cap (REQUIRED manual step):** in the Anthropic
  console, create the dedicated API key inside its own workspace and set that
  workspace's **monthly spend limit**. Recommended value: **$150/month** (the
  $5/day application ceiling × 31 days ≈ $155 ⇒ the console cap binds first if
  the application limiter is ever bypassed or buggy).
  **Configured value: `$______ /month` — record here at setup.** This backstop
  holds even if every mediator limit fails.

## 6. Alerting, the owner check, TTL and retention

- **Alert:** when a reservation pushes the day total past
  `PLAYGROUND_ALERT_THRESHOLD_FRACTION` (default **0.5** = $2.50) the mediator
  emits one structured warn per day:
  `{"alert":"playground_spend_threshold", day, dayTotalMicroUsd, …}`.
  **[OWNER]** wire a Fly log-based alert (e.g. Fly Metrics/Grafana or a
  log-shipper rule) on `"alert":"playground_spend_threshold"`.
- **Ready-to-run owner check** (works with no alerting at all — run against the
  playground Postgres, e.g. `fly mpg connect`):

  ```sql
  -- Today's reserved spend vs the $5.00 ceiling, plus reservation states
  SELECT d.day,
         d.reserved_total_micro_usd / 1e6.0            AS reserved_usd,
         round(100.0 * d.reserved_total_micro_usd / 5000000, 1) AS pct_of_ceiling,
         count(*) FILTER (WHERE r.status = 'reserved') AS open_reservations,
         count(*) FILTER (WHERE r.terminal_status = 'abandoned') AS abandoned
  FROM playground_spend_days d
  LEFT JOIN playground_spend_reservations r USING (day)
  WHERE d.day >= current_date - 7
  GROUP BY d.day, d.reserved_total_micro_usd
  ORDER BY d.day DESC;
  ```

- **TTL:** guest sessions expire after 10 minutes; post-expiry sends get the
  typed `session_expired` frame and the socket closes only **after** the frame
  is delivered.
- **Retention (ephemeral by configuration, not by runtime feature):**
  [`retention-cleanup`](../../apps/playground/backend/src/scripts/retention-cleanup.ts)
  deletes expired guest-session data older than `PLAYGROUND_RETENTION_HOURS`
  (24) and settled ledger reservations older than `PLAYGROUND_LEDGER_AUDIT_DAYS`
  (30) from the playground's **own** database. Day totals are **kept** — they
  are the spend record. Schedule it daily on the host:

  ```bash
  # [OWNER] after the first deploy, schedule inside the playground app image:
  fly machine run -a swift-agent-playground --schedule daily \
    --image "$(fly image show -a swift-agent-playground --json | jq -r '.[0].Ref' )" \
    "node" "apps/playground/dist/backend/scripts/retention-cleanup.js"
  ```

## 7. Single instance, verified by observation (SC-12)

**Why one instance:** `docs/runbooks/realtime-operations.md` §6 — all realtime
state is process-local (connections, replay buffers, session locks, in-flight
runs), and the mediator adds its own process-local guest map and counters. A
second serving instance breaks session invariants **with no error**. The
correct response to load is tighter caps, not more instances. Both `fly.toml`s
therefore pin one Machine (`auto_stop_machines = "off"`,
`auto_start_machines = false`, `min_machines_running = 1`, `[[vm]] count = 1`,
no concurrency section) and deploy with `strategy = "immediate"`.

**Configuration alone is insufficient — verify by observation** (the
`deploy/verify-deploy.sh observe` pattern, aimed at the mediator's `/health`,
which reports the serving `instance` identity — `FLY_MACHINE_ID`):

```bash
# Terminal A — sample continuously (1/s) during the whole exercise:
./deploy/verify-deploy.sh observe swift-agent-playground \
  https://swift-agent-playground.fly.dev 300
# Terminal B — (a) a rolling deploy, then (b) a forced restart:
fly deploy -c deploy/playground/fly.toml
fly machine restart -a swift-agent-playground <machine-id>
# Repeat both for swift-agent-playground-runtime.
```

PASS criteria: at every sample, at most **one** machine is in state `started`
and `/health` reports at most one distinct `instance` id at a time; exactly one
serves steady-state; `fly machines list` corroborates.

**[OWNER] Evidence:** paste the observe-loop output for (a) the rolling deploy
and (b) the restart of each app here after executing the procedure.

## 8. Live smoke (SC-08)

```bash
PLAYGROUND_SMOKE_URL=https://swift-agent-playground.fly.dev pnpm smoke:playground
```

Asserts, bounded and diagnostic: credential-free guest mint → `session_ready` →
`message_started` → `token`(s) → `tool_call_started` → `tool_call_completed`
(same `callId`, computable duration) → `message_completed`, with every relayed
frame validated against `ChatEventSchema`.
**[OWNER]** run against the live URL after the first deploy and record the pass.
(The identical flow was proven locally against the WS-43 compose stack — see
`apps/playground/backend/src/scripts/local-verify.ts`.)

## 9. Owner-pending checklist

| Step | Status |
|---|---|
| Publish the WS-50 image; pin its digest in `runtime.fly.toml` | **pending owner** |
| Create both Fly apps + managed Postgres/Redis; set secrets | **pending owner** |
| Create the dedicated provider key; set its console budget cap; record the value in §5 | **pending owner** |
| First `fly deploy` of both apps (`migrate` release step runs) | **pending owner** |
| Schedule `retention-cleanup` (§6) | **pending owner** |
| Execute the SC-12 observation procedure; paste evidence in §7 | **pending owner** |
| Run the live smoke (§8); record the pass | **pending owner** |
| Wire the log-based spend alert (§6) | **pending owner** |

Everything else — the mediator, the ledger + migration, the refusal protocol,
the frontend transport, the smoke script, both Fly configs, the Dockerfile,
and the retention job — is implemented and tested in this repository.
