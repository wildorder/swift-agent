# WS-48: Playground Application

## Goal

Build the demo application the OSS-direction program deploys publicly in WS-49: a new deployable app at `apps/playground` — an SDK agent backend with two to three genuinely useful tools plus a Vite/React frontend — designed around **one stated takeaway**: _"this is infrastructure, not a chat widget."_

The takeaway is delivered by **four designed beats**, in this order (SC-16):

1. **Typed events, not text.** The event panel renders the raw `ChatEvent` JSON, toggleable against the prettified chat view, so a visitor sees `message_started → token → tool_call_started → tool_call_completed → message_completed` and concludes they can build any UX on it.
2. **A tool call is a real round trip — including when it fails.** Each tool call surfaces its `callId`, the **demo-owned** timing budget, and a duration measured from the real `tool_call_started` / `tool_call_completed` event pair. One tool deliberately times out or errors, triggerable by a button, so the failure path is demonstrated rather than hidden — an infrastructure evaluator is silently asking _"what happens when a tool hangs?"_, and the demo answers unprompted.
3. **The session survives a dropped connection.** A control the visitor hits mid-stream drops the connection; recovery is performed by constructing a **new** session client against the **same** session id, with on-page copy that describes what actually happens (no claim of automatic reconnect).
4. **The conversion beat.** The ~20 lines of `defineAgent`/`tool` that produced the demo are shown beside it, plus the one command that reproduces it locally.

This workstream runs **locally and trusted** against the WS-43 stack. The public deployment, the live URL, and every guardrail (rate limits, spend caps, abuse controls, mediator) are owned by WS-49. The playground **cannot** demonstrate the product's central claim that tools run on infra the visitor controls — on a hosted demo they run on ours — and its copy must never imply otherwise; proving the tool boundary for real belongs to rungs 2/3 and the proposed reverse-runner-transport program.

The new `@swiftagent/playground` package is **born `"private": true`** — it joins the ten-package private roster of SC-11 and is never swept by WS-44, which precedes it.

## Traceability

- **SC-16** — All four demo beats delivered on the **public** SDK/react surface with **no runtime or SDK addition**: raw `ChatEvent` JSON toggleable beside the rendered chat; tool calls showing `callId`, the demo-configured timing budget, and a measured duration from the real event pair, with a deliberately failing tool on a button; a mid-stream drop control with recovery via a new session client against the same session id and honest on-page copy; the agent source plus the reproduce-locally command on the page.
- **SC-08 (partial — the application half)** — WS-48 builds the application that, once WS-49 deploys it, streams tokens and surfaces at least one tool call in the event/trace panel with its start, completion, and duration. The public-URL half of SC-08 is WS-49's.
- **SC-11 (contribution)** — `apps/playground/package.json` is created `"private": true` with no `publishConfig`, so the terminal-tree posture sweep WS-49 runs finds it correctly postured at birth.
- **Gate** — `pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm test` all green with `apps/playground` in the tree; the package is exercised in CI the same way `examples/quickstart` is (workspace membership in the Build & Lint and Unit Tests jobs). This feeds the program-final SC-17 re-proof WS-49 owns.

## Dependencies

- **WS-43 — Local Stack Coherence.** Provides the working end-to-end local stack the playground runs against during development and testing: a repaired `docker-compose.yml` whose published port and `PUBLIC_WEBSOCKET_URL` match the single listener on `API_PORT`, and a self-provisioning bootstrap that establishes a server-accepted model configuration, a workspace, a **usable raw dev API key** surfaced to the developer, a registered tool-bearing agent, runner signing/verification keys with a reachable runner, and a **deterministic tool-calling model fixture**. The playground's "reproduce locally" command (Beat 4) and its guest-session creation both target this stack; its integration-style tests reuse the deterministic fixture so no test depends on a live provider deciding to call a tool. WS-48 consumes this wiring and must not redefine any of it.

## Context Files (Agent MUST read before implementing)

