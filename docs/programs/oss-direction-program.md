# Swift Agent — Program Plan (OSS Direction)

## Program Overview

**Product:** Swift Agent — an open-source real-time agent runtime: the transport
and tool-execution layer for streaming, tool-calling AI agents, run by the people
who use it. See [`docs/vision.md`](../vision.md).

**Program scope:** Complete the two unbuilt rungs of the adoption ladder defined
in _Vision ▸ Distribution & Deployment_ — the **hosted playground** (rung 1) and
**one-click setup** (rung 2, delivered as both a `create-swift-agent` scaffold
and a managed-host deploy template) — and repair the rung-3 local stack they both
inherit. Also takes the three publishable packages **and** `create-swift-agent`
all the way to a real public-npm release, fired by a single manual
`workflow_dispatch` trigger the owner presses, while the container image
publishes automatically, since it commits to no API surface.

**Anchor outcome:** A stranger can go from a link, to a running agent on their
machine, to a runtime deployed in their own account, without reading the
monorepo. The one manual moment is the owner pressing the release trigger once
the program lands — everything up to and including that button is delivered and
verified by the program.

**Requirements decisions.** `plan-audit` has halted this plan on conflicts that
wording could not repair; each was resolved by the user rather than assumed.
Decisions 1 and 2 (taken 2026-08-19, audit round 1) were **superseded on
2026-08-19 (audit round 3)** by decisions 4 and 5. Decision 3 stands.

1. ~~**The npm gate stays; the claims come down to meet it.**~~ Superseded by
   decision 4: the gate is removed and publication is real.
2. ~~**GHCR package visibility is set once via `gh api`.**~~ Superseded by
   decision 5: no such API operation exists; the step is the documented one-time
   UI action. (This decision also rested on a false premise — that a new GHCR
   package inherits repository visibility. It does not: linked packages inherit
   access _permissions_, and newly published packages default to private.)
3. **Beat 2's deadline is demo-owned.** No deadline reaches the public event
   surface, so the playground displays the budget _it_ configured rather than
   the program adding a field to `ChatEvent`.
4. **Go directly to public npm (decided 2026-08-19, audit round 3).** The
   separate-audit gate on npm publication is removed. `@swiftagent/{sdk,react,shared}`
   and `create-swift-agent` are released to public npm via a release workflow
   fired by an explicit manual `workflow_dispatch` trigger, pressed once by the
   owner when the program lands. The program delivers everything up to that
   button — public packaging metadata, the armed workflow, a verified
   `pnpm publish --dry-run`, the local-registry end-to-end proof, and a release
   runbook — and documentation is written for the released state. Provisioning
   the npm organization and token remains a manual owner-owned setup step. No
   workstream's checkpoint depends on the trigger being pressed.
5. **GHCR package visibility is a one-time manual UI step (decided 2026-08-19,
   audit round 3).** GitHub's REST packages API has no visibility-mutation
   endpoint — list, get, delete, restore, and version operations only — so the
   `gh api` mechanism of superseded decision 2 is impossible. The supported
   procedure is _Package settings → Danger Zone → Change visibility → Public_,
   which is manual and irreversible once public. The owner performs it once
   after the first image publish, as a documented repository-configuration
   prerequisite. The repository itself was made public by the owner on
   2026-08-19, but that does not make the package public: packages default to
   private on first publish regardless. WS-50 documents the UI step; decision 6
   settles what its checkpoint may claim about the outcome.
6. **Autonomy wins over in-program pull proof (decided 2026-08-20, audit
   round 4).** `plan-audit` showed decisions 5's two halves are irreconcilable
   as written: SC-15 demanded a _successful_ anonymous pull, but the only
   action that can make it succeed is the owner's UI click, which no
   checkpoint may wait on — and the click is only possible _after_ the first
   push creates the package (re-verified 2026-08-20: anonymous GHCR access for
   `wildorder/swift-agent` still returns DENIED). The user chose autonomy: no
   checkpoint waits on the click, and the program does **not** claim the
   anonymous pull succeeded. SC-15 instead delivers the complete mechanism —
   the auto-publish workflow, the digest-pinned compose, the documented
   one-time click, and a ready-to-run anonymous-pull verification command the
   owner runs immediately after clicking. Every in-program verification that
   needs the image before the click **authenticates** to GHCR (documented):
   the pulled-image equivalence check, CI compose pulls, and the WS-47 deploy
   all use registry credentials, which become unnecessary once the package is
   public. The credential-free stranger path (`docker compose up` pulling
   anonymously) is stated everywhere as the post-click property it is.

---

## Execution Mode

**Mode:** orchestrated

**Reason:** Three separately-shippable release surfaces must each be
independently green and independently reversible — a container image published
to GHCR, npm packaging metadata for three packages, and a publicly-hosted
playground deployment. The publishing flip is a genuine expand → migrate →
contract migration with load-bearing ordering: Apache-2.0 and the public
`publishConfig` must be in the tree before any image publishes (WS-50 depends on
WS-44), and the local registry harness must exist before the scaffold CLI can
install the packages as real dependencies (WS-46 depends on WS-45). No single
agent session can coherently own a new two-part deployable app
(`apps/playground` backend + frontend), a twelve-surface repository posture flip,
a scaffold CLI, a container pipeline, and a managed-host deploy template. After
the root repairs the packaging chain and the hosting chain are causally
independent and run in parallel — material parallelism, not cosmetic
decomposition.

---

## Strategic Goals

1. **Make the project evaluable in 60 seconds.** A public playground URL landing
   one takeaway — _infrastructure, not a chat widget_ — without an install, an
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
4. **Ship both artifacts for real.** Every packaging, licensing, workflow, and
   _policy_ change required for public npm lands and is verified by dry run and
   a local-registry end-to-end proof, and the release itself fires from a manual
   `workflow_dispatch` trigger the owner presses once (decision 4). The
   container image needs no button at all — no API commitment, replaceable
   references — so it publishes automatically and the operator gets something
   real to pull.
5. **Keep the runtime's size honest.** Nothing in this program expands the
   runtime's feature surface. It is distribution work, and it must respect the
   runtime's documented single-instance posture rather than quietly outgrow it.

---

## Architecture Changes

Relative to [`docs/as-built.md`](../as-built.md):

**Defect repaired (gate).** The configured verification gate is _flaky-red_ at
baseline. `apps/server/src/__tests__/index.test.ts` awaits a dynamic import of
`../index.js` and consumes roughly 2.5s of vitest's 5000ms default in isolation,
so under parallel turbo load it intermittently exceeds the timeout — observed
failing one full `pnpm test` run and passing the next with no source change
between them. `pnpm build`, `pnpm typecheck`, and `pnpm lint` are green. Because
every workstream here must finish with all four commands green, a gate that goes
red at random will fail checkpoints that are actually correct and trigger
spurious replans. WS-51 makes the gate deterministic and is a hard dependency of
both otherwise-rootless workstreams, WS-43 and WS-44.

**Defect repaired (rung 3).** `docker-compose.yml` publishes port `3001` and sets
`PUBLIC_WEBSOCKET_URL: ws://localhost:3001`, but `apps/server/src/main.ts:99`
binds a **single** listener on `API_PORT` (3000) serving REST + WebSocket — the
unified listener established by `realtime-cloud-delivery`. Compose therefore
issues clients a WebSocket URL with nothing behind it. `AUTO_MIGRATE` is a real flag consumed at
`apps/server/src/config.ts:130`, and `GATEWAY_PORT` remains a valid env key for
standalone-gateway use and is **not** removed; compose simply stops implying the
server binds it.

**But the compose repair is the smaller half of WS-43.** Fixing the ports
yields a stack that _connects_ and still cannot complete a turn, because a clean
checkout has Postgres, Redis, and the listener and **nothing else** — no model
configuration, no workspace, no API key, no agent, no tool, no runner keys.
`test/smoke/realtime-smoke.ts` makes this concrete: it _requires_ a pre-seeded
`SMOKE_API_KEY` and an existing `smoke-echo` agent, and does not self-provision.
SC-01 therefore requires WS-43 to own a real local bootstrap — a server-accepted
model configuration, a usable raw dev API key whose stored hash matches, a
workspace and a tool-bearing agent, runner signing/verification keys with a
reachable runner, and a deterministic tool-calling fixture — and to assert both
`tool_call_started` and `tool_call_completed`, not merely token frames. That is
why WS-43 is sized **L**, not **S**, and why it is the program's largest risk
rather than its warm-up.

