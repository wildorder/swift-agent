# WS-39: Maintained Example Application

## Goal

Create an in-repo, CI-maintained **canonical quickstart** example application that is the single source of truth for "how do I use Swift Agent end to end". It consists of two workspace members under `examples/quickstart/`:

- **`backend/`** — a runnable Node service that defines one agent (`defineAgent`) with at least one tool (`tool`, Zod `inputSchema`, real `execute`), registers it with `app.agent(...)`, and starts the tool runner + agent registration via `app.listen()`. It also exposes a tiny HTTP route that calls `app.sessions.create(...)` and returns `{ sessionId, clientToken, websocketUrl }` to the browser (so the frontend never handles the workspace API key).
- **`frontend/`** — a minimal Vite + React app that fetches a session from the backend route, then renders `useAgentChat({ sessionId, token, websocketUrl })` with a message list + input, streaming an assistant response over the gateway WebSocket.

The example **must consume only the public exports** of `@swiftagent/sdk` and `@swiftagent/react` (no deep imports, no `dist/` or `src/` paths), and it must be wired into the monorepo so `pnpm typecheck` and `pnpm build` cover it in CI — it cannot rot silently. It **must typecheck and build without live cloud credentials**; credentials are only needed to actually *run* it.

This traces the program success criteria that a maintained, green, public-API-only example exists in-repo (SC-05) and that the full monorepo stays green (SC-10).

## Traceability

- **SC-05** — A maintained example application (backend agent + tools via `@swiftagent/sdk`, React frontend via `@swiftagent/react`) exists in-repo, consumes only public APIs, and is kept green in CI.
- **SC-10** — Monorepo type-checking, linting, unit tests, and integration tests pass.

## Dependencies

- **WS-36** (finalized public SDK surface) — this WS treats the current public exports of `@swiftagent/sdk` and `@swiftagent/react` (enumerated in **Existing Interfaces to Consume**) as the finalized, stable set. Import only from the package roots.

## Context Files (Agent MUST read before implementing)

Read these in full before writing any code. All API claims below are transcribed from them; re-read (do not trust memory) before referencing a signature.

- `CLAUDE.md` — mechanical overrides: forced verification (`pnpm typecheck && pnpm build`), grep discipline, re-read-before-edit, ESM-only, TS strict, Zod-is-source-of-truth.
- `packages/sdk/src/index.ts` — the exact public surface of `@swiftagent/sdk` (what you may import).
- `packages/sdk/src/app.ts` — `createAgentApp` + the `AgentApp` interface (`agent`, `sessions`, `runs`, `listen`, `close`) and the runner-token env requirements enforced in `listen()`.
- `packages/sdk/src/tool.ts` — `tool(...)` validation (`inputSchema` **must** be a Zod schema).
- `packages/sdk/src/agent.ts` — `defineAgent(...)` and `SdkAgentConfig` handling.
- `packages/sdk/src/types.ts` — `ToolDefinition`, `ToolContext`, `SdkAgentConfig`, `CreateAgentAppConfig`, `CreateSessionOptions`, `CreateSessionResult`, `AcceptedRun`, etc.
- `packages/react/src/index.ts` — the exact public surface of `@swiftagent/react`.
- `packages/react/src/hooks/use-agent-chat.ts` — `useAgentChat` implementation and destructured args.
- `packages/react/src/types.ts` — `UseAgentChatArgs`, `UseAgentChatResult`, `ChatMessage`, `ConnectionStatus`.
- `packages/react/src/client.ts` — `createChatSession` + `resolveConnectionUrl` (why `websocketUrl` from `POST /v1/sessions` is threaded verbatim and never hardcoded).
- `packages/shared/src/config.ts` — `ENV_KEYS` (the runner-token env var names to document in `.env.example`).
- `pnpm-workspace.yaml`, root `package.json`, `turbo.json`, `.github/workflows/ci.yml` — how workspace members get typechecked/built in CI.
- `packages/sdk/package.json`, `packages/sdk/tsconfig.json`, `tsconfig.base.json` — the existing `tsc` build pattern and base compiler options a workspace member must extend.

