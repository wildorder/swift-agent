# Roadmap & Deferred Work

The running ledger of things deliberately **not** being built right now, and why.
Its job is to keep good ideas from being lost and bad ones from being
re-litigated.

- **Programs in flight** live in [`docs/programs/`](programs/) with a manifest
  and workstreams.
- **Shipped behaviour** lives in [`docs/as-built.md`](as-built.md).
- **Positioning and non-goals** live in [`docs/vision.md`](vision.md) — anything
  contradicting it is a vision change, not a roadmap entry.

**Status key:** `proposed` — written up, not scheduled · `idea` — recorded, not
worked through · `deferred` — considered and consciously postponed ·
`rejected` — decided against, kept so it is not re-proposed.

---

## Current program

| Program | Status | Document |
| --- | --- | --- |
| OSS Direction — playground, scaffold, deploy template, container image, public-release readiness | planning | [oss-direction-program.md](programs/oss-direction-program.md) · [manifest](programs/oss-direction-manifest.json) |

## Next up

| Item | Status | Where recorded | Notes |
| --- | --- | --- | --- |
| **Reverse runner transport** + browser-hosted runner for an interactive playground | proposed | [reverse-runner-transport-program.md](programs/reverse-runner-transport-program.md) | Removes the requirement that a customer's tool runner be publicly reachable; enables a demo that actually proves the tool boundary. Needs a `plan-program` run to get workstreams. Depends on `oss-direction`. |
| **Docs site** | deferred | this file | The usual primary asset for OSS infrastructure. Deferred while `docs/` and the README carry it. |
| **Launch** — README demo recording, writeup, Show HN | deferred | this file | Not engineering work, which is why it is out of `oss-direction`. Building the artifacts and never announcing them is the common way good OSS stays unused. |

## Ideas & requests

| Item | Status | Where recorded | Notes |
| --- | --- | --- | --- |
| **`bedrock/*` model provider** | idea | [vision.md ▸ Candidate Future Work](vision.md) | For adopters who can only reach models through an existing AWS agreement. Not a better spend control than direct provider keys — AWS Budgets alert rather than hard stop. |
| **Retention modes** (`none` / `metadata` / `full`) | idea | this file | Runtime-level ephemeral sessions with content-redacted traces. Largely moot for self-hosters, who own the database; matters if a hosted tier ever exists. |
| **Bring-your-own-key playground mode** | deferred | [oss-direction manifest ▸ WS-49 excludes](programs/oss-direction-manifest.json) | The escape hatch if playground spend gets uncomfortable. Rejected for now because it breaks the zero-friction 60-second demo. |
| **Community scaffolding** — code of conduct, issue templates | deferred | [oss-direction ▸ Scope (Out)](programs/oss-direction-program.md) | `CONTRIBUTING.md` and the DCO are in `oss-direction` because contribution terms are part of the licensing posture; the rest is not urgent. |
| **Hosted tier** — multi-tenant service, billing, signup, dashboard | idea | [vision.md ▸ Distribution & Deployment](vision.md) | Architecturally possible (workspaces, API keys, scoped runner credentials already exist). A convenience for people who do not want to operate Postgres — never the pitch. |

## Decided against

| Item | Status | Where recorded | Why |
| --- | --- | --- | --- |
| **Durable execution layer** (long-running workflows, checkpointing, retries, dead-letter) | rejected | [vision.md ▸ Scope: Phase 2](vision.md) | The entire product of well-funded incumbents; no target persona has asked for it; breadth is a liability under an open-source model. The real async need is served by server-driven runs plus a completion webhook. |
| **A CLA / copyright assignment** | rejected | [oss-direction ▸ constraints.contributionTerms](programs/oss-direction-manifest.json) | Apache-2.0 §5 already makes contributions inbound=outbound, so a CLA is not needed for the license to work. Accepted consequence: contributors keep copyright, so relicensing later needs their permission. |
| **Server-side code sandboxes** for the playground (containers, microVMs, `isolated-vm`) | rejected | [reverse-runner-transport-program.md ▸ Scope (Out)](programs/reverse-runner-transport-program.md) | Running untrusted code on our infra brings cost, boot latency, idle reaping, and an abuse surface. The browser-hosted runner gets the same demo with none of it. |
| **Horizontal scaling** (shared session lock, shared replay, cross-instance fanout) | rejected | [realtime-operations.md §6](runbooks/realtime-operations.md) | Realtime state is process-local by design in this phase. Every deployment surface pins to one instance. |

---

## Adding an entry

Add a row with a status, a link to wherever the reasoning actually lives, and a
sentence of *why* — not just *what*. An entry with no rationale gets
re-proposed in three months. When something graduates, move it to **Current
program** and give it a real program document and manifest via `plan-program`.