- `C:\dev\swift-agent\CLAUDE.md` — conventions (Zod schemas as source of truth; forced verification via the four gate commands; re-read before editing; grep every reference category when touching a name).
- `C:\dev\swift-agent\docs\programs\oss-direction-manifest.json` — canonical scope: `workstreams[WS-48]` includes/excludes, `constraints.playgroundTakeaway`, `constraints.publishingSurfaces` (born-private rule), SC-16/SC-11/SC-08, and `outOfScope[]` (notably the rejected `deadline` field).
- `C:\dev\swift-agent\docs\programs\oss-direction-program.md` — the four-beat table, the two audit corrections (deadline is demo-owned; `disconnect()` suppresses reconnection), and the "infrastructure, not a chat widget" framing the copy must land.
- `C:\dev\swift-agent\packages\shared\src\types\events.ts` — the complete `ChatEvent` union. **Verified:** `ToolCallStartedEvent` (lines 22–28) carries `callId`, `runId`, `sessionId`, `toolName`; `ToolCallCompletedEvent` (lines 30–37) adds `status: ToolCallStatus` only. The Zod schemas (lines 80–95) are `.strict()` — **no deadline field exists anywhere in the union, and none may be added.** (The program doc cites "events.ts:81"; that is the Zod `ToolCallStartedEventSchema` — the TS types start at line 22. Same fact, both locations.)
- `C:\dev\swift-agent\packages\shared\src\types\tool-call.ts` — `ToolCallStatus = 'started' | 'completed' | 'failed'`. The failure beat surfaces `tool_call_completed` with `status: 'failed'`; there is no `'timeout'` status, so a budget breach in the demo tool wrapper must resolve to `'failed'` (see Design Notes).
- `C:\dev\swift-agent\packages\react\src\client.ts` — `createChatSession` (the public vanilla client), URL resolution from the API-provided `websocketUrl`, the reconnect/backoff machinery, and `disconnect()` at lines 211–226: it sets `intentionalClose = true` (line 212), clears the retry timer, nulls the socket handlers, and closes — **deliberately suppressing reconnection** (`connect()` returns immediately when `intentionalClose` is set, line 110; `scheduleReconnect` also bails on it, line 175). Beat 3's recovery must therefore construct a **new** client.
- `C:\dev\swift-agent\packages\react\src\types.ts` — `CreateChatSessionOptions` (lines 32+): `sessionId` (correlation only), `token` (fallback), `websocketUrl` (canonical, from `POST /v1/sessions`, used verbatim).
- `C:\dev\swift-agent\packages\react\src\index.ts` — the public barrel: `createChatSession`, `useAgentChat`, and the exported types. The playground composes **only** these.
- `C:\dev\swift-agent\packages\sdk\src\index.ts` / `app.ts` / `tool.ts` — `createAgentApp`, `defineAgent`, `tool` (Zod `inputSchema` + `execute(input, ctx)`), `app.agent()`, `app.listen()` (starts the tool runner; requires `RUNNER_TOKEN_PUBLIC_KEY` + `RUNNER_WORKSPACE_ID`), `app.sessions.create()` (returns `sessionId`, `clientToken`, `websocketUrl`).
- `C:\dev\swift-agent\examples\quickstart\backend\src\server.ts` — the structural model: tools + agent defined and exported for unit tests, env reads only inside `main()`, a Fastify session-mint route (`GET /api/session`) that keeps the workspace API key server-side and hands the browser only `{ sessionId, token, websocketUrl }`, `app.listen()` for the runner, and the run-directly-only guard.
- `C:\dev\swift-agent\examples\quickstart\frontend\src\App.tsx` — the frontend model: fetch `/api/session`, thread `websocketUrl` verbatim, never construct a gateway URL client-side.
- `C:\dev\swift-agent\examples\quickstart\backend\eslint.config.js` and `C:\dev\swift-agent\examples\quickstart\frontend\eslint.config.js` — the `no-restricted-imports` public-API guard (bans `@swiftagent/*/dist`, `@swiftagent/*/dist/*`, `@swiftagent/*/src`, …). Mirror both for the playground's backend and frontend source trees.
- `C:\dev\swift-agent\pnpm-workspace.yaml` — globs: `packages/*`, `apps/*`, `examples/*`, `examples/*/*`. **Note:** `apps/*` matches `apps/playground` but NOT `apps/playground/backend` — see Design Notes for the one-package consequence.
- `C:\dev\swift-agent\.github\workflows\ci.yml` — how the quickstart is exercised: it is a workspace member, so the Build & Lint job (typecheck/lint/build) and Unit Tests job cover it with no dedicated job; the acceptance job is separate (WS-42) and not this workstream's concern. The playground rides the same workspace path.
- `C:\dev\swift-agent\docs\runbooks\realtime-operations.md` — §2 (fanout), §3 (process-local replay buffer, replayed on reconnect to the same instance while the run is active), §5 (reconnect-replay semantics). Beat 3's honest copy and its "what actually happens" wording are grounded here.
- `C:\dev\swift-agent\.claude\...\memory` note "Workspace deps must be declared": every `@swiftagent/*` import in `apps/playground` MUST be declared in its `package.json` — undeclared imports pass CI via tsconfig paths but crash a production Docker build after `--prod` pruning.