## Package

- **NEW workspace members:** `examples/quickstart/backend` (`@swiftagent/example-backend`) and `examples/quickstart/frontend` (`@swiftagent/example-frontend`), both `private: true`, `"type": "module"`.
- **`pnpm-workspace.yaml`** — add `examples/*` to the `packages:` globs (currently only `packages/*`, `apps/*`). This makes the examples install-linked and lets `@swiftagent/sdk` / `@swiftagent/react` resolve via `workspace:*`.
- **CI** (`.github/workflows/ci.yml`) — no new job required. Because the examples become workspace members, the existing **Build & Lint** job's `pnpm typecheck` / `pnpm lint` / `pnpm build` (Turborepo fan-out) already covers them. Confirm the example packages define `typecheck`, `lint`, and `build` scripts so Turbo picks them up.
- **Vite** is a NEW devDependency, scoped to `examples/quickstart/frontend` only. The library packages keep their `tsc` build; do **not** introduce Vite into `packages/*`.

## Files Touched

### Root / wiring

- `pnpm-workspace.yaml` — **(MODIFY)** add `- "examples/*"`.

### `examples/quickstart/` (all NEW)

- `examples/quickstart/README.md` — **(NEW)** human quickstart.
- `examples/quickstart/backend/package.json` — **(NEW)** `@swiftagent/example-backend`; deps `@swiftagent/sdk`, `@swiftagent/shared`, `fastify`, `zod`; scripts `build`/`typecheck`/`lint`/`dev`/`start`.
- `examples/quickstart/backend/tsconfig.json` — **(NEW)** extends `../../../tsconfig.base.json`; `references` to `packages/sdk` and `packages/shared`.
- `examples/quickstart/backend/src/server.ts` — **(NEW)** agent + tool definition, `app.agent(...)`, session route, `app.listen()`.
- `examples/quickstart/backend/.env.example` — **(NEW)** documents `SWIFT_AGENT_API_KEY`, `SWIFT_AGENT_BASE_URL`, runner-token env keys, `PORT`.
- `examples/quickstart/frontend/package.json` — **(NEW)** `@swiftagent/example-frontend`; deps `@swiftagent/react`, `react`, `react-dom`; devDeps `vite`, `@vitejs/plugin-react`, `@types/react`, `@types/react-dom`, `typescript`; scripts `dev`/`build`/`typecheck`/`lint`.
- `examples/quickstart/frontend/tsconfig.json` — **(NEW)** Vite/DOM-oriented compiler options (`lib: ["ES2022","DOM","DOM.Iterable"]`, `jsx: "react-jsx"`, `moduleResolution: "Bundler"`, `noEmit: true`).
- `examples/quickstart/frontend/vite.config.ts` — **(NEW)** `@vitejs/plugin-react`, dev-proxy `/api` → backend.
- `examples/quickstart/frontend/index.html` — **(NEW)** Vite entry that loads `/src/main.tsx`.
- `examples/quickstart/frontend/src/main.tsx` — **(NEW)** React root render.
- `examples/quickstart/frontend/src/App.tsx` — **(NEW)** session fetch + `useAgentChat` UI.

## Existing Interfaces to Consume

Transcribed from the source files above (2026-07-20). **Import only from the package root** (`@swiftagent/sdk`, `@swiftagent/react`).

### `@swiftagent/sdk` — public exports (`packages/sdk/src/index.ts`)

Values: `createAgentApp`, `defineAgent`, `tool`, `toolToJsonSchema`, `ControlPlaneClient`, `startToolRunner`, `SdkHttpError`, `ToolRunnerRequestSchema`, `SdkAgentConfigSchema`.
Types: `AgentApp`, `ToolContext`, `ToolDefinition`, `ToolSchema`, `SdkAgentConfig`, `AgentDefinition`, `CreateAgentAppConfig`, `CreateSessionOptions`, `CreateSessionResult`, `ListMessagesOptions`, `ListMessagesResult`, `CreateRunOptions`, `AcceptedRun`, `AgentRecord`, `SessionRecord`, `MessageRecord`, `RunRecord`, and the tool-runner request/response types.

