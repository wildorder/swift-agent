# Swift Agent — Program Plan (OSS Direction)

## Program Overview

**Product:** Swift Agent — an open-source real-time agent runtime: the transport
and tool-execution layer for streaming, tool-calling AI agents, run by the people
who use it. See [`docs/vision.md`](../vision.md).

**Program scope:** Complete the two unbuilt rungs of the adoption ladder defined
in *Vision ▸ Distribution & Deployment* — the **hosted playground** (rung 1) and
**one-click setup** (rung 2, delivered as both a `create-swift-agent` scaffold
and a managed-host deploy template) — and repair the rung-3 local stack they both
inherit. Also prepares the three publishable packages for public npm **without
publishing them**; the actual release is gated behind a separate audit.

**Anchor outcome:** A stranger can go from a link, to a running agent on their
machine, to a runtime deployed in their own account, without reading the
monorepo.

---

## Strategic Goals

1. **Make the project evaluable in 60 seconds.** A public playground URL landing
   one takeaway — *infrastructure, not a chat widget* — without an install, an
   account, or an API key. It proves what a hosted demo honestly can: typed
   events, tool calls with real identity and failure semantics, and a session
   that survives a dropped connection. Proving that tools run on the adopter's
   own infrastructure is rung 2/3's job, not the playground's.
2. **Make adoption a command, not a project.** `npx create-swift-agent` produces
   a working agent; a deploy template produces a running runtime in the
   adopter's own account.
3. **Repair the local rung before building on it.** `docker compose up` must
   yield a genuinely working end-to-end stack, since both new rungs reuse its
   URL and env wiring.
4. **Be publish-ready, not published.** Every packaging, licensing, workflow, and
   *policy* change required for public npm lands and is verified by dry run; the
   upload itself stays manual and gated.
5. **Keep the runtime's size honest.** Nothing in this program expands the
   runtime's feature surface. It is distribution work, and it must respect the
   runtime's documented single-instance posture rather than quietly outgrow it.

---

## Architecture Changes

Relative to [`docs/as-built.md`](../as-built.md):

**Defect repaired (rung 3).** `docker-compose.yml` publishes port `3001` and sets
`PUBLIC_WEBSOCKET_URL: ws://localhost:3001`, but `apps/server/src/main.ts:99`
binds a **single** listener on `API_PORT` (3000) serving REST + WebSocket — the
unified listener established by `realtime-cloud-delivery`. Compose therefore
issues clients a WebSocket URL with nothing behind it. The defect is bounded to
those two values: `AUTO_MIGRATE` is a real flag consumed at
`apps/server/src/config.ts:130`, and the rest of the compose environment is
sound. `GATEWAY_PORT` remains a valid env key for standalone-gateway use and is
**not** removed; compose simply stops implying the server binds it.

**Single-instance posture is a hard deployment constraint.**
[`docs/runbooks/realtime-operations.md`](../runbooks/realtime-operations.md) §1
and §6 are explicit: all realtime state — connections, replay buffers, session
locks, in-flight runs — lives in one process's memory, Redis pub/sub is wired but
dormant, and the ECS service is pinned to `desired_count = 1` precisely because a
second task would break session invariants. Every deployment surface this program
creates (the deploy template and the playground) must therefore pin to **exactly
one instance** with autoscaling disabled, and must say why in the documentation
it ships. A host that cannot guarantee a single running instance is disqualified.

**New deployable app — `apps/playground`.** A demo agent backend plus a browser
frontend, structured like `examples/quickstart` (`backend/` + `frontend/`). It is
a first-class deployable rather than an example because it runs publicly and
carries abuse controls. It consumes only the public SDK surface, under the same
`no-restricted-imports` guard the quickstart example uses.

**The playground is designed around one takeaway, and one honest limit.** It
**cannot** demonstrate the product's central claim — that tools run on infra the
visitor controls — because on a hosted demo they run on ours. Pretending
otherwise would be the demo's worst failure mode. What it *can* prove, without
asking anyone to trust a claim, is that **this is infrastructure, not a chat
widget**, delivered as four designed beats in this order:

| # | Beat | What the visitor concludes |
|---|---|---|
| 1 | **Typed events, not text** — raw `ChatEvent` JSON toggleable beside the rendered chat | "I get `message_started` → `token` → `tool_call_started` → `tool_call_completed` → `message_completed`. I can build any UX on this — per-tool loading states, custom tool visualisations, whatever I want." |
| 2 | **A real round trip, including when it fails** — `callId`, deadline, measured duration, plus a deliberately failing/slow tool on a button | "A tool call is a network hop with identity and timing, not something the model narrates. And I can see what happens when one hangs." |
| 3 | **Survives a dropped connection** — a disconnect control the visitor hits mid-stream | "It reconnects and the session continues. This was built by someone who thought about the network." |
| 4 | **The conversion beat** — the ~20 lines that produced the demo, beside it, with the command that reproduces it | "That is not much code, and I can have it locally in a minute." |

