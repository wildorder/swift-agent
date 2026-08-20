# One-Click Deploy Host Comparison — Fly.io vs Railway

**Decision: Fly.io.** Recorded 2026-08-20, before any host configuration was
authored (WS-47 requires the decision to precede implementation). All later
files in `deploy/` assume this decision; if implementation falsifies a fact
recorded here, this document is updated first, then the config.

## The five fixed criteria

### 1. Managed Postgres + Redis

| | Fly.io | Railway |
|---|---|---|
| Postgres | Fly Managed Postgres (MPG), first-party. Plans from ~$38/mo (Basic) + $0.28/GB provisioned storage. | Native Postgres service, usage-priced (typically cheaper at demo scale). |
| Redis | Upstash for Redis, first-party marketplace integration (`fly redis`); pay Upstash pricing only, generous low-usage tier. | Native Redis service. |

Both hosts satisfy the criterion. Railway's databases are marginally simpler
(one vendor); Fly's are first-party or first-party-marketplace as the
criterion requires. **Tie, slight edge Railway on simplicity.**

### 2. WebSocket support on the routed port

Both platforms proxy WebSocket upgrades on their standard HTTP service
routing with no special configuration — Fly via `[http_service]` (the Fly
proxy passes upgrade traffic to the single internal port), Railway via its
default HTTP edge. The runtime's single listener on port 3000 serves REST +
WS on both. **Tie.**

### 3. Single-instance guarantee (disqualifier criterion)

This is the deciding criterion. `docs/runbooks/realtime-operations.md` §1/§6:
all realtime state is process-local; a second serving instance breaks session
invariants silently, including *mid-deploy*.

- **Fly.io**: exact, first-class control. One Machine in one region;
  `auto_stop_machines = "off"`, `auto_start_machines = false`,
  `min_machines_running = 1` disable every autoscaling path. Deploy
  strategies are explicit: `bluegreen` and `canary` boot a second Machine
  (disqualified strategies), while `strategy = "immediate"` replaces the
  single Machine without booting a parallel one. Observation is first-class:
  `fly machines list --json` enumerates every Machine with state, so the
  SC-12 "verify by observation during a rolling deploy and a restart"
  procedure is directly scriptable.
- **Railway**: `numReplicas` can be pinned to 1, but Railway's zero-downtime
  deploys run the **old and new deployment concurrently** for
  `overlapSeconds` by default — exactly the two-instances-mid-deploy trap
  the criterion names. It is configurable down (`overlapSeconds: 0`), but
  the platform's default posture is overlap, and instance-level observation
  goes through the Railway API rather than a first-class CLI listing.

Neither host is outright disqualified, but Fly.io provides the strongest
configurable *and observable* guarantee; Railway requires opting out of its
zero-downtime default and offers weaker observation tooling. **Fly.io.**

### 4. Idle cost (always-on demo)

- Fly.io: one `shared-cpu-1x` Machine (~$2–5/mo) + MPG Basic ~$38/mo +
  Upstash Redis near-zero at demo load ⇒ ~**$40–45/mo**.
- Railway: usage-based; a comparable app + Postgres + Redis typically lands
  ~**$20–40/mo**.

**Railway wins on cost.** The delta (~$5–20/mo) is accepted as the price of
criterion 3's stronger guarantee; the MPG Basic plan is the floor.

### 5. Template format / README button

- Railway: first-class template gallery + "Deploy on Railway" button that
  provisions databases and services in one click. **Strongest.**
- Fly.io: "Launch on Fly" button (`fly launch` from a repo/config) exists
  but automates less; the CLI flow (`fly launch` / `fly deploy` with a
  committed `fly.toml`) is the well-trodden path. Databases are provisioned
  by two documented commands (`fly mpg create`, `fly redis create`).

**Railway wins on button polish**; Fly's CLI flow is still a documented
single-command deploy, which satisfies "a README button **or** a single
command".

## Decision

**Fly.io**, on criterion 3 — the only disqualifier-grade criterion. Fly
pins exactly one Machine with every autoscaling path disabled by explicit
configuration, deploys with a strategy (`immediate`) that never boots a
parallel Machine, and exposes Machine-level state (`fly machines list
--json`) for the observation-based SC-12 verification. It also deploys a
prebuilt image directly (`[build] image = "ghcr.io/…@sha256:…"` /
`fly deploy --image`), which fits WS-50's never-build-on-host digest-pin
requirement, and `[deploy] release_command` runs the forward-only migration
step before the new Machine serves traffic.

Costs accepted with the decision: higher idle cost than Railway (~$38/mo MPG
floor) and a less automated README button (CLI-first deploy, launch button
secondary).

Facts current as of 2026-08-20 (Fly config reference; Railway config-as-code
reference; both vendors' pricing pages).