```ts
// createAgentApp config (packages/sdk/src/types.ts)
interface CreateAgentAppConfig {
  apiKey: string;
  baseUrl?: string;
  runnerPublicKey?: string;   // PEM (SPKI) or JWK JSON; else env RUNNER_TOKEN_PUBLIC_KEY
  runnerAudience?: string;    // else env RUNNER_AUDIENCE, else TOOL_RUNNER_PUBLIC_URL
  runnerWorkspaceId?: string; // else env RUNNER_WORKSPACE_ID
}

function createAgentApp(config: CreateAgentAppConfig): AgentApp;

// AgentApp (packages/sdk/src/app.ts)
interface AgentApp {
  agent(definition: AgentDefinition): AgentApp;         // chainable; duplicate tool names throw
  sessions: {
    create(opts: CreateSessionOptions): Promise<CreateSessionResult>;
    get(id: string): Promise<SessionRecord>;
    messages: {
      list(sessionId: string, opts?: ListMessagesOptions): Promise<ListMessagesResult>;
    };
  };
  runs: {
    create(opts: CreateRunOptions): Promise<AcceptedRun>; // 202 accepted; poll get()
    get(runId: string): Promise<RunRecord>;
    cancel(runId: string): Promise<AcceptedRun>;
  };
  listen(port?: number): Promise<void>; // starts tool runner + registers agents
  close(): Promise<void>;
}

// defineAgent (packages/sdk/src/agent.ts, config shape packages/sdk/src/types.ts)
interface SdkAgentConfig {
  name: string;
  model: string;              // "provider/model-id", e.g. "anthropic/claude-sonnet"
  system?: string;
  tools?: ToolDefinition[];
  temperature?: number;       // 0..2
  maxTokens?: number;
  memory?: { strategy: 'last_n' | 'summary'; maxMessages?: number };
}
function defineAgent(config: SdkAgentConfig): AgentDefinition;

// tool (packages/sdk/src/tool.ts + types.ts) — inputSchema is a ZOD schema
interface ToolDefinition<TInput = any, TResult = any> {
  name: string;
  description: string;
  inputSchema: ZodType<TInput>;                                   // Zod, NOT JSON Schema
  execute: (input: TInput, ctx: ToolContext) => Promise<TResult>;
}
function tool<TInput, TResult>(config: ToolDefinition<TInput, TResult>): ToolDefinition<TInput, TResult>;

// ToolContext passed to execute (packages/sdk/src/types.ts)
interface ToolContext {
  sessionId: string;
  agentId: string;
  runId: string;
  callId: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

// Session create input/result (packages/sdk/src/types.ts)
interface CreateSessionOptions { agentName: string; userId?: string; metadata?: Record<string, unknown>; }
interface CreateSessionResult { sessionId: string; clientToken: string; websocketUrl: string; }
```

> **NOTE — vision doc is out of date on `inputSchema`.** `docs/vision.md` (≈L163) shows `inputSchema` as a raw JSON-Schema object. The real `tool()` (packages/sdk/src/tool.ts) throws unless `inputSchema.safeParse` is a function — i.e. it **must be a Zod schema**. Use Zod (`z.object({...})`) in the example. Likewise the vision's `sessions.create({ agent })` is really `sessions.create({ agentName })`.

### `@swiftagent/react` — public exports (`packages/react/src/index.ts`)

Values: `createChatSession`, `useAgentChat`, `useConnection`, `chatReducer`, `initialChatState`.
Types: `ChatEvent`, `ChatMessage`, `ChatSessionClient`, `ConnectionStatus`, `CreateChatSessionOptions`, `ReconnectOptions`, `ToolCallInfo`, `UseAgentChatArgs`, `UseAgentChatResult`, `UseConnectionOptions`, `UseConnectionResult`, `ChatState`, `ChatAction`, `InternalAction`.