Beat 2's failure path carries unusual weight: every demo shows the happy path,
and an infrastructure evaluator is silently asking *"what happens when a tool
hangs?"* Answering unprompted is more persuasive than a third working tool.

All four are buildable on the **public** surface — the vanilla
`createChatSession` exposes `onEvent()` for the raw feed and `disconnect()` for
the drop test — so the playground composes the public client rather than
extending `@swiftagent/react`.

**New package — `packages/create-swift-agent`.** A scaffold CLI. Deliberately
**unscoped** so `npx create-swift-agent` works, which is a documented exception to
the `@swiftagent/*` convention in `AGENTS.md`; it is the only such exception.

**New local registry harness.** A Verdaccio-backed (or tarball-backed) local
registry so scaffolded projects install `@swiftagent/*` as real npm dependencies
before anything is published. This makes the scaffold verifiable today and
removes the temptation to special-case unpublished packages in the generated
project.

**The operator-facing artifact does not exist yet.** The server image is built
only for private ECR (`.github/workflows/deploy-dev.yml`), and
`docker-compose.yml` uses `build:` rather than `image:` — so a stranger's first
`docker compose up` compiles the whole monorepo from source. Successful
self-hosted infrastructure distributes a **prebuilt image** as its primary
artifact, because the two artifacts serve different people: published npm
packages serve the *SDK consumer* writing `defineAgent`, while a published
container image serves the *runtime operator* deploying the server. This program
targets the operator, so WS-50 publishes `apps/server` to GHCR, compose pulls it,
and the deploy template deploys it rather than building on the host. The ECR path
for AWS deploys is untouched.

**Deploy target — managed host, not AWS.** The playground and the deploy template
target Fly.io/Railway, deliberately separate from the Terraform stack in
`infra/`. Playground availability must not be coupled to dev/staging/prod, and
vice versa. `infra/` is untouched by this program.

**Publishing posture inverts, across five surfaces that currently agree with each
other.** Today the repository is coherently *private*, and going public means
changing all of it in one workstream or leaving a contradiction:

| Surface | Current state | Evidence |
|---|---|---|
| Package metadata | `publishConfig.registry = npm.pkg.github.com`, `access: restricted` | `packages/{sdk,react,shared}/package.json` |
| License | `"license": "UNLICENSED"`, no repository `LICENSE` file | same three packages; `ls LICENSE*` finds nothing |
| Changesets | `"access": "restricted"` | `.changeset/config.json` |
| Normative policy | "Packages are currently private… publishes to a **restricted** registry… Do not remove `private`" | `docs/policies/versioning.md` §1 |
| Pack verifier | *asserts* the GitHub Packages registry | `scripts/verify-pack.mjs` |

The policy document is additionally **stale on a factual point**: it states every
package is `"private": true`, but the three publishable packages carry no
`private` field at all. That inaccuracy is corrected in the same pass.

**Contribution terms become live the moment the repository is public.** There is
no `CONTRIBUTING.md`, `DCO`, or pull-request template today, and this program is
what makes external pull requests possible — so the terms belong here rather than
in a later community-scaffolding pass. Apache-2.0 **§5** already licenses inbound
contributions under the same outbound terms unless a contributor says otherwise,
so the license functions without a CLA. The proportionate instrument is a **DCO**
(Developer Certificate of Origin 1.1) enforced by a `Signed-off-by` trailer and a
CI check.

The consequence is accepted knowingly: contributors retain copyright in their
contributions, so **relicensing the project later would require their
permission**. A CLA would preserve that option at the cost of contributor
friction and a signing bot. Given that the goal is adoption rather than a future
license change, the DCO is the right trade — but it is the one genuinely
one-way door in this program, so it is stated rather than assumed.

---

## Technology Choices

