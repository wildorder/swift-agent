# Swift Agent Quickstart

The **canonical, CI-maintained quickstart** for Swift Agent — the single source of
truth for wiring an agent end to end. It consumes **only the public APIs** of
[`@swiftagent/sdk`](../../packages/sdk) and [`@swiftagent/react`](../../packages/react)
(no deep imports into `dist`/`src`) and is kept green by the monorepo's
`pnpm typecheck` / `pnpm build` / `pnpm lint` CI gates, so it cannot rot silently.

It has two workspace members:

- **[`backend/`](./backend)** — a Node service that defines one agent
  (`support-assistant`) with one tool (`echo`), starts the tool runner via
  `app.listen()`, and exposes `GET /api/session`, which calls
  `app.sessions.create(...)` and returns `{ sessionId, token, websocketUrl }` to
  the browser. The workspace API key stays server-side.
- **[`frontend/`](./frontend)** — a minimal Vite + React app that fetches a
  session from the backend and renders `useAgentChat({ sessionId, token, websocketUrl })`
  as a streaming chat panel.

## Prerequisites

- Node 22, pnpm 9.15.4
- A running Swift Agent control plane (`apps/server`) on `:3000`
- A workspace API key
- The runner-token **public key** and the runner's **workspace id**

## Install

From the repo root:

```bash
pnpm install
```

## Configure

```bash
cp examples/quickstart/backend/.env.example examples/quickstart/backend/.env
```

Fill in `SWIFT_AGENT_API_KEY`, `SWIFT_AGENT_BASE_URL`, `RUNNER_TOKEN_PUBLIC_KEY`,
and `RUNNER_WORKSPACE_ID` (see the comments in `.env.example`;
`RUNNER_AUDIENCE` and `TOOL_RUNNER_PUBLIC_URL` are optional).

## Run

Start the backend (tool runner via `app.listen()` + the `/api/session` route on `:4000`):

```bash
pnpm --filter @swiftagent/example-backend dev
```

In a second terminal, start the frontend (Vite dev server; proxies `/api` to the backend):

```bash
pnpm --filter @swiftagent/example-frontend dev
```

### Expected result

Open the Vite URL, type a message, and watch the assistant response stream
token-by-token over the gateway WebSocket. Ask it to **"echo hello"** to exercise
the `echo` tool.

## Notes

- **Building/typechecking needs no cloud credentials** — `pnpm typecheck` and
  `pnpm build` only compile the example. Credentials are required only to actually
  *run* it.
- **Automated end-to-end is owned by WS-42**, which drives this same example
  against a local Testcontainers control plane + a deterministic stub agent and
  asserts a streamed assistant response reaches the browser. This package delivers
  the example and its compile-time CI gate only.