**Single-instance posture is a hard deployment constraint.**
[`docs/runbooks/realtime-operations.md`](../runbooks/realtime-operations.md) §1
and §6 are explicit: all realtime state — connections, replay buffers, session
locks, in-flight runs — lives in one process's memory, Redis pub/sub is wired but
dormant, and the ECS service is pinned to `desired_count = 1` precisely because a
second task would break session invariants. Every **managed, publicly-hosted**
deployment surface this program creates — exactly two, the WS-47 deploy template
and the WS-49 playground deployment (SC-12 names the family) — must therefore pin
to **exactly one instance** with autoscaling disabled, and must say why in the
documentation it ships. A host that cannot guarantee a single running instance is
disqualified. The third deployment artifact the program produces, WS-46's
scaffold-generated compose file, is a local development artifact outside that
family: it has no autoscaling or rolling-deploy operation to observe, and it is
single-instance by construction — the generated compose defines exactly one
server service, which WS-46's generated-project test asserts.

**New deployable app — `apps/playground`.** A demo agent backend plus a browser
frontend, structured like `examples/quickstart` (`backend/` + `frontend/`). It is
a first-class deployable rather than an example because it runs publicly and
carries abuse controls. It consumes only the public SDK surface, under the same
`no-restricted-imports` guard the quickstart example uses.

**The playground is designed around one takeaway, and one honest limit.** It
**cannot** demonstrate the product's central claim — that tools run on infra the
visitor controls — because on a hosted demo they run on ours. Pretending
otherwise would be the demo's worst failure mode. What it _can_ prove, without
asking anyone to trust a claim, is that **this is infrastructure, not a chat
widget**, delivered as four designed beats in this order:

| #   | Beat                                                                                                                                                                   | What the visitor concludes                                                                                                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Typed events, not text** — raw `ChatEvent` JSON toggleable beside the rendered chat                                                                                  | "I get `message_started` → `token` → `tool_call_started` → `tool_call_completed` → `message_completed`. I can build any UX on this — per-tool loading states, custom tool visualisations, whatever I want." |
| 2   | **A real round trip, including when it fails** — `callId`, the demo-configured timing budget, the measured duration, plus a deliberately failing/slow tool on a button | "A tool call is a network hop with identity, a budget, and timing — not something the model narrates. And I can see what happens when one hangs."                                                           |
| 3   | **Survives a dropped connection** — a drop control the visitor hits mid-stream, after which the demo re-attaches a fresh client to the same session                    | "The connection is not the session. It dropped, it came back, and my turn was still there. This was built by someone who thought about the network."                                                        |
| 4   | **The conversion beat** — the ~20 lines that produced the demo, beside it, with the command that reproduces it                                                         | "That is not much code, and I can have it locally in a minute."                                                                                                                                             |

Beat 2's failure path carries unusual weight: every demo shows the happy path,
and an infrastructure evaluator is silently asking _"what happens when a tool
hangs?"_ Answering unprompted is more persuasive than a third working tool.

All four are buildable on the **public** surface, but only after two corrections
the audit forced — the original claim that `onEvent()` and `disconnect()` cover
everything was false, checked datum by datum:

- **Deadline is not public.** `ChatEvent`'s tool events carry `callId`,
  `toolName`, and `status` only
  ([events.ts:81](../../packages/shared/src/types/events.ts)); `ToolContext`,
  `ToolCallContext`, `RunnerRequestContext`, and `RunnerRequest` omit a deadline
  too, and the runtime's timeouts are internal `AbortSignal`s. Beat 2 therefore
  shows the budget the **playground itself** configured in its own tool wrapper,
  beside a duration measured from the real `tool_call_started` /
  `tool_call_completed` pair. Adding `deadline` to the event union was considered
  and **rejected**: it would breach this program's no-runtime-feature-work rule
  and expand the semver surface of a package being frozen for publication.
- **`disconnect()` does not recover.** It sets `intentionalClose`, which is
  precisely what _suppresses_ reconnection
  ([client.ts:211](../../packages/react/src/client.ts:211)). Beat 3 therefore
  drops the connection and then re-attaches by constructing a **new** session
  client against the same session id — and the on-page copy says that, rather
  than implying an automatic reconnect the client deliberately does not perform.

With those two corrections the playground composes the public client rather than
extending `@swiftagent/react`, and no runtime or SDK surface is added.

**Credential topology (corrected 2026-08-19, audit round 2).** An earlier draft
required the playground mediator to _own the model-provider credential_. That is
architecturally impossible without forbidden work: the runtime exclusively loads
and consumes that credential — `apps/server/src/config.ts` validates
`OPENAI_API_KEY`/`ANTHROPIC_API_KEY`/`GOOGLE_API_KEY` and
`apps/server/src/container.ts:133-152` passes them directly into the
`ProviderRegistry` factories — and although `ProviderConfig` supports a
`baseUrl`, `buildContainer` exposes no configuration that would route provider
traffic through a mediator. Making the mediator own the key would mean either a
provider-proxy runtime feature or embedding the private server package in the
public-surface-only playground, both excluded. The corrected topology preserves
every enforcement property SC-09 actually needs: the **dedicated provider key is
configured only as environment on the playground's isolated runtime deployment**
(the standard `apps/server` path, with its provider-side budget cap), the
**mediator holds the runtime workspace API key** and is the sole enforcement
point for every limit, and the **browser holds no credential of either kind**.
Refusal frames are typed frames of the
playground's own mediator protocol — no new `ChatEvent` variants, no runtime or
SDK addition.

**Spend accounting cannot trust `RunRecord.tokenUsage` (corrected 2026-08-20,
audit round 5).** An earlier revision settled the ledger against terminal
`RunRecord` usage from `GET /v1/runs/:runId`. That value is structurally an
under-count for every multi-round run: `packages/runtime/src/loop.ts:181`
overwrites `lastUsage` on each provider round and completion persists only the
final round (`loop.ts:412-414`), and every successful playground tool call is
model → tool → model, so at least the first round's tokens are always missing.
Aggregating at the source is forbidden runtime work. The ledger therefore
charges conservatively instead of accurately: the mediator reserves each run's
maximum cost up front — derived from its own enforced message and token caps
and the cheap model's pricing — and **every reservation settles at its full
reserved amount**, for all four terminal statuses and (after a timeout) for
abandoned runs; a reservation is never released downward, and `tokenUsage` is
recorded as observability data only. The ceiling can only stop the demo early;
it can never be exceeded while the ledger reports compliance (SC-09).

**New package — `packages/create-swift-agent`.** A scaffold CLI. Deliberately
**unscoped** so `npx create-swift-agent` works, which is a documented exception to
the `@swiftagent/*` convention in `AGENTS.md`; it is the only such exception.

**New local registry harness.** A Verdaccio-backed local registry — a real npm
registry protocol endpoint, not a directory of tarballs or `file:` dependencies,
which cannot satisfy it — so scaffolded projects install `@swiftagent/*` as real
npm dependencies before anything is published. The registry-protocol requirement
is load-bearing: WS-46 must publish `create-swift-agent` **into** this registry
and resolve it through real `npx` (SC-06), which only a registry endpoint
supports. This makes the scaffold verifiable today and removes the temptation to
special-case unpublished packages in the generated project.

**The operator-facing artifact does not exist yet.** The server image is built
only for private ECR (`.github/workflows/deploy-dev.yml`), and
`docker-compose.yml` uses `build:` rather than `image:` — so a stranger's first
`docker compose up` compiles the whole monorepo from source. Successful
self-hosted infrastructure distributes a **prebuilt image** as its primary
artifact, because the two artifacts serve different people: published npm
packages serve the _SDK consumer_ writing `defineAgent`, while a published
container image serves the _runtime operator_ deploying the server. This program
targets the operator, so WS-50 publishes `apps/server` to GHCR, compose pulls it,
and the deploy template deploys it rather than building on the host. The ECR path
for AWS deploys is untouched.