```ts
// useAgentChat args/result (packages/react/src/types.ts + hooks/use-agent-chat.ts)
interface UseAgentChatArgs {
  sessionId: string;
  token: string;
  websocketUrl?: string;                        // canonical wss://.../v1/stream?token=<jwt> from POST /v1/sessions
  reconnect?: ReconnectOptions;                 // { maxRetries: number; baseDelayMs: number }
  createWebSocket?: (url: string) => WebSocket; // injectable (tests)
  onError?: (error: unknown) => void;
}
interface UseAgentChatResult {
  messages: ChatMessage[];                      // { id; role: 'user'|'assistant'|'tool'; content; status; toolCalls? }
  send: (content: string) => void;
  isStreaming: boolean;
  connectionStatus: ConnectionStatus;           // 'connecting' | 'connected' | 'disconnected'
  lastError: string | null;
}
function useAgentChat(args: UseAgentChatArgs): UseAgentChatResult;
```

> **`websocketUrl` threading (WS-34 contract).** `createChatSession` / `useConnection` throw if `websocketUrl` is missing — there is **no hardcoded default**. Thread the `websocketUrl` value returned by `app.sessions.create(...)` (i.e. `POST /v1/sessions`) straight into `useAgentChat`. Do **not** construct or hardcode a gateway URL in the example.

### `@swiftagent/shared` — `ENV_KEYS` (names only, for `.env.example`)

`RUNNER_TOKEN_PUBLIC_KEY`, `RUNNER_WORKSPACE_ID`, `RUNNER_AUDIENCE` (optional), `TOOL_RUNNER_PUBLIC_URL` (optional). The example may reference these names, but should **not** deep-import `ENV_KEYS` for wiring — read them from `process.env` by the literal names, or import `ENV_KEYS` from the `@swiftagent/shared` root if desired (root import is public).

## Design Notes