| Choice | Rationale |
|---|---|
| **Fly.io or Railway** (managed host) | Lowest recurring cost for an always-on demo; provides managed Postgres + Redis; the same target serves the rung-2 deploy button, so the program dogfoods what it ships. Must support WebSockets and **pinning to exactly one instance**. Final pick made in WS-47 against a documented comparison. |
| **Verdaccio** (local npm registry) | Lets the scaffold and its tests exercise the true `npm install` path with unpublished packages. Test-time dependency only; not shipped. |
| **Vite + React 19** (playground frontend) | Matches `examples/quickstart/frontend`; no new frontend stack. |
| **DCO 1.1** (not a CLA) | Apache-2.0 §5 makes contributions inbound=outbound, so a CLA is unnecessary for the license to work. A `Signed-off-by` trailer plus a CI check is low-friction and standard. Accepted consequence: contributors keep copyright, so relicensing later needs their permission. |
| **Apache-2.0** (decided 2026-08-19) | `UNLICENSED` becomes `Apache-2.0`, backed by a repository `LICENSE`. Chosen over MIT for the explicit patent grant and patent-retaliation clause — the clauses corporate legal review looks for in infrastructure a company embeds and deploys — and it matches comparable projects. |

No changes to the runtime stack. No new runtime dependencies.

---

## Workstreams

| ID | Workstream | Dependencies | Estimated Effort |
|----|------------|--------------|------------------|
| WS-43 | Local Stack Coherence | — | S |
| WS-50 | Public Container Image (Gated) | WS-43 | M |
| WS-44 | Public Release Readiness (Gated) | — | M |
| WS-45 | Local Package Consumption Harness | WS-44 | S |
| WS-46 | `create-swift-agent` Scaffold CLI | WS-43, WS-44, WS-45 | M |
| WS-47 | One-Click Deploy Template | WS-43, WS-50 | M |
| WS-48 | Playground Application | WS-43 | L |
| WS-49 | Playground Guardrails & Public Deployment | WS-47, WS-48 | M |

**Size key:** S = 1–2 days, M = 3–5 days, L = 5–10 days

---

## Dependency Graph

```
WS-43 Local Stack ──┬──► WS-50 Container Image ──► WS-47 Deploy Template ──┐
   Coherence        │        (GHCR, gated)                                 │
                    │                                                      ├──► WS-49
                    ├──────────────────────────► WS-48 Playground App ─────┘   Guardrails &
                    │                                                          Public Deploy
                    └──────────┐
                               │
WS-44 Public Release ──┬───────┼──► WS-46 create-swift-agent
   Readiness (gated)   │       │         (scaffold CLI)
                       └► WS-45┘
                          Local Registry Harness
```

Two independent chains join only at the end. WS-44/45/46 (packaging and
scaffold) can proceed in parallel with WS-47/48 (hosting and demo) once WS-43
lands.

## Critical Path

Two chains are now effectively co-critical into WS-49:

- `WS-43 → WS-50 → WS-47 → WS-49` — approximately 10–17 days (the hosting chain).
- `WS-43 → WS-48 → WS-49` — approximately 9–17 days (the demo chain).

The playground application is the largest single unit and the only `L`, but
adding the container image ahead of the deploy template makes the hosting chain
its equal. WS-49 cannot start until both chains land. The packaging chain
(`WS-44 → WS-45 → WS-46`, 7–12 days) still has slack and is not critical.

---

## Scope (In)

- Repairing `docker-compose.yml` so the full local stack starts and streams
  end to end on a single port, with a documented one-command path and an
  automated smoke check.
- Public-npm packaging readiness for `@swiftagent/{sdk,react,shared}`, applied
  coherently across all five surfaces named in *Architecture Changes*: registry
  and access metadata, an Apache-2.0 `LICENSE` plus matching license fields,
  `.changeset/config.json` access, the normative text in
  `docs/policies/versioning.md`, and the `verify-pack.mjs` assertions — with
  publish workflows behind a manual gate and a verified `--dry-run`.
- Contribution terms for a public repository: a `CONTRIBUTING.md` and `DCO`
  adopting Developer Certificate of Origin 1.1, a `Signed-off-by` CI check, and a
  pull-request template.
- A local registry harness that installs the three packages as real npm
  dependencies into a throwaway consumer.
- `create-swift-agent`: a scaffold CLI producing a runnable backend, frontend,
  and compose file, with a model-key prompt and an end-to-end generated-project
  test.
- A one-click deploy template for the chosen managed host, covering the runtime,
  managed Postgres and Redis, forward-only migrations, secrets, a single pinned
  instance, and a README deploy button.
- The playground application: an agent backend with two to three real tools, and
  a frontend built around the four demo beats above — raw typed-event feed, tool
  calls with identity/timing plus a triggerable failure path, a survivable
  dropped connection, and the source shown beside the running demo.