**The two release surfaces are triggered differently, on purpose.** npm
publishing commits to a semver API surface and is effectively permanent once
released, so the release workflow fires only from an explicit manual
`workflow_dispatch` trigger — the owner presses it once when the program lands
(decision 4). That trigger is the **actual release path**, not an indefinite
gate: WS-44 delivers the armed workflow, the dry-run proof, and the release
runbook, and its checkpoint completes without anyone pressing anything. The
container image commits to no API surface and its references are replaceable,
so **it publishes automatically** with no trigger at all. The licence concern is
handled causally rather than procedurally: WS-50 depends on WS-44, so Apache-2.0
is always in the tree before any image is published. No workstream in this
program completes on a human approval step.

**The GHCR package must be made public once, manually (decisions 5 and 6).** A
newly published GHCR package defaults to **private** — packages inherit
repository access _permissions_, not visibility, so the repository being public
(it is, as of 2026-08-19) changes nothing here. The first push therefore
produces a package a stranger cannot pull anonymously — and a stranger's
`docker compose up` from a clean checkout is exactly an anonymous pull; a
successful authenticated push proves nothing about public distribution. GitHub
exposes **no API operation** to change package visibility (the REST packages
API offers list, get, delete, restore, and version operations only), so the one
supported mechanism is the manual UI step _Package settings → Danger Zone →
Change visibility → Public_, which is irreversible once public and only
possible once the package exists. WS-50 documents that step as a one-time
repository-configuration prerequisite performed by the owner after the first
publish. Per decision 6, the program does **not** claim the click happened or
that an anonymous pull succeeded: WS-50 ships a ready-to-run logged-out
`docker pull` verification command for the owner to run immediately after
clicking, and every in-program consumer of the image before the click —
the pulled-image equivalence check, CI compose pulls, and the WS-47 deploy —
**authenticates** to GHCR with documented registry credentials, which become
unnecessary once the package is public. The workstream's checkpoint asserts
the workflow, the publish, the digest pin, the documentation, and the
verification command — it does not block on, wait for, or assert the outcome
of the owner's click.

**The compose pin is a digest, and it has to be bootstrapped in two steps.**
"Immutable tag" is not a thing GHCR provides: GitHub's package lifecycle permits
container package versions to be removed and replaced, so any tag — version tags
included — can drift. The only intrinsically content-addressed reference is the
**sha256 manifest-list digest** produced by the multi-arch push, so compose pins
`image: ghcr.io/…@sha256:…`; version tags are published as human-readable
aliases, never as the pin. A digest cannot be referenced before it exists, so
WS-50 publishes first and commits the `image:` digest pin second, within the
same workstream. Upgrading means committing a new digest — that explicitness is
the point.

**Deploy target — managed host, not AWS.** The playground and the deploy template
target Fly.io/Railway, deliberately separate from the Terraform stack in
`infra/`. Playground availability must not be coupled to dev/staging/prod, and
vice versa. `infra/` is untouched by this program.