## Package

`apps/playground` — **NEW**, workspace package `@swiftagent/playground`, `"private": true`.

(`packages/sdk` and `packages/react` are **consumed, not modified**. `.github/workflows/ci.yml` is modified only if the playground's tests need something the workspace path does not already provide — expected: no change.)

## Files Touched

All NEW unless marked otherwise:

- `apps/playground/package.json` — name `@swiftagent/playground`, `"private": true`, **no** `publishConfig`, `"type": "module"`; scripts: `build` (backend `tsc` + frontend `vite build`), `typecheck`, `lint`, `test`, `dev:backend` (`tsx backend/src/server.ts`), `dev:frontend` (`vite`). Declares every `@swiftagent/*` dependency it imports (`@swiftagent/sdk`, `@swiftagent/react`, `@swiftagent/shared`) as `workspace:*`.
- `apps/playground/tsconfig.json` (+ `tsconfig.backend.json` / `tsconfig.frontend.json` as needed) — strict, ESM, matching the quickstart's compiler posture.
- `apps/playground/eslint.config.js` — extends the root config; applies the `no-restricted-imports` public-API guard to both `backend/src/**` and `frontend/src/**` (mirror the two quickstart configs).
- `apps/playground/backend/src/agent.ts` — the demo agent: `defineAgent` + the tool roster, exported for tests and for the Beat 4 source display. This file is deliberately small (~20 lines of `defineAgent`/`tool` composition) because it IS the conversion beat's exhibit.
- `apps/playground/backend/src/tools/` — the tool implementations: two to three genuinely useful tools plus the deliberately failing/slow tool, and the demo-owned budget wrapper (see Design Notes).
- `apps/playground/backend/src/server.ts` — Fastify app: `createAgentApp`, `app.agent(...)`, `app.listen()`, `GET /api/session` (guest session mint — workspace API key stays server-side), `GET /api/demo-config` (the demo-owned tool budgets + the Beat 4 source text + reproduce command).
- `apps/playground/backend/src/__tests__/` — unit tests (see Tests).
- `apps/playground/frontend/index.html`, `apps/playground/frontend/vite.config.ts` (root `frontend/`, dev proxy `/api` → backend) — Vite + React 19, same stack as `examples/quickstart/frontend`.
- `apps/playground/frontend/src/main.tsx`, `App.tsx` — session bootstrap + layout.
- `apps/playground/frontend/src/session.ts` — the composed vanilla-client session controller: wraps `createChatSession`, records every raw `ChatEvent` with an arrival timestamp, exposes drop/recover (see Design Notes). This module — not a new hook in `@swiftagent/react` — is where Beat 3 lives.
- `apps/playground/frontend/src/components/` — `EventPanel` (raw JSON toggle — Beat 1), `ToolCallCard` (callId, budget, measured duration, status — Beat 2), `ConnectionControls` (drop + recover + honest copy — Beat 3), `SourcePanel` (agent source + reproduce command — Beat 4), chat rendering.
- `apps/playground/frontend/src/__tests__/` — unit tests (see Tests).
- `apps/playground/README.md` — what the playground is, the local run path against the WS-43 stack, and the explicit statement of what the hosted demo does and does not prove.
- `.github/workflows/ci.yml` **(MODIFY only if required)** — expected NO change: `apps/*` workspace membership already routes the playground through Build & Lint and Unit Tests exactly as `examples/quickstart` is routed. If any playground test needs an env var or service the jobs do not provide, prefer removing that need over editing CI.

## Existing Interfaces to Consume

**`ChatEvent` tool events** (`packages/shared/src/types/events.ts:22-37`) — the complete public data for Beats 1 and 2; note there is **no deadline and no timing field**:

```typescript
export type ToolCallStartedEvent = {
  type: 'tool_call_started';
  callId: string;
  runId: string;
  sessionId: string;
  toolName: string;
};

export type ToolCallCompletedEvent = {
  type: 'tool_call_completed';
  callId: string;
  runId: string;
  sessionId: string;
  toolName: string;
  status: ToolCallStatus; // 'started' | 'completed' | 'failed' (tool-call.ts)
};
```

**`createChatSession` + `disconnect()`** (`packages/react/src/client.ts`) — the vanilla client Beat 3 composes; `disconnect()` is the drop control and is precisely what suppresses reconnection:

```typescript
function disconnect(): void {
  intentionalClose = true;          // line 212 — connect()/scheduleReconnect() bail on this
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (ws) {
    ws.onclose = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onopen = null;
    ws.close();
    ws = null;
  }
  setStatus('disconnected');
}
```

`intentionalClose` is per-client-instance state with no reset path — a disconnected client can never reconnect. Recovery therefore constructs a **new** `createChatSession(...)` with the same `sessionId`/`websocketUrl`.

**`CreateChatSessionOptions`** (`packages/react/src/types.ts:32+`) — `sessionId` (message-id correlation only; the gateway derives the session from the JWT), `token` (fallback when the URL is bare), `websocketUrl` (the canonical `wss://…/v1/stream?token=<jwt>` from `POST /v1/sessions`, used verbatim).

**`tool()`** (`packages/sdk/src/tool.ts`) — Zod `inputSchema` (must expose `.safeParse`) + `execute(input, ctx)`; the returned definition is frozen:

```typescript
export function tool<TInput, TResult>(
  config: ToolDefinition<TInput, TResult>,
): ToolDefinition<TInput, TResult>;
```

**The quickstart session-mint route** (`examples/quickstart/backend/src/server.ts:76-86`) — the guest-session pattern to replicate: the browser gets a short-lived client token + the canonical `websocketUrl` and never sees the workspace API key:

```typescript
server.get('/api/session', async () => {
  const session = await app.sessions.create({
    agentName: 'support-assistant',
    userId: 'demo-user',
  });
  return {
    sessionId: session.sessionId,
    token: session.clientToken,
    websocketUrl: session.websocketUrl,
  };
});
```

**The quickstart `no-restricted-imports` guard** (`examples/quickstart/{backend,frontend}/eslint.config.js`) — the enforcement mechanism for "public surface only"; mirror its `patterns` group (`@swiftagent/*/dist`, `@swiftagent/*/dist/*`, `@swiftagent/*/src`, …) for both playground source trees.

## Design Notes

- **One workspace package, quickstart-shaped directories.** `examples/quickstart` is two workspace packages (via the `examples/*/*` glob), but `pnpm-workspace.yaml` globs only `apps/*` — `apps/playground/backend` would NOT be a workspace member — and the manifest/SC-11 count `@swiftagent/playground` as exactly **one** private package. So the playground is a **single** package at `apps/playground` containing `backend/` and `frontend/` source directories (Vite `root: 'frontend'`), structured *like* the quickstart's backend/frontend split without adding workspace members or touching `pnpm-workspace.yaml`. This is a deliberate, load-bearing deviation from the quickstart's two-package layout; do not "fix" it by editing the workspace globs.

- **Born private.** `package.json` carries `"private": true`, no `publishConfig`, no `license` requirement for publication (Apache-2.0 at the repo root covers the tree; adding `"license": "Apache-2.0"` to the manifest is fine and consistent with WS-44). This package joins the ten-package private roster and must survive WS-49's terminal posture sweep unchanged.

- **Tool roster — two to three genuinely useful tools whose calls are worth watching, plus the failure tool.** Required properties (the specific picks may vary if these all hold): (a) **no provider or third-party API key** — WS-49 deploys this publicly and every secret is a liability; (b) **no visitor-controlled URLs or hosts** — no generic fetch/browse tool (SSRF surface WS-49 would have to defuse); (c) **visible, honest latency** — a real network hop or real computation, so the measured duration means something; (d) deterministic enough to demo. Reference roster:
  1. `get_weather` — current conditions via the keyless Open-Meteo API for a named city (fixed host, geocode + forecast; a real network round trip with real latency).
  2. `calculate` — a small safe arithmetic-expression evaluator (recursive-descent over numbers/operators — **never** `eval`), demonstrating a fast in-process tool for duration contrast.
  3. `unreliable_service` — the Beat 2 failure tool: sleeps past its configured budget (or throws), so its wrapper aborts it and the run surfaces `tool_call_completed` with `status: 'failed'`.

- **Beat 2 — the timing budget is DEMO-OWNED; the measured duration is event-derived.** No deadline exists on any public surface (`ChatEvent`, `ToolContext`, the runner protocol all omit it) and **adding one is explicitly rejected** (manifest `outOfScope[]`, decision 3). The design:
  - A `withBudget(toolDef, budgetMs)` wrapper in `backend/src/tools/` races `execute` against a demo-owned timer; on breach it throws (→ the runtime reports `status: 'failed'`). The wrapper also registers `{ toolName, budgetMs }` in an in-process demo-config map.
  - `GET /api/demo-config` serves that map to the frontend, alongside the Beat 4 payload.
  - The frontend's `ToolCallCard` renders, per call: the `callId` (from the events), the **configured budget** (from `/api/demo-config`, labeled as the demo's own budget — the copy must not present it as a protocol field), and the **measured duration** = arrival-timestamp(`tool_call_completed` with matching `callId`) − arrival-timestamp(`tool_call_started` with matching `callId`), recorded by the session controller as events arrive. Correlation is by `callId` — the real identity the events carry.
  - The **failure button** sends a fixed, canned prompt engineered to make the model call `unreliable_service` (e.g. "Use the unreliable_service tool to check the demo backend's status."). With a real model this is probabilistic, not guaranteed — acceptable for a demo button; the deterministic proof of the failure path lives in the unit tests of the wrapper, not in model behavior. The button's copy sets the expectation ("asks the agent to call a tool that will fail").