- Playground abuse controls (per-IP and per-session limits, message and token
  caps, a restart-surviving daily spend ceiling, a dedicated provider key with a
  provider-side budget cap, a cheap default model, and ephemeral session
  retention), public deployment, and a smoke test against the live URL.
- A multi-arch `apps/server` container image published to GHCR behind a manual
  gate, consumed by compose at a pinned tag and by the deploy template, with a
  documented build-from-source override for contributors.

## Scope (Out)

- **Actually publishing to npm.** Explicitly deferred to a separate audit pass at
  the user's direction. This program leaves the pipeline armed and unfired.
- Any change under `infra/` — the AWS Terraform stack, its environments, and its
  deploy workflows are untouched.
- **Horizontal scaling of any kind.** No shared session lock, no shared replay
  buffer, no cross-instance fanout, no autoscaling configuration. Lighting up the
  dormant Redis path is Phase 2 work per the realtime runbook §6.
- **A CLA or copyright-assignment agreement.** Deliberately rejected in favour of
  a DCO; no CLA-assistant bot or signing flow.
- A docs site, code of conduct, or issue templates. `CONTRIBUTING.md` and the DCO
  are now **in** scope because contribution terms are part of the licensing
  posture; the rest of the community scaffolding is not.
- The retention-modes feature (`retention: none | metadata | full`) discussed
  during positioning. The playground's ephemeral handling is a deployment
  configuration, not a runtime feature.
- Runtime feature work of any kind: no new endpoints, no new SDK surface, no
  new model providers, no durable execution.
- A hosted multi-tenant service, billing, signup, or a dashboard app.
- Removing `GATEWAY_PORT` or altering the standalone-gateway entry point.

---

## Risk Register

| Risk | Impact | Mitigation |
|---|---|---|
| A managed host silently runs more than one instance (rolling deploys, autoscaling defaults, multi-machine templates) | **High — session locks and replay buffers are process-local; a second instance breaks sessions with no error** | Single-instance pinning is an explicit acceptance criterion (SC-12) of both WS-47 and WS-49; host selection in WS-47 disqualifies any target that cannot guarantee it; the constraint and its rationale ship in the template's documentation |
| A public image tag drifts, so "it works on my machine" diverges from what operators pull | Medium — unreproducible bug reports | WS-50 defines immutable version tags alongside any moving tag, compose pins a specific tag, and the upgrade path is documented rather than implied |
| A contributor's pull request is merged before contribution terms exist | Medium — that contributor retains copyright with no recorded grant, permanently complicating any later relicensing | WS-44 lands `CONTRIBUTING.md`, the DCO, and the `Signed-off-by` CI check as part of going public, so the terms exist before the repository can accept its first external PR |
| Public playground abuse burns the owner's model API budget | High — an uncapped demo is an open wallet | WS-49 is a dedicated workstream, not a checklist item: per-IP and per-session rate limits, hard message and token caps, short session TTLs, and a global daily spend ceiling |
| The application-level spend ceiling is itself the thing that fails — a bug, a bypass, or an in-memory counter reset by a restart | High — the limiter's failure mode is an invoice, and an in-memory daily counter is really a per-uptime-window counter (realtime runbook §1) | Defence in depth in WS-49: the ceiling is persisted in Postgres rather than memory; a **dedicated provider API key carries a provider-side budget cap** enforced by the provider rather than by our code; a deliberately cheap default model shrinks the blast radius before any limiter fires; and an alert fires at a fraction of the ceiling |
| Going public is applied to some surfaces but not others | High — a half-public repo is worse than a private one: `UNLICENSED` code on a public registry, or a policy doc contradicting shipped metadata | WS-44 owns all five surfaces as one atomic checkpoint (metadata, LICENSE, changesets, policy doc, pack verifier), enumerated in *Architecture Changes* so nothing is missed |
| `scripts/verify-pack.mjs` asserts the GitHub Packages registry and will fail the moment `publishConfig` changes | Medium — a red build blocking WS-44 | Named explicitly in WS-44's scope; the assertion and the metadata move in the same workstream |
| The scaffold cannot install unpublished packages | High — WS-46 is unverifiable without a solution | WS-45 delivers the local registry harness first and is a hard dependency of WS-46 |
| Managed-host choice (Fly vs Railway) proves wrong after the template is written | Medium — rework in WS-47 and WS-49 | WS-47 begins with a documented comparison against fixed criteria (managed Postgres + Redis, WebSocket support, single-instance guarantee, idle cost, template format) and records the decision before implementation |
| Deploy-time migrations fail the drift preflight on a fresh managed-host database | Medium — a confusing first-deploy failure | WS-47 follows the forward-only path in the migrations runbook, runs `migrate` as an explicit release step, and verifies a clean first deploy end to end |
| The demo reads as a generic chat widget, or overstates what it proves | High — a generic demo does not convert, and implying the visitor's tools run on their own infra is a claim a hosted demo cannot back | The takeaway and its four beats are specified in WS-48 and asserted by SC-16 rather than left to the author's judgement; over-claiming the tool boundary is an explicit exclusion, with the real proof deferred to the proposed reverse-runner-transport program |
| Playground and deploy template drift from the real quickstart | Medium — the demo stops proving anything | Both consume only the public SDK surface under the existing `no-restricted-imports` guard, and both are exercised in CI |
| Compose repair reveals deeper env-wiring breakage in the unified listener | Medium — WS-43 grows | WS-43 is scoped to compose and its smoke check; genuine server defects are reported, not silently absorbed |
| A generated project ages badly against SDK changes | Low now, high later | The generated project is built and run in CI, so SDK changes that break it fail the build |

