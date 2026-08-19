# Swift Agent — Program Plan (Reverse Runner Transport)

## Program Overview

**Status:** Proposed — not planned. This document records intent and rationale
only. It has **no manifest and no workstreams**; run `plan-program` against it to
produce those when the work is scheduled.

**Product:** Swift Agent — see [`docs/vision.md`](../vision.md).

**Program scope:** Let a tool runner receive tool calls over a connection **it
opens outbound**, rather than by being an inbound HTTP server the runtime can
reach. Then use that transport to let a playground visitor define a tool and
watch it execute somewhere they control.

---

## Why

Today the runtime **pushes** tool calls: `POST` from
[`tool-executor-remote.ts:151`](../../packages/runtime/src/tool-executor-remote.ts)
to a Fastify server the SDK starts at
[`tool-runner.ts:251`](../../packages/sdk/src/tool-runner.ts). The runner must
therefore be publicly reachable by the runtime. Two consequences:

1. **Adoption friction.** A team running Swift Agent hosted, with tools behind a
   corporate firewall, needs a public ingress and a hole in their network before
   they can call their own database. An outbound connection removes that
   entirely — the same reason webhooks lost to tunnels for local development.
2. **The demo the project cannot currently give.** A hosted playground cannot
   demonstrate the product's central claim — that your tools run on infra you
   control — because on a hosted demo they run on ours. With a reverse
   transport, the runner can live **in the visitor's own browser tab**: their
   code, their machine, sandboxed by the browser, at zero sandbox cost and with
   no untrusted-code execution on our side.

The second is what prompted this program; the first is why it is worth building
regardless.

---

## Deliverables (sketch)

- **A reverse runner transport.** The runner opens and holds a connection to the
  runtime; tool calls arrive over it. Needs connection lifecycle and reconnect,
  auth over the socket (reusing scoped runner credentials), backpressure, and its
  own protocol version under the existing versioning policy.
- **Backwards compatibility.** The inbound HTTP runner stays supported. This is
  an additional transport, not a replacement — expand, do not contract.
- **A browser-hosted runner** for the playground: the visitor edits a tool
  definition, it executes in their tab, and the event panel shows the round trip.

---

## Open Questions

- Transport choice: WebSocket, SSE + POST callback, or long-poll. The gateway
  already runs `@fastify/websocket`, which argues for WebSocket.
- Does a browser-hosted runner reuse `@swiftagent/sdk`, or does it need a
  separate browser-safe runner package?
- How is a runner authenticated when it is anonymous and ephemeral, without
  weakening the scoped-credential model real deployments depend on?
- Does the reverse transport interact with the single-instance posture in
  [`docs/runbooks/realtime-operations.md`](../runbooks/realtime-operations.md)
  §6? A held connection is per-process state, like a WebSocket session.

---

## Scope (Out)

- Replacing or deprecating the inbound HTTP runner.
- Server-side code sandboxes (containers, microVMs, `isolated-vm`). The browser
  approach exists specifically to avoid running untrusted code on our infra; if
  that changes, it is a separate decision with its own cost and abuse analysis.
- Anything in [`oss-direction`](oss-direction-program.md). That program is
  distribution work and must not be delayed behind this.

---

## Prerequisite

`oss-direction` ships first. The playground has to exist before it can be made
interactive.