- **Beat 3 — drop and explicit recovery.** The frontend composes the **vanilla** `createChatSession` (public export of `@swiftagent/react`) in `frontend/src/session.ts` rather than using `useAgentChat`, because the beats need the raw event feed with timestamps (Beats 1–2) and client-lifecycle control (Beat 3) that the hook deliberately does not expose — and adding a hook or export is forbidden ("compose the public vanilla client or report the gap"). The controller:
  - Holds the current client plus the immutable `{ sessionId, token, websocketUrl }` from `/api/session`.
  - **Drop:** calls `client.disconnect()` mid-stream. Because `disconnect()` sets `intentionalClose`, reconnection is suppressed — this is the client's real, documented behavior, and the on-page copy says so.
  - **Recover:** constructs a **new** `createChatSession({ sessionId, token, websocketUrl, … })` against the same session id, re-attaches the event handlers, and appends the new client's events to the same feed. On reconnect to the same (single) instance while the run is still active, the gateway replays the buffered events of the active run (`docs/runbooks/realtime-operations.md` §3/§5) — the recovered feed visibly picks the turn back up.
  - **Honest copy** (must appear on the page, near the control): the client's `disconnect()` intentionally suppresses auto-reconnect; recovery here constructs a *new* client against the *same session*; the session — not the socket — is the durable thing; replay covers the active run on the same instance. No copy may say "reconnects automatically."