**Publishing posture inverts — for the public packages and their
public-consumer path, not for the workspace at large — and the roster is
closed over the TERMINAL repository, not today's.** The program itself adds
two workspace members before its final checkpoint, so a roster derived from
the current tree cannot stay exhaustive through its own execution (the round-4
audit's finding). At program end the workspace holds **four public packages**
— `@swiftagent/{sdk,react,shared}` plus `create-swift-agent`, which WS-46
creates **born public-postured** (`publishConfig.registry =
registry.npmjs.org`, `access: public`, `license: Apache-2.0`, no `private`
field) — and **ten private packages**: the nine current ones
(`@swiftagent/{api,db,gateway,models,observability,runtime,server}` and the
two quickstart example packages) plus `@swiftagent/playground`, which WS-48
creates **born `private: true`**. Going public changes where the public
packages point, not the privacy of the rest of the workspace, and
`AGENTS.md`'s rule that every other package is private remains true after the
flip. The ordering is deliberate: WS-44 sweeps every active surface that
exists **today**, packages created afterwards are born with the correct
posture by their creating workstreams, and WS-49 — the sole terminal
workstream — re-runs the repository-wide posture search over the terminal
tree so the exhaustiveness claim is checked against the repository that
actually exists at program end. Within today's domain the
repository is coherently _private_, and going public means changing all of
it in one workstream or leaving a contradiction. An earlier draft
listed five surfaces; the audit closed the current set by search, and it is twelve —
including one, `.npmrc`, that is **functional rather than documentary** and would
keep routing every consumer install to GitHub Packages no matter what the package
metadata said:

| Surface                    | Current state                                                                                                    | Evidence                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Package metadata           | `publishConfig.registry = npm.pkg.github.com`, `access: restricted`                                              | `packages/{sdk,react,shared}/package.json`                                                                        |
| License                    | `"license": "UNLICENSED"`, no repository `LICENSE` file                                                          | same three packages; `ls LICENSE*` finds nothing                                                                  |
| Changesets                 | `"access": "restricted"`                                                                                         | `.changeset/config.json`                                                                                          |
| Normative policy           | "Packages are currently private… publishes to a **restricted** registry… Do not remove `private`"                | `docs/policies/versioning.md` §1                                                                                  |
| Pack verifier              | _asserts_ the GitHub Packages registry                                                                           | `scripts/verify-pack.mjs`                                                                                         |
| **Registry routing**       | `@swiftagent:registry=https://npm.pkg.github.com` — **functional**, overrides package metadata for every install | `.npmrc`                                                                                                          |
| Repository directives      | "publish to GitHub Packages; every other package is `private`"                                                   | `AGENTS.md` line 119                                                                                              |
| System-state doc           | describes the restricted posture as current                                                                      | `docs/as-built.md`                                                                                                |
| Shipped package docs       | install instructions naming GitHub Packages                                                                      | `packages/{sdk,react,shared}/README.md`                                                                           |
| Entry documentation        | same                                                                                                             | `README.md`, `docs/quickstart.md`                                                                                 |
| Workflows                  | publish targets plus the CI consumer-install job that authenticates to GitHub Packages                           | `ci.yml`, `publish-sdks.yml`, `publish-sdks-prerelease.yml`                                                       |
| Executable install harness | runs against the restricted registry                                                                             | `test/acceptance/install-published.ts`, `install-registry.acceptance.test.ts`, `test/vitest.acceptance.config.ts` |

**Historical records are deliberately excluded from that sweep.** Superseded
program plans, task specifications, and as-built snapshots describe a posture
that _was_ true. They are preserved as historical dispositions, not rewritten —
the rule is that no **active** normative, functional, or shipped-documentation
surface may contradict the new posture.

The policy document is additionally **stale on a factual point**: it states every
package is `"private": true`, but the three publishable packages carry no
`private` field at all. That inaccuracy is corrected in the same pass.

**Contribution terms become live as soon as the project can accept an external
pull request.** There is
no `CONTRIBUTING.md` or `DCO` today — a pull-request template **does** already
exist at `.github/pull_request_template.md` (Description, Linked Workstream, and
Checklist sections), so WS-44 amends it with a DCO sign-off prompt rather than
creating a second one — and this program is
what makes external pull requests possible, so the terms belong here rather than
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

| Choice                                    | Rationale                                                                                                                                                                                                                                                                                          |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fly.io or Railway** (managed host)      | Lowest recurring cost for an always-on demo; provides managed Postgres + Redis; the same target serves the rung-2 deploy button, so the program dogfoods what it ships. Must support WebSockets and **pinning to exactly one instance**. Final pick made in WS-47 against a documented comparison. |
| **Verdaccio** (local npm registry)        | Lets the scaffold and its tests exercise the true `npm install` path with unpublished packages. Test-time dependency only; not shipped.                                                                                                                                                            |
| **Vite + React 19** (playground frontend) | Matches `examples/quickstart/frontend`; no new frontend stack.                                                                                                                                                                                                                                     |
| **DCO 1.1** (not a CLA)                   | Apache-2.0 §5 makes contributions inbound=outbound, so a CLA is unnecessary for the license to work. A `Signed-off-by` trailer plus a CI check is low-friction and standard. Accepted consequence: contributors keep copyright, so relicensing later needs their permission.                       |
| **Apache-2.0** (decided 2026-08-19)       | `UNLICENSED` becomes `Apache-2.0`, backed by a repository `LICENSE`. Chosen over MIT for the explicit patent grant and patent-retaliation clause — the clauses corporate legal review looks for in infrastructure a company embeds and deploys — and it matches comparable projects.               |

No changes to the runtime stack. No new runtime dependencies.

---

## Execution Shape

The workstream roster, dependencies, sizes, scopes, and exclusions are
canonical in [`oss-direction-manifest.json`](oss-direction-manifest.json)
(`workstreams[]`); the graph below is an architectural illustration derived
from those dependencies, kept for the causal reasoning around it — the
manifest is authoritative wherever they differ.

```
WS-51 Canonical Gate ──┬──► WS-43 Local Stack ──┬──► WS-50 Container Image ──► WS-47 Deploy ──┐
   Stability           │       Coherence         │     (GHCR, auto-publish;      Template     │
   (deterministic      │                         │      also needs WS-44)                     │
    pnpm test)         │                         │                                            ├──► WS-49
                       │                         ├──────────► WS-48 Playground App ───────────┤  Guardrails,
                       │                         │                                            │  Public Deploy &
                       │                         └──────────┐                                 │  Final Docs/Gate
                       │                                    │                                 │
                       └──► WS-44 Public Release ──┬────────┼──► WS-46 create-swift-agent ────┘
                              Readiness (armed)    │        │         (scaffold CLI)
                                                   └► WS-45 ┘
                                                      Local Registry Harness
```

WS-51 is the single root: it makes the gate every later checkpoint is judged on
deterministic. WS-44/45/46 (packaging and scaffold) proceed in parallel with
WS-47/48 (hosting and demo) once WS-43 lands, and **every chain joins at
WS-49**, which is the program's sole terminal workstream. That terminal position
is load-bearing twice over: WS-49 owns the SC-10 documentation pass that
describes `create-swift-agent` as built-and-verified, so it must depend on
WS-46 — the workstream that actually builds and verifies it — or the
orchestrator could green WS-49 while the claimed artifact does not exist; and
WS-49 owns the program-final SC-17 gate re-proof, which is only meaningful after
every workstream has added its packages and tests.

---

## Risk Register

| Risk                                                                                                                             | Impact                                                                                                                                                                                               | Mitigation                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The verification gate stays flaky, so a correct workstream fails its checkpoint                                                  | **High — an intermittently red gate makes every checkpoint unfalsifiable: a real regression and a timing artefact are indistinguishable, and each false red costs a replan cycle**                   | WS-51 is the graph root and a hard dependency of both otherwise-rootless workstreams; it removes the timing margin, audits for the same shape elsewhere, and proves stability by repeated cache-bypassed runs rather than one green run (SC-17)                                                                                                 |
| WS-43 is the program's real unknown, not its warm-up                                                                             | **High — every other workstream depends on it, and its true content (model config, workspace, API key, agent, runner keys, tool fixture) is provisioning work no existing script performs**          | Resized `S` → `L` with the bootstrap enumerated in SC-01 rather than left implicit; the smoke check must assert `tool_call_started` and `tool_call_completed` so a stack that merely connects cannot pass                                                                                                                                       |
| The bootstrap credentials or the deterministic fixture leak into a deployed environment                                          | **High — a known dev API key or a fixture provider reachable in the playground or a deployed template is a live vulnerability, not a test smell**                                                    | WS-43 excludes making any of it reachable outside local development; the deploy template (WS-47) and the playground (WS-49) must be inert or absent for that path, and each carries its own provisioning                                                                                                                                        |
| A managed host silently runs more than one instance (rolling deploys, autoscaling defaults, multi-machine templates)             | **High — session locks and replay buffers are process-local; a second instance breaks sessions with no error**                                                                                       | Single-instance pinning is an explicit acceptance criterion (SC-12) of both WS-47 and WS-49; host selection in WS-47 disqualifies any target that cannot guarantee it; the constraint and its rationale ship in the template's documentation                                                                                                    |
| A public image reference drifts, so "it works on my machine" diverges from what operators pull                                   | Medium — unreproducible bug reports; GHCR permits package versions to be removed and replaced, so even a version tag is mutable absent an enforcement mechanism GHCR does not provide                | WS-50 publishes version tags for humans but compose pins the **sha256 manifest-list digest** produced by the multi-arch push — the only intrinsically content-addressed reference — and the upgrade path (commit a new digest) is documented rather than implied                                                                                |
| A contributor's pull request is merged before contribution terms exist                                                           | Medium — that contributor retains copyright with no recorded grant, permanently complicating any later relicensing                                                                                   | WS-44 lands `CONTRIBUTING.md`, the DCO, and the `Signed-off-by` CI check as part of going public, so the terms exist before the repository can accept its first external PR                                                                                                                                                                     |
| Public playground abuse burns the owner's model API budget                                                                       | High — an uncapped demo is an open wallet                                                                                                                                                            | WS-49 is a dedicated workstream, not a checklist item: per-IP and per-session rate limits, hard message and token caps, short session TTLs, and a global daily spend ceiling                                                                                                                                                                    |
| The application-level spend ceiling is itself the thing that fails — a bug, a bypass, or an in-memory counter reset by a restart | High — the limiter's failure mode is an invoice, and an in-memory daily counter is really a per-uptime-window counter (realtime runbook §1)                                                          | Defence in depth in WS-49: the ceiling is persisted in Postgres rather than memory; a **dedicated provider API key carries a provider-side budget cap** enforced by the provider rather than by our code; a deliberately cheap default model shrinks the blast radius before any limiter fires; an alert fires at a fraction of the ceiling; and every reservation settles at its full reserved amount — `RunRecord.tokenUsage` is observability-only and never reduces a charge, since it under-reports every multi-round run (runtime overwrites `lastUsage` per provider round), so the ledger can only over-count, never under-count |
| The playground's limits are enforced where a visitor can remove them                                                             | **High — a limit implemented in the browser is a suggestion; the invoice is real**                                                                                                                   | SC-09 requires a trusted server-side mediator as the only enforcement point — the browser never holds the runtime API key or any provider credential, and the provider credential lives only in the playground runtime's own environment — with limits tested against a client that ignores the UI; browser-side controls are explicitly excluded from counting as enforcement                                                                                                                            |
| Going public is applied to some surfaces but not others                                                                          | High — a half-public repo is worse than a private one: `UNLICENSED` code on a public registry, or a policy doc contradicting shipped metadata                                                        | WS-44 owns the complete active surface set as one atomic checkpoint — all twelve tabulated in _Architecture Changes_, closed by repository-wide search rather than by recollection, with historical records explicitly preserved rather than rewritten                                                                                          |
| `.npmrc` keeps routing installs to GitHub Packages after the metadata flips                                                      | **High — `@swiftagent:registry` overrides package metadata, so consumers would be silently redirected to a registry they cannot read; this surface was missing from the original five-surface list** | The active surface set was closed by repository-wide search and is tabulated in _Architecture Changes_; SC-11 enumerates all twelve and WS-44 owns them as one checkpoint                                                                                                                                                                       |
| The first GHCR push produces a package nobody can pull                                                                           | Medium — an authenticated push succeeds and looks like success, while a clean-checkout `docker compose up` fails for every stranger                                                                  | The one-time owner UI step (Package settings → Change visibility → Public — no API operation exists, and packages default private regardless of repository visibility) is documented by WS-50 as a repository-configuration prerequisite performed after the first push, WS-50 ships the ready-to-run logged-out `docker pull` verification command for the owner to run after clicking (decision 6 — the program does not claim it succeeded), and every in-program consumer authenticates until then |
| The repository is already public while the packages are still `UNLICENSED` and no `LICENSE` file exists                          | High — publicly visible source with no licence grants readers no rights and contradicts the OSS intent; every day it persists is exposure                                                            | The owner made the repository public on 2026-08-19; WS-44 (which lands Apache-2.0, `LICENSE`, and contribution terms) sits directly behind the WS-51 root and should be scheduled at the earliest opportunity — nothing else in the graph gates it                                                                                              |
| `scripts/verify-pack.mjs` asserts the GitHub Packages registry and will fail the moment `publishConfig` changes                  | Medium — a red build blocking WS-44                                                                                                                                                                  | Named explicitly in WS-44's scope; the assertion and the metadata move in the same workstream                                                                                                                                                                                                                                                   |
| The scaffold cannot install unpublished packages                                                                                 | High — WS-46 is unverifiable without a solution                                                                                                                                                      | WS-45 delivers the local registry harness first and is a hard dependency of WS-46                                                                                                                                                                                                                                                               |
| Managed-host choice (Fly vs Railway) proves wrong after the template is written                                                  | Medium — rework in WS-47 and WS-49                                                                                                                                                                   | WS-47 begins with a documented comparison against fixed criteria (managed Postgres + Redis, WebSocket support, single-instance guarantee, idle cost, template format) and records the decision before implementation                                                                                                                            |
| Deploy-time migrations fail the drift preflight on a fresh managed-host database                                                 | Medium — a confusing first-deploy failure                                                                                                                                                            | WS-47 follows the forward-only path in the migrations runbook, runs `migrate` as an explicit release step, and verifies a clean first deploy end to end                                                                                                                                                                                         |
| A demo beat is specified against a surface that does not expose the data                                                         | Medium — discovered during implementation, it forces either a runtime change mid-program or a quietly dropped beat                                                                                   | Both gaps are already found and resolved in the plan: Beat 2's deadline is demo-owned and Beat 3 re-attaches a new client explicitly, each with file-and-line evidence in _Architecture Changes_; WS-48 excludes adding a surface to make a beat easier                                                                                         |
| The demo reads as a generic chat widget, or overstates what it proves                                                            | High — a generic demo does not convert, and implying the visitor's tools run on their own infra is a claim a hosted demo cannot back                                                                 | The takeaway and its four beats are specified in WS-48 and asserted by SC-16 rather than left to the author's judgement; over-claiming the tool boundary is an explicit exclusion, with the real proof deferred to the proposed reverse-runner-transport program                                                                                |
| Playground and deploy template drift from the real quickstart                                                                    | Medium — the demo stops proving anything                                                                                                                                                             | Both consume only the public SDK surface under the existing `no-restricted-imports` guard, and both are exercised in CI                                                                                                                                                                                                                         |
| Compose repair reveals deeper env-wiring breakage in the unified listener                                                        | Medium — WS-43 grows                                                                                                                                                                                 | WS-43 is scoped to compose and its smoke check; genuine server defects are reported, not silently absorbed                                                                                                                                                                                                                                      |
| A generated project ages badly against SDK changes                                                                               | Low now, high later                                                                                                                                                                                  | The generated project is built and run in CI, so SDK changes that break it fail the build                                                                                                                                                                                                                                                       |

---

## Success Criteria, Workstreams, and Scope

Canonical in [`oss-direction-manifest.json`](oss-direction-manifest.json):
success-criteria text (`successCriteria[]`), the workstream roster with
dependencies, sizes, scope, and exclusions (`workstreams[]`), program
constraints (`constraints`), and out-of-scope items (`outOfScope[]`) live
there and only there. This document refers to them by id (`SC-xx`, `WS-xx`)
and never restates their text. Earlier revisions restated them; audit round 5
removed the duplicates (findings 2df6331d, 00e9ed93). The reconciliation
histories below are preserved as historical record — where they cite
since-removed program sections (Scope In/Out, the Success Criteria list, the
Workstreams table), those dispositions were accurate when written.

---

## Replan Reconciliation (2026-08-19, audit round 2)

The second `plan-audit` pass ([`oss-direction-replan.json`](oss-direction-replan.json), generated 2026-08-19T22:00Z) returned one blocker and four majors, plus three minors, all wording/structure repairs — no new user-intent decision was required, and the three Requirements Decisions above stand unchanged. Every repair below preserves the criterion's intent; `criteriaPatches` was empty and nothing beyond the findings was changed. No task specs had been authored (`tasks/oss-direction/` was empty at replan time), so no superseded spec files exist to protect; workstream IDs are therefore retained and `planGeneration` advanced instead (`2026-08-19T23:45:00Z-osd12`).

### Finding 93d5fd3d — SC-09 mediator credential ownership (blocker, systemic)

Root cause: one credential-ownership rule repeated across four plan copies was incompatible with the runtime-owned provider construction. Repair: the mediator is the sole *enforcement* point and holds the runtime API key; the provider credential is configured only on the playground's isolated runtime deployment via the standard server environment.

| Checked subject | Disposition | Evidence |
|---|---|---|
| program Scope (In): mediator owns provider credential | fixed | Scope (In) abuse-controls bullet now states mediator = sole enforcement point; provider key configured only on the playground runtime deployment |
| program Risk Register provider-side backstop entries | fixed / already-correct | "limits enforced where a visitor can remove them" mitigation reworded (no mediator credential ownership); "application-level spend ceiling" row already placed the provider-side cap on the dedicated key, not the mediator — unchanged |
| program SC-09 | fixed | SC-09 rewritten: mediator holds runtime API key, provider key lives in runtime env, ledger settles via public `GET /v1/runs/:runId`, refusals are mediator-protocol frames |
| manifest successCriteria[SC-09] | fixed | same rewritten text in `oss-direction-manifest.json` |
| manifest workstreams[WS-49].scope | fixed | mediator include reworded, refusal-frame and ledger includes name the public surfaces, new exclude forbids mediator credential ownership / provider-proxy work |
| program Scope (In): playground abuse controls | fixed | same bullet as above |
| program Risk Register guardrail entries | already-correct | "Public playground abuse burns the owner's model API budget" row names limits, caps, TTLs, ceiling — no credential-ownership claim |
| manifest workstreams[WS-48].scope | already-correct | WS-48 excludes all guardrails ("owned by WS-49") and adds no credential language |
| apps/server/src/config.ts | already-correct (evidence) | validates the three provider keys (`config.ts:100`, `redactConfig` lines 152–154); plan now matches this reality |
| apps/server/src/container.ts | already-correct (evidence) | `container.ts:133-152` passes provider keys directly to `ProviderRegistry.register` |
| packages/models/src/registry.ts | already-correct (evidence) | registry resolves providers from registered configs; no proxy indirection exists |
| packages/models/src/types.ts | already-correct (evidence) | `ProviderConfig.baseUrl` exists but no server config exposes it — cited in the corrected Architecture Changes paragraph |
| packages/models/src/providers/openai.ts | already-correct (evidence) | consumes `apiKey` from provider config, in-process |
| packages/models/src/providers/anthropic.ts | already-correct (evidence) | same |
| packages/models/src/providers/google.ts | already-correct (evidence) | same |
| packages/runtime/src/loop.ts | already-correct (evidence) | runtime loop calls providers directly; timeouts are internal AbortSignals |
| packages/shared/src/types/events.ts | already-correct (evidence) | tool events carry callId/toolName/status only; refusal frames stay out of `ChatEvent` |
| packages/shared/src/types/run.ts | already-correct (evidence) | `RunRecord.tokenUsage` is the terminal usage the ledger settles against |
| packages/db/src/repositories/run-repo.ts | already-correct (evidence) | persists terminal run usage |
| packages/api/src/routes/runs.ts | already-correct (evidence) | `GET /v1/runs/:runId` exposes terminal usage on the public surface — now named by SC-09 |
| packages/sdk/src/client.ts | already-correct (evidence) | public client the mediator composes; no addition required |
| packages/react/src/client.ts | already-correct (evidence) | public surface unchanged; Beat 3 correction already recorded |

### Finding 4603aa14 — SC-10 missing WS-46 dependency (major, isolated)

Root cause: the dependency graph omitted the sole producer of the state WS-49 must claim.

| Checked subject | Disposition | Evidence |
|---|---|---|
| manifest workstreams[WS-49].dependencies | fixed | now `["WS-46", "WS-47", "WS-48"]` |
| program dependency graph | fixed | ASCII graph routes WS-46 into WS-49; prose explains why the edge is load-bearing |
| program critical-path description | fixed | fourth co-critical chain `WS-51 → WS-44 → WS-45 → WS-46 → WS-49` added |
| program SC-10 | already-correct | wording sound once ordering guarantees WS-46 precedes the documentation pass |
| manifest successCriteria[SC-10] | already-correct | same |
| manifest constraints.npmGate | already-correct | built-pending-release posture unchanged |
| manifest workstreams[WS-46].scope | already-correct | correctly defers SC-10 wording to WS-49 |
| manifest workstreams[WS-49].scope | fixed | SC-10 include now notes it runs after WS-46 exists as a dependency |
| manifest complete workstreams dependency roster | fixed / already-correct | only the WS-49 entry changed; all other edges re-checked and unchanged |
| README.md | already-correct (baseline evidence) | marks create-swift-agent Planned today; changed at execution time by WS-49, now correctly ordered |
| docs/vision.md | already-correct (baseline evidence) | same |
| docs/quickstart.md | already-correct (baseline evidence) | same |
| three package READMEs | already-correct (baseline evidence) | same |

### Finding 5b2ddc59 — SC-11 over-broad posture ban (major, systemic)

Root cause: a rule intended for the three public packages was written as a repository-wide prohibition contradicting nine intentionally private workspace packages.

| Checked subject | Disposition | Evidence |
|---|---|---|
| program SC-11 opening sentence | fixed | domain now "the three publishable packages and their public-consumer path"; nine private packages explicitly out of domain |
| manifest successCriteria[SC-11] opening sentence | fixed | same qualifier |
| program Architecture Changes posture-inversion claim | fixed | paragraph retitled and re-scoped: inversion's domain stated, nine private packages stay private, AGENTS.md every-other-package-private rule remains true post-flip |
| all SC-11 canonical plan and manifest copies | fixed | both copies carry the identical domain qualifier; post-edit search found no unqualified "No ACTIVE repository surface" phrasing |
| manifest constraints.publishingSurfaces | fixed | domain qualifier appended to the constraint |
| manifest workstreams[WS-44].scope | fixed / already-correct | includes were already scoped to the three packages; AGENTS.md include clarified to change only the registry target while preserving the every-other-package-private rule |
| pnpm-workspace.yaml | already-correct (evidence) | canonical roster containing the nine private manifests the qualifier protects |
| all 12 existing workspace package.json files | already-correct (evidence) | three publishable (no `private` field), nine `private: true` — now matching the criterion's stated domain |
| all twelve grouped active publishing surfaces | already-correct | the tabulated surface set is unchanged; only the domain sentence around it changed |
| repository-wide active posture search | already-correct | the audit's closure basis; the set remains twelve |
| historical exclusion directories | already-correct | historical records remain excluded and preserved unchanged |

### Finding 69a24ecf — SC-05 tarball/registry conflict (major, systemic)

Root cause: the harness definition conflated installing tarballs with operating an npm registry, while SC-06 requires registry-protocol publication and real `npx` resolution.

| Checked subject | Disposition | Evidence |
|---|---|---|
| manifest workstreams[WS-45].scope.includes[0] | fixed | "(or tarball-backed)" removed; registry must speak the npm registry protocol |
| program Architecture Changes: New local registry harness | fixed | paragraph now requires a registry-protocol endpoint and states why tarballs/file: cannot satisfy SC-06 |
| SC-05 implementation path | fixed | SC-05 (both copies) names the registry-protocol requirement explicitly |
| SC-06 registry publication and npx path | already-correct | SC-06 already required publish-into-registry + real npx; the conflict was on the WS-45 side |
| program SC-05 | fixed | as above |
| program SC-06 | already-correct | unchanged |
| manifest successCriteria[SC-05] | fixed | as above |
| manifest successCriteria[SC-06] | already-correct | unchanged |
| manifest technology.localRegistry | already-correct | already named Verdaccio with no tarball alternative |
| manifest workstreams[WS-45].scope | fixed | includes[0] repaired; remaining includes already registry-shaped |
| manifest workstreams[WS-46].scope | already-correct | requires publishing into the WS-45 registry and real npx resolution |
| current acceptance install harness | already-correct (evidence) | `test/acceptance/*` exercises a real registry install path today |
| scripts/verify-pack.mjs | already-correct (evidence) | uses `pnpm pack` to verify concrete `workspace:*` rewriting — also the basis for the SC-04 minor repair |

### Finding 641a9982 — SC-15 tag mutability (major, systemic)

Root cause: "immutable version tag" treated immutability as a tag property; only a digest is content-addressed in GHCR absent an enforcement mechanism it does not provide.

| Checked subject | Disposition | Evidence |
|---|---|---|
| program Architecture Changes: compose pin | fixed | paragraph rewritten: pin is the sha256 manifest-list digest; version tags are aliases, never the pin |
| program Risk Register: public image tag drift | fixed | row rewritten: GHCR tags mutable, compose pins the digest, upgrade = commit a new digest |
| program SC-15 | fixed | requires `image: ghcr.io/…@sha256:…`; no tag satisfies it |
| manifest constraints.artifactAudience | fixed | GHCR BOOTSTRAP sentence now names the manifest-list digest |
| manifest successCriteria[SC-15] | fixed | same rewritten text as program SC-15 |
| manifest workstreams[WS-50].scope | fixed | staged-bootstrap and tag-strategy includes pin the digest; summary says "at its sha256 manifest-list digest" |
| all SC-15 program and manifest copies | fixed | post-edit search found no remaining "immutable tag" phrasing in active plan copies |
| docker-compose.yml | already-correct (evidence) | still `build:` today; repointed at execution time by WS-50 per the corrected spec |
| apps/server/Dockerfile | already-correct (evidence) | build source for the multi-arch push that produces the digest |
| official GHCR container and package-version documentation | already-correct (evidence) | the mutability basis the repair encodes |

### Minor findings

| Finding | Subject | Disposition | Evidence |
|---|---|---|---|
| 40e0e5df | SC-04 pnpm vs npm dry run | fixed | SC-04 (both copies) and WS-44's include name `pnpm publish --dry-run` with packed-manifest inspection of `workspace:*` rewriting |
| bed07bcd | SC-13 pull-request template baseline | fixed | Architecture Changes prose corrected — `.github/pull_request_template.md` exists (verified on disk) — and WS-44 amends it rather than creating one |
| 2252af90 | SC-17 proof timing | fixed | SC-17 (both copies) requires the repeated cache-bypassed proof twice — at WS-51 and at the end of terminal WS-49 — and WS-49 gains that include; WS-49's new WS-46 dependency makes it the sole terminal workstream |

---

## Replan Reconciliation (2026-08-19, audit round 3 — human-required)

The third `plan-audit` pass (report generated 2026-08-19T22:46Z, outcome `human-required`) returned one blocker (SC-15: the `gh api` visibility mechanism does not exist) and one major (SC-09: no settlement rule for null-usage terminal runs). Per the human-required protocol the decisions were put to the user before any artifact edit; the user's answers are recorded above as **decisions 4 and 5** and are the sole authorization for the user-intent changes in this round. The user additionally chose, unprompted, to remove the npm publication gate entirely ("go directly to npm"), superseding decision 1 — that reversal is decision 4 and its consequences (SC-04, SC-06, SC-10, WS-44/45/46/49 scopes, Scope In/Out) are applied in this round. Ground truth verified during the round: `wildorder/swift-agent` is now a PUBLIC repository, and an anonymous GHCR tags request for `wildorder/swift-agent` returns DENIED — confirming the audit's premise that repository visibility does not make the (not-yet-existing) package pullable. `planGeneration` advanced to `2026-08-20T00:30:00Z-osd13`; no task specs exist yet, so workstream IDs are again retained.

### Finding 641a9982 — SC-15 impossible `gh api` visibility mechanism (blocker, systemic)

Root cause: a factual platform assumption (visibility mutable via API; packages inherit repo visibility) was copied across the plan. Repair per decision 5: the one-time step is the documented manual UI action, performed by the owner after first publish, proven by anonymous pull.

| Checked subject | Disposition | Evidence |
|---|---|---|
| program SC-15 | fixed | names the UI step, states no API exists and packages default private, keeps the anonymous-pull proof and digest pin |
| manifest successCriteria[SC-15] | fixed | same text |
| program Requirements Decision 2 | fixed | struck through and superseded by decision 5, with the false inheritance premise called out |
| program Architecture Changes GHCR visibility section | fixed | rewritten as "The GHCR package must be made public once, manually (decision 5)" — API absence, permissions-not-visibility inheritance, irreversibility, and repo-already-public all stated |
| program Risk Register first-GHCR-push mitigation | fixed | mitigation now cites the documented UI step + logged-out pull, not `gh api` |
| manifest constraints.ghcrVisibility | fixed | rewritten for decision 5 |
| manifest constraints.artifactAudience | fixed | GHCR bootstrap wording retained (digest); npm gate wording replaced by the manual-trigger release path of decision 4 |
| manifest workstreams[WS-50].scope | fixed | one-time visibility include rewritten; excludes updated to match |
| GitHub REST API endpoints for packages | already-correct (evidence) | list/get/delete/restore/version only — the basis the repair encodes |
| GitHub package visibility configuration guide | already-correct (evidence) | UI-only procedure, irreversible once public |
| GitHub package permissions guide | already-correct (evidence) | packages inherit access permissions, not visibility |
| manifest workstreams[WS-50].scope one-time visibility include | fixed | same include as above (listed separately by the report) |

### Finding 93d5fd3d — SC-09 null-usage terminal settlement (major, systemic)

Root cause: the accounting rule treated terminal `RunRecord.tokenUsage` as universally present, but only `complete()` persists usage; `fail()`, `cancel()`, and `timeout()` leave it null, and the terminal family {completed, failed, cancelled, timed_out} is exhaustive. Repair (intent-preserving, no decision needed): settle against actual usage when persisted; settle conservatively at the full reserved estimate when a terminal run's usage is null; never release a reservation below its reserved amount without persisted usage; no runtime change.

| Checked subject | Disposition | Evidence |
|---|---|---|
| completed | already-correct | `complete(runId, tokenUsage)` persists usage — actual-usage settlement applies |
| failed | fixed | covered by the conservative full-reservation settlement rule in SC-09 and WS-49 |
| cancelled | fixed | same rule |
| timed_out | fixed | same rule |
| program SC-09 | fixed | settlement rule for the exhaustive terminal family added |
| manifest successCriteria[SC-09] | fixed | same text |
| program Scope (In) abuse-controls rule | fixed | bullet states actual-usage vs conservative-null settlement |
| program Risk Register spend-ledger rule | fixed | spend-ceiling row's mitigation adds the null-usage conservative settlement |
| manifest workstreams[WS-49].scope | fixed | reserve-then-settle include carries the null-usage rule |
| packages/shared/src/types/run.ts | already-correct (evidence) | `RunRecord.tokenUsage` nullable — the fact the rule encodes |
| packages/db/src/schema/runs.ts | already-correct (evidence) | nullable usage column |
| packages/db/src/repositories/run-repo.ts | already-correct (evidence) | `complete()` writes usage; `fail()`/`cancel()`/`timeout()` write status only |
| packages/api/src/routes/runs.ts | already-correct (evidence) | returns the nullable RunRecord unchanged |
| packages/sdk/src/client.ts | already-correct (evidence) | `getRun` parses the nullable RunRecord unchanged |

---

## Replan Reconciliation (2026-08-20, audit round 4 — human-required)

The fourth `plan-audit` pass (report generated 2026-08-20T03:41Z, outcome `human-required`) returned one blocker (SC-15: the anonymous-pull proof and the no-human-dependent-checkpoint rule cannot both hold) and one major (SC-11: the exhaustive roster was closed over the current repository rather than the terminal one). The SC-15 decision was put to the user and recorded above as **decision 6** (autonomy wins; the program delivers mechanism plus a post-click verification command and never claims the pull succeeded; in-program consumers authenticate). SC-11's repair is intent-preserving and needed no decision. Ground truth re-verified during the round: anonymous GHCR access for `wildorder/swift-agent` still returns DENIED, confirming the package does not yet exist and the click is only possible after the first push. `planGeneration` advanced to `2026-08-20T04:15:00Z-osd14`; `tasks/oss-direction/` still contains no authored specs, so workstream IDs are retained.

### Finding 641a9982 — SC-15 proof vs autonomy contradiction (blocker, systemic)

Root cause: one manual prerequisite was simultaneously declared non-blocking and required to have completed for acceptance evidence that cannot exist before it. Repair per decision 6: no checkpoint waits on or asserts the click; the program ships the mechanism, the documented click, a ready-to-run logged-out verification command, and authenticated pulls for every in-program consumer.

| Checked subject | Disposition | Evidence |
|---|---|---|
| all affected canonical plan and manifest copies | fixed | every copy below reworded; post-edit search shows no remaining claim that an anonymous pull succeeds in-program |
| docker-compose.yml | already-correct (evidence) | still `build:` today; WS-50 repoints it at the digest, with CI pulls authenticated until the click |
| apps/server/Dockerfile | already-correct (evidence) | build source; unchanged by this repair |
| GitHub package permissions documentation | already-correct (evidence) | anonymous pulls only for public container packages — the fact decision 6 encodes |
| GitHub package visibility documentation | already-correct (evidence) | UI-only, irreversible procedure |
| complete GitHub REST Packages endpoint roster | already-correct (evidence) | no visibility mutation — no automatable fallback exists |
| Requirements Decision 5 | fixed | now ends by deferring the outcome claim to decision 6; decision 6 added |
| program Architecture Changes GHCR visibility section | fixed | retitled "(decisions 5 and 6)"; ships verification command, authenticates in-program consumers, checkpoint does not assert the click's outcome |
| program Scope (In) anonymous image claim | fixed | GHCR bullet no longer claims "proven from a logged-out context"; it delivers the documented step, the verification command, and authenticated-pull credentials |
| program Scope (Out) manual visibility action | fixed | new Scope (Out) bullet: performing or asserting the click is out of scope for every workstream (previously the exclusion lived only in the manifest) |
| program Risk Register first-GHCR-push mitigation | fixed | mitigation now says the verification command ships and in-program consumers authenticate; no success claim |
| program SC-15 | fixed | rewritten per decision 6; SC-07 and SC-14 also updated for authenticated in-program pulls |
| manifest constraints.ghcrVisibility | fixed | decision 6 recorded; no in-program success claim |
| manifest constraints.artifactAudience | fixed | bootstrap wording notes authenticated in-program verification |
| manifest successCriteria[SC-15] | fixed | same text as program SC-15 |
| manifest workstreams[WS-50].scope | fixed | includes ship the verification command and authenticated verification; excludes forbid waiting on or asserting the click |

### Finding 5b2ddc59 — SC-11 roster closed over the wrong repository (major, systemic)

Root cause: the completeness boundary was derived from the current workspace roster even though the manifest guarantees two additional members (`packages/create-swift-agent`, public; `apps/playground`, private) before the terminal checkpoint. Repair: SC-11 is evaluated over the terminal repository — four public packages, ten private — with WS-44 sweeping today's twelve surfaces, creating workstreams giving new packages their posture at birth, and terminal WS-49 re-running the repository-wide posture search.

| Checked subject | Disposition | Evidence |
|---|---|---|
| all affected canonical plan and manifest copies | fixed | every copy below reworded consistently |
| manifest packages complete planned roster | already-correct (evidence) | names packages/create-swift-agent (public) and apps/playground (private @swiftagent/playground) — the two members the roster now includes |
| manifest workstreams complete dependency roster | already-correct | WS-49 is already terminal (depends on WS-46/47/48), so its final sweep runs after both new packages exist; no edge change needed |
| pnpm-workspace.yaml | already-correct (evidence) | packages/* and apps/* globs guarantee both new directories become workspace members |
| all twelve current workspace package.json files | already-correct (evidence) | three public-bound (no private field), nine private:true — the "today" half of the terminal roster |
| planned packages/create-swift-agent/package.json | fixed | WS-46 include now requires it born public-postured: registry.npmjs.org, access public, Apache-2.0, no private field |
| planned apps/playground/package.json | fixed | WS-48 include now requires it born private:true |
| AGENTS.md Delivery convention | already-correct | "every other package is private" remains true under the terminal roster (ten private); WS-44's include already preserves it |
| all surfaces enumerated by constraints.publishingSurfaces | already-correct | the twelve-surface current sweep is unchanged; only its domain statement gained the terminal framing |
| repository-wide active private/restricted posture search | fixed | now runs twice: WS-44 closes today's set; WS-49 re-runs it over the terminal tree |
| program Architecture Changes publishing-posture roster | fixed | paragraph rewritten: terminal roster (4 public / 10 private), born-correct rule, WS-49 terminal re-search |
| program twelve-surface publishing table | fixed | intro now says "closed the current set by search" with the terminal additions handled by the born-correct rule |
| program Scope (In) public-npm surface sweep | fixed | bullet scoped to "currently existing" surfaces with the born-correct and terminal-sweep clauses |
| program SC-11 | fixed | rewritten over the terminal repository |
| manifest constraints.publishingSurfaces | fixed | terminal-roster domain, born-correct rule, WS-49 re-search |
| manifest successCriteria[SC-11] | fixed | same text as program SC-11 |
| manifest workstreams[WS-44].scope | fixed | sweep explicitly bounded to surfaces existing at WS-44 time |
| manifest workstreams[WS-46].scope | fixed | born-public posture include added |
| manifest workstreams[WS-49].scope final search | fixed | terminal repository-wide posture search added beside the final gate re-proof |

---

## Replan Reconciliation (2026-08-20, audit round 5)

The fifth `plan-audit` pass (report generated 2026-08-20T04:34Z, outcome `requires-replan`) returned two blockers (SC-09, SC-15) and one major (SC-12), plus two minors mandating the removal of duplicated manifest data from this document. The pipeline's automatic replanner (`codex exec`) was rejected twice on output-contract grounds and rolled back, so all closure happened in this session against the osd14 artifacts. No finding required a user-intent decision (`criteriaPatches` empty; the SC-09 repair follows the audit's own "conservative settlement" direction from round 3, now applied universally). `planGeneration` advanced to `2026-08-20T05:30:00Z-osd15`; `tasks/oss-direction/` still contains no authored specs, so workstream IDs are retained. Per the updated planning template and minor findings 2df6331d and 00e9ed93, the Workstreams table, Critical Path, Scope (In), Scope (Out), and Success Criteria sections were **deleted** from this document — the manifest is their single source of truth — with the dependency graph retained as architectural explanation (explicitly permitted by finding 00e9ed93).

### Finding 93d5fd3d — SC-09 tokenUsage under-counts multi-round runs (blocker, systemic)

Root cause: the plan treated a final-model-round usage field as aggregate run usage. Verified: `packages/runtime/src/loop.ts:181` assigns `lastUsage = chunk.usage` on every provider round and only the final value is persisted (`loop.ts:412-414`), so every tool-calling run (model → tool → model) under-reports. Repair: every reservation settles at its full reserved amount for all terminal outcomes and for abandoned runs; `RunRecord.tokenUsage` is observability-only and never reduces a charge; no runtime change.

| Checked subject | Disposition | Evidence |
|---|---|---|
| completed single-round runs | already-correct | full-reservation settlement covers them; the reservation is an upper bound on a single round by construction (caps × cheap-model pricing) |
| completed multi-round runs | fixed | the affected class — no longer settled against the under-counting field; charged at full reservation |
| failed runs | already-correct | were already full-reservation settled since round 3; rule unchanged, now uniform |
| cancelled runs | already-correct | same |
| timed_out runs | already-correct | same |
| packages/shared/src/types/run.ts | already-correct (evidence) | nullable `tokenUsage` — now advisory-only in the plan |
| packages/runtime/src/loop.ts | already-correct (evidence) | `lastUsage` overwrite at line 181; final-round persist at 412-414 — the fact the rule encodes; explicitly not modified |
| packages/db/src/repositories/run-repo.ts | already-correct (evidence) | `complete()` persists the single TokenUsage argument |
| packages/api/src/routes/runs.ts | already-correct (evidence) | returns the RunRecord unchanged; may still be read for observability |
| packages/sdk/src/client.ts | already-correct (evidence) | `getRun` parses it unchanged |
| completed runs with one or more successful tool iterations | fixed | member of the affected multi-round class; full-reservation settlement |
| completed runs with failed or rejected tool calls followed by model recovery | fixed | same class, same rule |
| all playground completed runs whose model is invoked more than once | fixed | same class, same rule |

Copies reconciled: manifest `successCriteria[SC-09]`, manifest `workstreams[WS-49]` reserve-then-settle include, program Architecture Changes new "Spend accounting cannot trust RunRecord.tokenUsage" paragraph, program Risk Register spend-ceiling row. The former program Scope (In) abuse-controls bullet and program SC-09 copy were removed entirely by the de-duplication, eliminating two copies rather than synchronizing them.

### Finding 4ab5c267 — SC-12 quantifies over a local artifact (major, isolated)

Root cause: an unqualified deployment-surface quantifier included the WS-46 scaffold-generated compose file, which has no managed rolling-deploy or autoscaling operation to observe. Repair: SC-12's family is exactly the two managed, publicly-hosted surfaces; the generated compose is named, excluded, and given its own applicable rule.

| Checked subject | Disposition | Evidence |
|---|---|---|
| WS-46 scaffold-generated compose file | fixed | SC-12 names it as outside the family with its own rule — single server service, no replica configuration, asserted by the WS-46 generated-project test; WS-46's template include carries the same rule |
| WS-47 managed-host deploy template | already-correct | remains in the family; its observation-based verification include is unchanged |
| WS-49 playground public deployment | already-correct | remains in the family; its observation-based verification include is unchanged |

Copies reconciled: manifest `successCriteria[SC-12]`, manifest `workstreams[WS-46]` template include, program Architecture Changes single-instance paragraph (now names the two-member family and the excluded local artifact).

### Finding 641a9982 — SC-15 WS-50 summary contradiction (blocker, isolated)

Root cause: one unreconciled workstream summary ("makes that package anonymously pullable") still promised the outcome of the owner-only post-program click — a leftover the round-4 pass missed while fixing the includes, excludes, and criteria.

| Checked subject | Disposition | Evidence |
|---|---|---|
| manifest successCriteria[SC-15] | already-correct | decision-6 wording from round 4 unchanged |
| constraints.ghcrVisibility | already-correct | decision-6 wording unchanged |
| constraints.artifactAudience | already-correct | authenticated in-program pull wording unchanged |
| manifest workstreams[WS-50].scope.summary | fixed | now: publishes automatically, pins the digest, documents the click and ships the post-click verification command — "never performs, waits on, or asserts that click" |
| all WS-50 includes | already-correct | round-4 wording unchanged |
| all WS-50 excludes | already-correct | round-4 wording (including the no-wait/no-assert exclude) unchanged |
| program decisions 5 and 6 | already-correct | unchanged |
| program GHCR architecture prose | already-correct | round-4 wording unchanged |
| program Scope In | fixed (removed) | section deleted in the de-duplication; its GHCR bullet no longer exists as a copy |
| program Scope Out | fixed (removed) | same |
| program SC-15 | fixed (removed) | the program-doc criteria copy was deleted; the manifest text is the only copy |
| program GHCR risk mitigation | already-correct | round-4 wording unchanged |

### Minor findings 2df6331d and 00e9ed93 — duplicated manifest data

Both fixed by restructuring this document: the Success Criteria list, Workstreams table, Critical Path, Scope (In), and Scope (Out) sections were deleted and replaced by the canonical-reference section above; the dependency graph remains as architectural explanation, labeled as derived from the manifest.