---

## Success Criteria

- **SC-01** — From a clean checkout, `docker compose up` starts Postgres, Redis, and the server; a client created against it completes a streaming turn including one tool call over WebSocket, asserted by an automated smoke check.
- **SC-02** — `docker-compose.yml` contains no port or `PUBLIC_WEBSOCKET_URL` value that contradicts the single-listener behaviour in `apps/server/src/main.ts`.
- **SC-03** — `@swiftagent/{sdk,react,shared}` declare `publishConfig.registry = https://registry.npmjs.org` with `access: public`, carry `"license": "Apache-2.0"` backed by a repository `LICENSE` file (no `UNLICENSED` remains), and `node scripts/verify-pack.mjs` passes with assertions updated to match.
- **SC-04** — A publish dry run succeeds for all three packages, and no workflow can upload to npm without an explicit manual trigger; this is demonstrated without publishing anything.
- **SC-05** — The local registry harness installs all three packages into a throwaway consumer that imports and type-checks against them, run as a repeatable command in CI.
- **SC-06** — `npx create-swift-agent <name>` (exercised against the local registry) produces a project that installs, type-checks, builds, and completes a streaming turn with a tool call, asserted end to end in CI.
- **SC-07** — The deploy template provisions the runtime with managed Postgres and Redis on the chosen host, applies forward-only migrations as an explicit release step, and passes a health check, reproducibly from the documented button or command.
- **SC-08** — The playground is reachable at a public URL and, in one session, streams tokens and surfaces at least one tool call in the event/trace panel with its start, completion, and duration.
- **SC-09** — Playground guardrails are enforced and tested: per-IP and per-session limits, a message cap, a token cap, and a global daily ceiling persisted across restarts, each producing a friendly refusal rather than an unhandled error; and the deployed instance uses a dedicated provider key carrying a provider-side budget cap, documented with its configured value.
- **SC-10** — `README.md` links the live playground, the deploy button, and `npx create-swift-agent`, and every ladder rung in `docs/vision.md` reads as built rather than planned.
- **SC-11** — No repository surface still asserts a private/restricted publishing posture: `.changeset/config.json` declares `access: public`, and `docs/policies/versioning.md` describes the public-npm posture accurately, including correcting its stale claim that every package is `"private": true`.
- **SC-12** — Every deployment surface created by this program pins to exactly one running instance with autoscaling disabled, and ships documentation citing the single-instance rationale in `docs/runbooks/realtime-operations.md` §6.
- **SC-13** — A `CONTRIBUTING.md` and `DCO` file adopt Developer Certificate of Origin 1.1 and state that contributors retain copyright; a CI check rejects a pull-request commit lacking a `Signed-off-by` trailer and accepts one that has it, asserted by the check actually running.
- **SC-14** — A multi-arch (`linux/amd64` + `linux/arm64`) `apps/server` image builds and publishes to `ghcr.io` from a workflow that cannot push without an explicit manual trigger; a pulled image starts, migrates, and serves REST + WebSocket identically to a locally built one.
- **SC-15** — `docker-compose.yml` consumes the published image at a pinned tag rather than building the monorepo from source, and a documented override still lets contributors build locally.
- **SC-16** — The playground delivers all four demo beats, each verifiable by a visitor without reading docs: raw `ChatEvent` JSON is viewable beside the rendered chat; a tool call shows `callId`, deadline, and measured duration, and a deliberately failing tool can be triggered to show the failure path; a disconnect control drops the connection mid-stream and the session recovers; and the agent source plus the reproduce-locally command are shown on the page.