- **Beat 1 — the raw feed is the real feed.** The session controller appends every parsed `ChatEvent` (plus arrival timestamp) to an ordered log. `EventPanel` renders either prettified chat or the raw JSON (pretty-printed `JSON.stringify` of the actual event objects — not a reconstruction), toggleable. `run_failed` frames render too (they are part of the union and part of the honesty).

- **Beat 4 — drift-guarded source display.** `backend/src/agent.ts` is written to *be* the exhibit: the `defineAgent` + `tool` composition in ~20 lines. The backend embeds the file's text (read at startup via `node:fs` from a path resolved relative to the module — or a build-time raw import) into `/api/demo-config`, together with the reproduce-locally command documented by WS-43 (the one-command `docker compose up` path from the repaired README/quickstart — quote exactly what WS-43's docs say; do not invent a second command). A unit test asserts the served source text equals the file on disk, so the exhibit cannot drift.

- **Guest sessions, no signup.** `GET /api/session` mints a session via `app.sessions.create(...)` using the workspace API key from env (`SWIFT_AGENT_API_KEY` — locally, the raw dev key the WS-43 bootstrap surfaces). No account, no prompt, no visitor-supplied key. The browser receives only `{ sessionId, token, websocketUrl }`. In this workstream the backend is trusted and unthrottled — WS-49 hardens this exact route.