- **Only public APIs (hard rule).** Every import in `backend/` and `frontend/` resolves to `@swiftagent/sdk`, `@swiftagent/react`, or `@swiftagent/shared` (root), plus third-party libs (`fastify`, `react`, `zod`, `vite`). No `@swiftagent/*/dist/...`, no `@swiftagent/*/src/...`, no relative paths into `packages/`. Add an ESLint `no-restricted-imports` guard (pattern `@swiftagent/*/**`) in the example packages so a deep import fails `pnpm lint` in CI. This is what makes SC-05's "public APIs only" claim enforceable rather than aspirational.
- **Vite for the frontend.** The frontend is browser code and needs a dev server + HMR + a proxy to the backend; Vite is the standard, minimal choice and is confined to the frontend package. `@swiftagent/react` continues to ship as a `tsc`-built library; the example just consumes it.
- **`sessions.create → websocketUrl` flow.** The browser must never hold the workspace API key. Flow: browser `GET /api/session` → backend calls `app.sessions.create({ agentName })` → backend returns `{ sessionId, clientToken, websocketUrl }` → frontend passes those verbatim into `useAgentChat({ sessionId, token: clientToken, websocketUrl })`. The backend owns `SWIFT_AGENT_API_KEY`; the frontend owns nothing secret.
- **Runner-token requirements.** `app.listen()` throws unless it can resolve `RUNNER_TOKEN_PUBLIC_KEY` (PEM/JWK) and `RUNNER_WORKSPACE_ID` (via config or env), with `RUNNER_AUDIENCE`/`TOOL_RUNNER_PUBLIC_URL` optional (audience defaults to the runner's public URL). `.env.example` documents all of these with comments, plus `SWIFT_AGENT_API_KEY` (→ `apiKey`) and `SWIFT_AGENT_BASE_URL` (→ `baseUrl`, the control-plane / apps/server URL, default `http://127.0.0.1:3000`).
- **No cloud creds for build/typecheck.** `pnpm typecheck` and `pnpm build` only compile the example; they never call `createAgentApp`, `listen()`, or the network. Nothing at module top-level reads a *required* env var at import time (guard `process.env` reads behind the `main()`/route handlers). CI therefore stays green without secrets. Live creds are needed only to `pnpm --filter @swiftagent/example-backend dev` and actually stream a response.
- **Model string format** is `provider/model-id` (e.g. `anthropic/claude-sonnet`); use that in `defineAgent`.
- **Backend build vs run.** `build`/`typecheck` use `tsc` (matches the repo's library build pattern; extends `tsconfig.base.json`, `references` sdk + shared so project-references resolve `.d.ts`). `dev`/`start` run via `tsx`/compiled output — runtime only, not part of CI's green gate beyond compile.
- **Frontend typecheck.** The frontend's `tsc --noEmit` must use DOM libs + `jsx: react-jsx` + `moduleResolution: Bundler`; it does **not** use project references (Vite bundles; the React package resolves via its published `types`/`exports`). Keep `noEmit: true` so `build` (`vite build`) owns emission.
- **Scope/size.** ~13 new files; single build session. Keep both apps minimal-but-real: one agent, one tool, one route, one chat panel.
- **WS-42 relationship.** This spec delivers the example and its compile-time CI gate. **WS-42** will drive this same example as an end-to-end acceptance test against a local Testcontainers stack + a deterministic stub agent (asserting a streamed response arrives). Do not add live-network e2e here.

## Implementation Steps

1. **Workspace glob.** Edit `pnpm-workspace.yaml` to add `- "examples/*"` under `packages:`. Run `pnpm install` to link `examples/quickstart/*` and resolve `@swiftagent/*` via `workspace:*`.

2. **Backend package.** Create `examples/quickstart/backend/package.json` (`@swiftagent/example-backend`, `private`, `"type":"module"`):
   - deps: `@swiftagent/sdk: workspace:*`, `@swiftagent/shared: workspace:*`, `fastify: ^5`, `zod: ^3.24`.
   - devDeps: `@types/node`, `tsx`, `typescript`.
   - scripts: `"build": "tsc"`, `"typecheck": "tsc --noEmit"`, `"lint": "eslint src/"`, `"dev": "tsx watch src/server.ts"`, `"start": "node dist/server.js"`.

3. **Backend tsconfig.** `examples/quickstart/backend/tsconfig.json` extends `../../../tsconfig.base.json`; set `rootDir: "src"`, `outDir: "dist"`, `include: ["src"]`, and `references: [{ "path": "../../../packages/sdk" }, { "path": "../../../packages/shared" }]`.

4. **Backend `src/server.ts`.** Implement (public imports only):
   - `import { createAgentApp, defineAgent, tool } from '@swiftagent/sdk';` and `import { z } from 'zod';` and `import Fastify from 'fastify';`.
   - Define one tool with a **Zod** `inputSchema`, e.g. `echoTool`:
     ```ts
     const echoTool = tool({
       name: 'echo',
       description: 'Echo a message back, optionally shouting it.',
       inputSchema: z.object({
         message: z.string().min(1),
         shout: z.boolean().optional(),
       }),
       execute: async ({ message, shout }, ctx) => {
         const text = shout ? message.toUpperCase() : message;
         return { echoed: text, sessionId: ctx.sessionId };
       },
     });
     ```
   - `const app = createAgentApp({ apiKey: process.env.SWIFT_AGENT_API_KEY ?? '', baseUrl: process.env.SWIFT_AGENT_BASE_URL });` (read inside `main()`, not at import time).
   - `app.agent(defineAgent({ name: 'support-assistant', model: 'anthropic/claude-sonnet', system: 'You are a friendly support assistant. Use the echo tool when asked to repeat something.', tools: [echoTool] }));`
   - A tiny Fastify server exposing `GET /api/session` → `const s = await app.sessions.create({ agentName: 'support-assistant', userId: 'demo-user' }); return { sessionId: s.sessionId, token: s.clientToken, websocketUrl: s.websocketUrl };`. Add permissive CORS (or rely on the Vite dev proxy) so the frontend can call it.
   - `main()`: `await app.listen();` (starts tool runner + registers the agent), then start the Fastify session server on `process.env.PORT ?? 4000`. Wrap in `main().catch((e) => { console.error(e); process.exit(1); })`. No top-level `await` that runs on import — guard everything behind `main()` so `tsc` compile / import does not require env.

5. **Backend `.env.example`.** Document, with comments:
   - `SWIFT_AGENT_API_KEY=` — workspace API key (→ `createAgentApp.apiKey`).
   - `SWIFT_AGENT_BASE_URL=http://127.0.0.1:3000` — control-plane (apps/server) URL (→ `baseUrl`).
   - `RUNNER_TOKEN_PUBLIC_KEY=` — runner token verification key, PEM (SPKI) or JWK JSON (required by `app.listen()`).
   - `RUNNER_WORKSPACE_ID=` — the runner's owning `ws_` id (required by `app.listen()`).
   - `RUNNER_AUDIENCE=` — optional; defaults to the runner's public URL.
   - `TOOL_RUNNER_PUBLIC_URL=` — optional; the runner's externally reachable base URL (audience default).
   - `PORT=4000` — the session HTTP route port.

6. **Frontend package.** Create `examples/quickstart/frontend/package.json` (`@swiftagent/example-frontend`, `private`, `"type":"module"`):
   - deps: `@swiftagent/react: workspace:*`, `react: ^19`, `react-dom: ^19`.
   - devDeps: `vite: ^5`, `@vitejs/plugin-react: ^4`, `@types/react: ^19`, `@types/react-dom: ^19`, `typescript`.
   - scripts: `"dev": "vite"`, `"build": "vite build"`, `"typecheck": "tsc --noEmit"`, `"lint": "eslint src/"`.

7. **Frontend tsconfig.** `examples/quickstart/frontend/tsconfig.json` — do **not** extend the composite base (it targets Node16/no-DOM). Set `compilerOptions`: `target: "ES2022"`, `lib: ["ES2022","DOM","DOM.Iterable"]`, `module: "ESNext"`, `moduleResolution: "Bundler"`, `jsx: "react-jsx"`, `strict: true`, `skipLibCheck: true`, `noEmit: true`, `verbatimModuleSyntax: true`, `isolatedModules: true`; `include: ["src", "vite.config.ts"]`.

8. **Frontend `vite.config.ts`, `index.html`, `src/main.tsx`.** Standard Vite React scaffold: `defineConfig({ plugins: [react()], server: { proxy: { '/api': 'http://127.0.0.1:4000' } } })`; `index.html` with `<div id="root">` + `<script type="module" src="/src/main.tsx">`; `main.tsx` renders `<App/>` into `#root` via `createRoot`.

9. **Frontend `src/App.tsx`.** Public imports only (`import { useAgentChat } from '@swiftagent/react';`):
   - On mount, `fetch('/api/session')` → `{ sessionId, token, websocketUrl }`; hold in state (undefined until loaded).
   - Once loaded, render a child component that calls `useAgentChat({ sessionId, token, websocketUrl })` (hook must run unconditionally, so gate by rendering the child only when session data exists).
   - UI: map `messages` to `<div>{m.content}</div>` keyed by `m.id`; a controlled `<input>` + form that calls `send(text)`; show `connectionStatus` and `isStreaming`; render `lastError` if set.

10. **Guardrails.** Add `no-restricted-imports` (patterns `@swiftagent/*/dist/*`, `@swiftagent/*/src/*`) to each example package's ESLint config so deep imports fail CI lint.

11. **README.** Write `examples/quickstart/README.md` (see Implementation Steps §12 content list). Keep it exactly matching the code (WS-40 will cross-link it).

12. **Verify (FORCED).** From repo root run `pnpm install`, then `pnpm typecheck` and `pnpm build` and `pnpm lint`. All must be green with **no** cloud env vars set. Fix every error before reporting done. Confirm Turbo actually schedules the two example packages (they appear in the task graph).

### README content (`examples/quickstart/README.md`)

- **What this is** — the canonical quickstart; consumes only public `@swiftagent/sdk` / `@swiftagent/react` APIs; kept green in CI.
- **Prereqs** — Node 22, pnpm 9.15.4, a running Swift Agent control plane (apps/server on `:3000`), a workspace API key, and the runner-token public key + workspace id.
- **Install** — `pnpm install` at the repo root.
- **Configure** — `cp examples/quickstart/backend/.env.example examples/quickstart/backend/.env` and fill values.
- **Run backend** — `pnpm --filter @swiftagent/example-backend dev` (starts tool runner via `app.listen()` + the `/api/session` route on `:4000`).
- **Run frontend** — `pnpm --filter @swiftagent/example-frontend dev` (Vite dev server; proxies `/api` to the backend).
- **Expected result** — open the Vite URL, type a message, watch the assistant response stream token-by-token; ask it to "echo hello" to exercise the tool.
- **Note** — building/typechecking needs no cloud creds; only running does. WS-42 runs this example as an automated e2e against a Testcontainers stack + deterministic stub agent.

## Tests

1. **CI typecheck gate.** `pnpm typecheck` (Turbo → both example packages' `tsc --noEmit`) passes with no cloud env vars set. This is the primary rot-guard for SC-05.
2. **CI build gate.** `pnpm build` compiles `backend` (`tsc`) and `frontend` (`vite build`) successfully; the example packages appear in the Turbo task graph.
3. **CI lint gate.** `pnpm lint` passes, including the `no-restricted-imports` rule — proving only public package-root imports are used (no `@swiftagent/*/dist|src` deep imports).
4. **Definition smoke test (unit).** A Vitest unit test in `backend` that imports the agent + tool from a small exported module and asserts, without any network or env: (a) `tool({...})` returns a frozen object with a working Zod `inputSchema` (`inputSchema.safeParse({ message: 'hi' }).success === true`; empty string fails); (b) `defineAgent({...})` returns a definition whose `name === 'support-assistant'`, `modelConfig.model === 'anthropic/claude-sonnet'`, and `toolSchemas` contains the `echo` tool. (Refactor `server.ts` to export `echoTool` and the `AgentDefinition` so they're importable without invoking `main()`.)
5. **(Documented, not implemented here) Full e2e is WS-42** — drive backend + frontend against a local Testcontainers control plane + deterministic stub agent and assert a streamed assistant response reaches the browser. Note this explicitly so the boundary is unambiguous.

## Acceptance Criteria

1. `examples/quickstart/` exists with the exact canonical layout: `README.md`, `backend/{package.json,tsconfig.json,src/server.ts,.env.example}`, `frontend/{package.json,tsconfig.json,vite.config.ts,index.html,src/main.tsx,src/App.tsx}`.
2. `examples/*` is added to `pnpm-workspace.yaml`, and `pnpm install` links both example packages as `@swiftagent/example-backend` / `@swiftagent/example-frontend` resolving `@swiftagent/*` via `workspace:*`.
3. The backend uses only `@swiftagent/sdk` (+ `@swiftagent/shared` root, `fastify`, `zod`): defines one `tool` with a **Zod** `inputSchema` and a real `execute`, wires it via `defineAgent` + `app.agent(...)`, exposes a `/api/session` route calling `app.sessions.create(...)`, and calls `app.listen()`. No deep imports.
4. The frontend uses only `@swiftagent/react` (+ `react`/`react-dom`): fetches a session from the backend and renders `useAgentChat({ sessionId, token, websocketUrl })` with a message list + input, threading the API-provided `websocketUrl` verbatim (no hardcoded gateway URL).
5. `.env.example` documents `SWIFT_AGENT_API_KEY`, `SWIFT_AGENT_BASE_URL`, `RUNNER_TOKEN_PUBLIC_KEY`, `RUNNER_WORKSPACE_ID`, `RUNNER_AUDIENCE` (optional), `TOOL_RUNNER_PUBLIC_URL` (optional), and `PORT` with explanatory comments.
6. **`pnpm typecheck && pnpm build && pnpm lint` are all green from a clean checkout with NO cloud credentials set** (the example compiles/builds without ever calling the network), satisfying SC-10 and the compile-time half of SC-05.
7. The `no-restricted-imports` guard is present and fails lint on any `@swiftagent/*/dist|src` deep import, making the "public APIs only" rule enforceable.
8. The definition smoke test (Test 4) passes under `pnpm test` without env or network.
9. `README.md` is accurate to the code (commands, ports, env, expected streamed result) and notes that WS-42 owns the automated e2e.
```
