# @swiftagent/playground

The Swift Agent playground: the demo application built around one stated
takeaway — **"this is infrastructure, not a chat widget."** It is a single
private workspace package containing an SDK agent backend (`backend/`) and a
Vite + React frontend (`frontend/`), composed entirely from the public
`@swiftagent/sdk`, `@swiftagent/react`, and `@swiftagent/shared` package roots.

## The four beats

1. **Typed events, not text.** The event panel renders the raw `ChatEvent`
   JSON of the actual received events, toggleable against the prettified chat,
   so you see `message_started → token → tool_call_started →
   tool_call_completed → message_completed` and can build any UX on it.
2. **A tool call is a real round trip — including when it fails.** Each tool
   call shows its `callId`, its **demo-owned** time budget (set by this demo's
   `withBudget` wrapper and served via `/api/demo-config` — it is not a
   protocol field), and a duration measured from the real
   `tool_call_started`/`tool_call_completed` arrival pair correlated by
   `callId`. A button asks the agent to call `unreliable_service`, a tool that
   deliberately exceeds its budget, so the `status: 'failed'` path is
   demonstrated rather than hidden.
3. **The session survives a dropped connection.** A control drops the
   connection mid-stream via the client's `disconnect()` — which intentionally
   suppresses that client's reconnection. Recovery constructs a **new**
   `createChatSession` client against the **same** session id and appends its
   events to the same feed. The session — not the socket — is the durable
   thing; while the run is still active, the server replays the active run's
   buffered events to the new connection on the same instance.
4. **The conversion beat.** The ~20-line `defineAgent`/`tool` composition in
   [`backend/src/agent.ts`](./backend/src/agent.ts) is served verbatim on the
   page (drift-guarded by a unit test), beside the one command that reproduces
   the whole stack locally.

## Run locally (against the WS-43 stack)

From the repo root, bring up the self-provisioned local stack:

```sh
docker compose up
```

This provisions Postgres, Redis, the server (port 3000), a workspace, a
generated dev API key, and a zero-cost deterministic tool-calling fixture
model. The dev API key lands in `./.swiftagent-local/dev-api-key` (and in the
`bootstrap` service's log output).

Then start the playground backend and frontend (two terminals, from the repo
root):

```sh
# Terminal 1 — backend (agent + tool runner + /api routes on port 4100)
SWIFT_AGENT_API_KEY=$(cat ./.swiftagent-local/dev-api-key) \
SWIFT_AGENT_BASE_URL=http://localhost:3000 \
PLAYGROUND_MODEL=fixture/tool-call \
pnpm --filter @swiftagent/playground dev:backend

# Terminal 2 — frontend (Vite dev server, proxies /api to the backend)
pnpm --filter @swiftagent/playground dev:frontend
```

`PLAYGROUND_MODEL=fixture/tool-call` points the agent at the local stack's
deterministic tool-calling fixture, so the demo runs with zero provider cost.
Without the override, the agent defaults to a real, inexpensive model
(`anthropic/claude-3-5-haiku`), which requires a configured provider.

## What this demo does — and does not — prove

- It **does** show the public SDK/react surface end to end: typed events, real
  tool round trips (including the failure path), session-level durability
  across an explicit reconnect, and the tiny amount of code behind it. No
  runtime, SDK, or react feature was added to make it work.
- It **does not** demonstrate the product's central claim that tools run on
  infrastructure the visitor controls. In this hosted demo, the tools run on
  the demo's own backend. When you run the SDK yourself — for instance via the
  `docker compose up` path above — your tools execute in your own process; that
  is what the SDK is for.

Public deployment, rate limiting, spend caps, and abuse controls are
deliberately out of scope here (they belong to the deployment workstream).