- **Public surface only, enforced.** Both source trees sit under the mirrored `no-restricted-imports` guard. Imports allowed: `@swiftagent/sdk`, `@swiftagent/react`, `@swiftagent/shared` package roots (plus `zod`, `fastify`, React/Vite). If a beat appears to need data the public surface does not expose, the rule is: compose the public vanilla client or report the gap — never add a hook, export, endpoint, or event field. Both known gaps (deadline, reconnect) are already resolved above.

- **CI.** `apps/*` workspace membership routes the playground through the existing Build & Lint (typecheck/lint/build) and Unit Tests jobs — the same mechanism that exercises `examples/quickstart` (which has no dedicated CI job either). Tests must therefore run hermetically: unit tests use mocks/fakes (per repo convention), never a live provider, a running compose stack, or network access.

## Out of Scope (restated exclusions — MUST NOT)

1. **Claiming or implying the visitor's tools run on their own infrastructure.** On this hosted demo they run on ours; the copy must not overstate the tool boundary. Proving it for real belongs to the proposed reverse-runner-transport program.
2. **Visitor-authored tool code.** No authoring, editing, or uploading of tools; no server-side sandbox of any kind.
3. **Public deployment, the live URL, and anything requiring a hosting account** — owned by WS-49.
4. **Rate limiting, spend caps, and abuse controls** — owned by WS-49; this workstream runs locally and trusted.
5. **The deploy template** — owned by WS-47.
6. **New runtime, SDK, or react features.** No new endpoints, hooks, exports, providers, or event fields. If a beat seems to need unexposed data, compose the public vanilla client or report the gap.
7. **A marketing site, landing page, or docs site around the demo.**
8. **Adding `deadline` (or any other field) to `ChatEvent`, `ToolContext`, or the runner protocol** to make Beat 2 easier — explicitly rejected 2026-08-19; the timing budget is demo-owned.

## Implementation Steps

1. **Scaffold the package.** Create `apps/playground` with `package.json` (`@swiftagent/playground`, `"private": true`, `"type": "module"`, all `@swiftagent/*` deps declared as `workspace:*`), tsconfigs, and the mirrored `eslint.config.js` guard. Verify `pnpm install` registers it as a workspace member and `pnpm build`/`typecheck`/`lint` traverse it (turbo picks it up via `apps/*`).
2. **Backend — tools.** Implement the useful tools and `unreliable_service` in `backend/src/tools/`, each via the SDK `tool()` with a Zod `inputSchema`. Implement `withBudget(toolDef, budgetMs)` (races `execute` against the budget; throws on breach; registers the budget in the demo-config map). Wrap every tool; give `unreliable_service` a budget it deliberately exceeds.
3. **Backend — agent.** Write `backend/src/agent.ts` as the ~20-line `defineAgent` exhibit composing the wrapped tools; export the agent and tools for tests and for the source display.
4. **Backend — server.** Write `backend/src/server.ts` on the quickstart pattern: env reads only inside `main()`; `createAgentApp` + `app.agent(...)` + `app.listen()`; `GET /api/session` (guest mint); `GET /api/demo-config` (tool budgets, agent source text read from `agent.ts`, reproduce-locally command); permissive CORS + the Vite dev-proxy assumption; run-directly-only guard so tests can import without booting.
5. **Frontend — session controller.** Write `frontend/src/session.ts` composing `createChatSession`: fetch `/api/session`; maintain the ordered raw-event log with arrival timestamps; expose `send`, `drop` (calls `disconnect()`), `recover` (constructs a NEW client with the same `sessionId`/`token`/`websocketUrl` and re-attaches handlers), and connection status.
6. **Frontend — the four beats.** Build `App.tsx` + components: `EventPanel` (raw/pretty toggle), `ToolCallCard` (callId, demo budget, measured duration by `callId` correlation, status including `'failed'` rendering), the failure-tool button (canned prompt), `ConnectionControls` (drop mid-stream, recover, the honest copy verbatim per Design Notes), `SourcePanel` (source + command from `/api/demo-config`). Include the boundary-honesty line in the page copy: tools in this hosted demo run on the demo's own backend.
7. **README.** Write `apps/playground/README.md`: purpose, the four beats, local run against the WS-43 stack (`docker compose up`, dev API key location per WS-43's docs, `pnpm --filter @swiftagent/playground dev:backend` / `dev:frontend`), and the explicit statement of what the demo does and does not prove.
8. **Verify CI coverage.** Confirm the Build & Lint and Unit Tests jobs pick up the package with no `ci.yml` edit (run the four gate commands locally; inspect turbo's task graph includes `@swiftagent/playground`). Only if a test genuinely cannot run in those jobs, make the minimal `ci.yml` adjustment.
9. **Gate.** Run `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` — all green. Fix everything; per CLAUDE.md, do not report complete otherwise.

## Tests

> Unit tests use mocks/fakes per repo convention — no live provider, no compose stack, no network. The deterministic tool-calling proof against the real local stack is WS-43's smoke check; WS-48's tests prove the playground's own logic.

**`apps/playground/backend/src/__tests__/tools.test.ts`:**

1. **Useful tools execute.** Each useful tool's `execute` returns its typed result for valid input (network-touching tools tested against an injected/mocked fetch); Zod rejects invalid input.
2. **Budget wrapper — pass-through.** `withBudget(tool, budget)` resolves normally when `execute` finishes inside the budget, and registers `{ toolName, budgetMs }` in the demo-config map.
3. **Budget wrapper — breach.** A tool exceeding its budget rejects (fake timers), so the runtime path yields `status: 'failed'`; `unreliable_service` deterministically breaches/throws.

**`apps/playground/backend/src/__tests__/server.test.ts`:**

4. **Agent shape.** The exported agent carries the expected name, model, and the full wrapped tool roster (mirrors the quickstart's import-without-boot test).
5. **Demo config integrity (Beat 4 drift guard).** The `/api/demo-config` payload's agent-source text equals the current content of `backend/src/agent.ts` on disk, and includes every wrapped tool's budget plus a non-empty reproduce command.
6. **Session route shape.** With `app.sessions.create` mocked, `GET /api/session` returns exactly `{ sessionId, token, websocketUrl }` and never the workspace API key.

**`apps/playground/frontend/src/__tests__/session.test.ts`** (fake `createWebSocket` factory via `CreateChatSessionOptions.createWebSocket`, as the react package's own tests do):

7. **Raw feed order + timestamps (Beat 1).** Events pushed through the fake socket appear in the log in order, parsed, with arrival timestamps.
8. **Duration correlation (Beat 2).** For a `tool_call_started`/`tool_call_completed` pair sharing a `callId`, the computed duration equals the timestamp delta; an interleaved second `callId` correlates independently; a `status: 'failed'` completion is exposed as the failure case.
9. **Drop suppresses reconnection (Beat 3).** After `drop()`, the fake factory is not invoked again and status stays `disconnected` (mirrors `intentionalClose` semantics).
10. **Recover constructs a new client against the same session (Beat 3).** `recover()` invokes the factory exactly once more with the SAME resolved URL (same `websocketUrl`/token → same session), and post-recovery events (including a replayed backlog delivered by the fake) append to the same feed.

**`apps/playground/frontend/src/__tests__/beats.test.tsx`:**

11. **Event panel toggle.** The raw view renders the actual event JSON (spot-check a `tool_call_started` with its `callId`); the toggle switches views without losing the log.
12. **ToolCallCard.** Renders `callId`, the configured budget labeled as demo-owned, the measured duration, and a distinct failed state for `status: 'failed'`.
13. **Honest copy present.** The connection-controls copy states that recovery constructs a new client against the same session (assert on the key phrases; no "automatic reconnect" wording), and the page carries the tools-run-on-our-infra honesty line.

## Acceptance Criteria

1. `apps/playground` exists as a single workspace package `@swiftagent/playground`, **born `"private": true`** with no `publishConfig`, structured `backend/` + `frontend/` like `examples/quickstart`, with every `@swiftagent/*` import declared in its `package.json` (SC-11).
2. **Beat 1:** the event panel renders the raw `ChatEvent` JSON of the actual received events, toggleable against the prettified chat, showing the full `message_started → token → tool_call_started → tool_call_completed → message_completed` sequence (SC-16).
3. **Beat 2:** each tool call surfaces its `callId`, the demo-configured budget (sourced from the playground's own tool wrapper via `/api/demo-config`, labeled as demo-owned), and a duration measured from the real `tool_call_started`/`tool_call_completed` pair correlated by `callId`; a button triggers the deliberately failing/slow tool and the `status: 'failed'` path renders visibly. No deadline or timing field is added to any `ChatEvent`, `ToolContext`, SDK, react, or runner surface (SC-16).
4. **Beat 3:** a control drops the connection mid-stream via `disconnect()`; recovery constructs a **new** `createChatSession` client against the **same** session id; the on-page copy accurately describes that `disconnect()` suppresses reconnection and recovery is an explicit new client — no automatic-reconnect claim (SC-16).
5. **Beat 4:** the page shows the ~20-line `defineAgent`/`tool` source that produced the demo (drift-guarded by a test against the real file) beside the one reproduce-locally command consistent with WS-43's documented path (SC-16).
6. Guest session creation works against the locally running WS-43 stack with no signup; the browser receives only `{ sessionId, token, websocketUrl }` and never the workspace API key (SC-16, SC-08 application half).
7. Both source trees consume only the public `@swiftagent/{sdk,react,shared}` package roots, enforced by the mirrored `no-restricted-imports` guard, and no runtime/SDK/react feature, export, or endpoint was added (SC-16; manifest excludes).
8. No page copy claims or implies visitor tools run on visitor infrastructure; the demo carries the honest boundary statement; no visitor tool-authoring surface exists; no rate limiting/spend/deploy work was done here (restated excludes 1–5, 7).
9. `pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm test` are all green with the package in the tree, and the package is exercised by CI through workspace membership exactly as `examples/quickstart` is (gate; feeds SC-17's WS-49 re-proof).
