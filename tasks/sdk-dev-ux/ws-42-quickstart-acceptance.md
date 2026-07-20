# WS-42: Quickstart Acceptance Flow

## Goal

This is the **capstone** of the `sdk-dev-ux` program: a single, deterministic, automated **end-to-end acceptance test** that is the program's executable definition of "a working agent in minutes." It follows the documented quickstart (WS-40) against the example app (WS-39) and a locally-booted stack, and — to validate the *real* install step rather than a workspace symlink — it **installs the published `@swiftagent/*` packages from GitHub Packages** (`npm.pkg.github.com`, published by WS-38) into a throwaway consumer project using a `read:packages` token, then drives the full happy path:

> **register/define agent → create session → connect via the client → send a message → assert the streamed `ChatEvent` sequence `message_started → token(s) → tool_call_started → tool_call_completed → message_completed`, including a real tool-call round-trip.**

The model call uses a **deterministic streaming stub agent** (an echo/scripted provider — the same determinism the WS-25 runtime suites and the WS-35 `smoke-echo` agent already rely on; **no real provider key**), so the test is fast and non-flaky. The stack (Fastify server composing REST + WebSocket on port 3000) boots against **Testcontainers** Postgres + Redis with the committed Drizzle migrations applied, exactly as the existing integration suites do.

This workstream **authors one thing**: the acceptance suite under `test/acceptance/` (plus its runner config, a root `test:acceptance` script, and the GitHub Packages install harness) and **wires it into `.github/workflows/ci.yml` as a required gate** after unit + integration tests. On failure it **fails loud** with captured diagnostics and the actionable `SwiftAgentError` (WS-41) surfaced. Scope: the acceptance suite, the install harness, the root script, and the CI gate — **nothing else**. It does **not** change the runtime loop, the SDK surface, the docs, or the publishing pipeline; those land in WS-36/38/39/40/41 and are consumed here as dependencies.

## Traceability

- **SC-09** — An automated quickstart acceptance test **installs the published packages from GitHub Packages** and exercises **define agent → create session → connect → stream a response** (including a **tool-call round-trip**) against a **deterministic stub agent**, running as a **CI gate**.
- **SC-10** — Monorepo type-checking, linting, unit tests, and integration tests pass (`pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:integration`) — none of this workstream's additions may regress them. (Note: the root `test/` tree is excluded from `pnpm typecheck`/`lint` by project convention; the acceptance suite is validated by *running* it via its Vitest runner, not by the typecheck/lint gates — see Design Notes.)

## Dependencies

- **WS-36 (finalized SDK surface)** — freezes the public API the acceptance test drives: `createAgentApp`, `defineAgent`, `tool`, `app.agent`, `app.listen`, `app.sessions.create → { sessionId, clientToken, websocketUrl }`, `app.runs.create`, and the React client `createChatSession` / `useAgentChat`. The test imports these from the **installed published packages**, so if WS-36's `exports` map is not final, the install-and-import step fails. **Consume; do not alter the surface.**
- **WS-38 (package publishing pipeline)** — publishes `@swiftagent/sdk`, `@swiftagent/react`, and their workspace dep `@swiftagent/shared` to GitHub Packages (`npm.pkg.github.com`), driven by Changesets, and adds the root `.npmrc` scope mapping `@swiftagent:registry=https://npm.pkg.github.com`. **Critically, WS-38 also publishes a PRERELEASE/snapshot version on PRs** under a non-`latest` dist-tag (e.g. `@swiftagent/sdk@pr`, snapshot version `0.0.0-pr-<sha>`), so a PR run always has a real registry version to install; on `main`, WS-38 publishes the stable version under `latest`. **The registry-only install path (the sole path that satisfies SC-09) depends on this: PR runs install the `pr` snapshot, main runs install the stable version.** **STOP and report** if the `.npmrc` scope line is absent, or if WS-38's PR snapshot publish is not in place — either means WS-38 has not fully landed and the registry-only install cannot be exercised on PRs.
- **WS-39 (`examples/quickstart/`)** — the canonical example (`backend/src/server.ts`, `frontend/src/App.tsx`, `README.md`) whose documented steps this test mirrors. The acceptance test's flow must stay copy-pasteably close to the example's backend `defineAgent`/`tool`/`app.listen`/`app.sessions.create` calls and the frontend `createChatSession`/`useAgentChat` usage. **If `examples/quickstart/` is absent, WS-39 has not landed — STOP and report** rather than inventing an example.
- **WS-40 (aligned quickstart docs)** — the documented steps the test follows. Keep the test and the docs in lockstep: the acceptance suite is the executable proof the docs are correct.
- **WS-41 (actionable errors)** — the negative-path assertions consume the typed `SwiftAgentError` (`code` + human-readable message + `cause`) that WS-41 routes through the SDK client and the React `lastError`. The acceptance test asserts a **typed, readable** failure (not `[object Event]` / a bare `HTTP 401`).

**The build agent MUST confirm WS-36/38/39/40/41 have landed** (final `exports` maps; the `.npmrc` scope line + WS-38's stable-on-`main` and PR-snapshot publishes; `examples/quickstart/` present; aligned docs; `SwiftAgentError` routed) **before expecting a green acceptance run.** The suite and CI wiring can be authored ahead of a live publish, but the registry-only install path — the **only** path that satisfies SC-09 — needs WS-38's publishes live: the `pr` snapshot for PR runs, the stable version for `main`.

## Context Files (Agent MUST read before implementing)

- `C:\dev\swift-agent\CLAUDE.md` — mechanical overrides + conventions: Node 22, TS strict, ESM (`"type": "module"`), pnpm 9.15.4 workspaces + Turborepo, Zod source-of-truth, `@swiftagent/*` scoping, `ENV_KEYS` single source of truth, ID prefixes (`ses_`/`msg_`/`run_`/`tc_`/`agt_`/`ws_`/`ak_`), repos are factory functions, `ChatEvent` discriminated union from `@swiftagent/shared`. **Forced verification (§4), grep discipline (§10), re-read-before-edit (§9)** all apply.
- `C:\dev\swift-agent\test\smoke\realtime-smoke.ts` — the **model for the WS flow + event-sequence assertion + bounded/retry harness.** Reuse its shape: `POST /v1/sessions` → `connectWs(websocketUrl)` → `send { type:'send_message', content }` → assert `message_started → token → message_completed`, each frame validated with `ChatEventSchema.safeParse`, bounded by connect/per-wait/overall-budget timeouts + a `run_failed`/`error` failure watcher (`Promise.race`) + ≤3 retries with backoff, printing diagnostics on failure. **The acceptance test extends this sequence with the tool-call round-trip.**
- `C:\dev\swift-agent\test\support\ws-client.ts` — the promise-based WS client (`connectWs(url, openTimeoutMs?) → WsClient` with `send`, `waitFor(pred, ms)`, `waitForType(type, ms)`, `framesOfType(type)`, `frames`, `close()`). **Reuse verbatim; do not reinvent a socket wrapper.** Signature pasted below.
- `C:\dev\swift-agent\test\support\runtime-harness.ts` — `createRuntimeHarness()` composes the **real** runtime (repos, a `ProviderRegistry` with a deterministic **fake provider** registered under `fake` / `fake/deterministic`, the tool-executor resolver with scoped-token minting, `RunExecutionService`, `buildApp` REST, `createGatewayServer` gateway) against the Testcontainers Postgres `test/setup-db.ts` provisions. It exposes `buildRestApp`, `buildGateway`, `signClientToken`, `seedWorkspaceWithKey`, `seedAgent`, `seedSession`, and `seededTool(name)`. **This is the deterministic stub-agent path** — the acceptance test's server boots on top of this composition (see Design Notes).
- `C:\dev\swift-agent\test\support\fake-provider.ts` — `createFakeProvider()` → a scripted `ModelProvider`; script builders `textTurn(text)`, `toolTurn(name, args)`, `byTurn(...turns)`. **`byTurn(toolTurn('echo', {v:1}), textTurn('Hi'))` is exactly the deterministic tool-call-then-text turn that produces the tool round-trip** the acceptance test asserts. No real API is called.
- `C:\dev\swift-agent\test\support\fake-runner.ts` — `startFakeRunner({ publicKey, workspaceId })` starts a **real SDK tool runner** (`startToolRunner`) with scripted tools incl. `echo` (returns its input). The tool-call round-trip resolves against this runner so `tool_call_started`/`tool_call_completed` are real.
- `C:\dev\swift-agent\test\integration\ws-runs.integration.test.ts` — the closest existing suite: it already asserts a **full run over a real gateway WS** — `message_started → token → tool_call_started → tool_call_completed → message_completed` — using the harness + fake runner + `byTurn(toolTurn('echo',…), textTurn(…))`. **The acceptance test is the SDK-driven, published-package analogue of this.** Pasted below.
- `C:\dev\swift-agent\test\setup-db.ts` — the Testcontainers Postgres `globalSetup` (starts `postgres:16-alpine`, sets `DATABASE_URL`, applies `packages/db/drizzle` migrations via the Drizzle migrator). Model the acceptance runner's DB boot on this.
- `C:\dev\swift-agent\test\vitest.integration.config.ts` — the integration Vitest config (`include: ['test/integration/**/*.integration.test.ts']`, `globalSetup: ['./test/setup-db.ts']`, `testTimeout: 30000`, `hookTimeout: 60000`). The acceptance suite gets its **own** sibling config (see Package).
- `C:\dev\swift-agent\packages\shared\src\types\events.ts` — `ChatEventSchema` (discriminatedUnion) — the frame validator. The tool-call frames (`ToolCallStartedEventSchema` / `ToolCallCompletedEventSchema`) are pasted below.
- `C:\dev\swift-agent\packages\sdk\src\index.ts` + `packages\sdk\src\app.ts` — the public SDK surface the test drives (`createAgentApp`, `defineAgent`, `tool`, `app.agent`, `app.sessions.create`, `app.runs.create`, `app.listen`). `AgentApp` interface pasted below.
- `C:\dev\swift-agent\packages\react\src\client.ts` + `packages\react\src\index.ts` — `createChatSession({ token, websocketUrl, reconnect, onError, createWebSocket? })` and `useAgentChat`. In Node, the test either drives the raw WS via `connectWs` (headless, no DOM `WebSocket`) **or** injects a `ws`-backed `createWebSocket` into `createChatSession`; both are pasted/noted below.
- `C:\dev\swift-agent\.github\workflows\ci.yml` — where the gate lands: `NODE_VERSION: '22'`, `PNPM_VERSION: '9.15.4'` at the workflow `env` level; `pnpm/action-setup@v4` + `actions/setup-node@v4` (`cache: pnpm`); jobs `build-lint`, `unit-tests`, `integration-tests` (the last `needs: [build-lint, unit-tests]` and already provisions `redis` + `postgres` service containers and Testcontainers). Relevant job pasted below.
- `C:\dev\swift-agent\packages\db\src\migrate.ts` — the `@swiftagent/db` migrate entry point (`dist/migrate.js`); reads `DATABASE_URL`, runs `packages/db/drizzle`. The acceptance runner reuses `test/setup-db.ts`'s in-process migrator rather than shelling to this, but it exists as the canonical migrate path.

## Package

- **`test/acceptance/`** *(NEW)* — the quickstart acceptance suite + its support harness.
- **`test/vitest.acceptance.config.ts`** *(NEW)* — a sibling of `test/vitest.integration.config.ts`: `include: ['test/acceptance/**/*.acceptance.test.ts']`, `globalSetup: ['./test/setup-db.ts']` (reuse the same Testcontainers Postgres boot), longer `testTimeout`/`hookTimeout` (the install-from-registry step + server boot are slow). Redis is provided the same way integration tests get it (CI service container / a `RedisContainer` from `testcontainers` — match the existing integration pattern; the harness runs with `redisEnabled: false` for a single-node gateway, so Redis is only needed if a suite exercises fanout — default OFF for determinism, see Design Notes).
- **`package.json`** *(MODIFY, root)* — add `"test:acceptance": "vitest run --config test/vitest.acceptance.config.ts"` alongside the existing `test:integration` / `smoke:realtime` scripts. Optionally add `"test:acceptance:install": "tsx test/acceptance/install-published.ts"` for the standalone registry-install check.
- **`.github/workflows/ci.yml`** *(MODIFY)* — add an **`acceptance-tests`** job (`needs: [build-lint, unit-tests, integration-tests]`) that provisions Docker (Testcontainers) + the GitHub Packages read token and runs `pnpm test:acceptance` as a **required gate**.

## Files Touched

- `test/acceptance/quickstart.acceptance.test.ts` **(NEW)** — the acceptance suite. Boots the stub-agent stack on the Testcontainers DB, seeds a deterministic streaming stub agent + a stub tool, drives the documented quickstart via the SDK (`app.sessions.create` → `connectWs` → `send_message`), and asserts the full `message_started → token(s) → tool_call_started → tool_call_completed → message_completed` sequence (every frame `ChatEventSchema`-validated), plus a negative case surfacing a typed `SwiftAgentError`. Bounded by timeouts; reuses `test/support/ws-client.ts` and `test/support/runtime-harness.ts`.
- `test/acceptance/install-published.ts` **(NEW)** — the GitHub Packages install harness. Creates a throwaway consumer dir with its own `.npmrc` (scope map + `${NODE_AUTH_TOKEN}`), installs the published `@swiftagent/sdk` + `@swiftagent/react` (+ `@swiftagent/shared`) **from `npm.pkg.github.com` (the sole install path)**, and imports + typechecks + smoke-runs them to prove the real artifacts resolve. On PRs it installs WS-38's PRERELEASE snapshot via the `pr` dist-tag (`@swiftagent/sdk@pr`); on `main` it installs the stable published version. No local-tarball path. Callable standalone and imported by the suite's install test.
- `test/acceptance/support/acceptance-server.ts` **(NEW, if needed)** — a thin helper that composes the runtime harness into a single listening Fastify server (REST + WS on one port) so the SDK's `baseUrl`/`websocketUrl` point at one host, mirroring `apps/server`. May instead reuse `buildRestApp` + `buildGateway` directly if a single-port composition is not required for the drive (see Design Notes — the SDK talks control-plane via `baseUrl` (REST) and the client connects to the returned `websocketUrl` (gateway), so **two** listeners are acceptable and simplest; document the choice).
- `test/vitest.acceptance.config.ts` **(NEW)** — the acceptance Vitest config (see Package).
- `package.json` **(MODIFY)** — add `test:acceptance` (+ optional `test:acceptance:install`) script.
- `.github/workflows/ci.yml` **(MODIFY)** — add the `acceptance-tests` gate job.

## Existing Interfaces to Consume

### Reusable WS client — `test/support/ws-client.ts` (VERBATIM shape)

```ts
export type WsFrame = Record<string, unknown> & { type?: string };

export interface WsClient {
  readonly socket: WebSocket;                 // from 'ws'
  readonly frames: WsFrame[];                 // all frames received, in order
  send(message: unknown): void;               // JSON.stringify + socket.send
  waitFor(pred: (frame: WsFrame) => boolean, timeoutMs?: number): Promise<WsFrame>;
  waitForType(type: string, timeoutMs?: number): Promise<WsFrame>;
  framesOfType(type: string): WsFrame[];
  close(): Promise<void>;
}

// Opens the socket; rejects if it does not open within openTimeoutMs (default 10_000).
export function connectWs(url: string, openTimeoutMs?: number): Promise<WsClient>;
```

### The smoke test's event-sequence assertion + failure watcher — `test/smoke/realtime-smoke.ts` (the pattern to extend)

```ts
// Validate every inbound frame against the shared union; malformed = failure.
function assertValidFrame(frame: WsFrame): void {
  const parsed = ChatEventSchema.safeParse(frame);
  if (!parsed.success) {
    throw new Error(`malformed/unknown ChatEvent frame ${JSON.stringify(frame)}: ${parsed.error.message}`);
  }
}

// Happy path: send, then assert the streamed sequence with bounded waits.
client.send({ type: 'send_message', content: 'ping from acceptance' });
const started   = await client.waitForType('message_started', WAIT_TIMEOUT_MS);   assertValidFrame(started);
const token     = await client.waitForType('token', WAIT_TIMEOUT_MS);             assertValidFrame(token);
// WS-42 EXTENDS the smoke sequence with the tool round-trip:
const tcStarted = await client.waitForType('tool_call_started', WAIT_TIMEOUT_MS); assertValidFrame(tcStarted);
const tcDone    = await client.waitForType('tool_call_completed', WAIT_TIMEOUT_MS); assertValidFrame(tcDone);
const completed = await client.waitForType('message_completed', WAIT_TIMEOUT_MS); assertValidFrame(completed);

// Race the sequence against a run_failed/error watcher so a failure frame fails
// fast instead of stalling on a waitForType timeout (see watchForFailure()).
await Promise.race([assertStream(client), watchForFailure(client)]);
```

The existing integration analogue (`test/integration/ws-runs.integration.test.ts`) asserts the same set of types after a single `send_message`:

```ts
harness.fake.setResponder(byTurn(toolTurn('echo', { v: 1 }), textTurn('Hi from WS')));
const client = await connectWs(await wsUrlFor(agent.agentId, session.sessionId));
client.send({ type: 'send_message', content: 'stream please' });
await client.waitForType('message_completed');
const types = client.frames.map((f) => f.type);
expect(types).toContain('message_started');
expect(types).toContain('token');
expect(types).toContain('tool_call_started');
expect(types).toContain('tool_call_completed');
expect(types).toContain('message_completed');
```

### `ChatEventSchema` frames to validate — `packages/shared/src/types/events.ts` (VERBATIM, tool frames)

```ts
export const ToolCallStartedEventSchema = z.object({
  type: z.literal('tool_call_started'),
  callId: z.string(),
  runId: z.string(),
  sessionId: z.string(),
  toolName: z.string(),
}).strict();

export const ToolCallCompletedEventSchema = z.object({
  type: z.literal('tool_call_completed'),
  callId: z.string(),
  runId: z.string(),
  sessionId: z.string(),
  toolName: z.string(),
  status: ToolCallStatusSchema,
}).strict();

export const ChatEventSchema = z.discriminatedUnion('type', [
  MessageStartedEventSchema, TokenEventSchema,
  ToolCallStartedEventSchema, ToolCallCompletedEventSchema,
  MessageCompletedEventSchema, RunFailedEventSchema,
]);
```

Failure surfaces as `run_failed { runId, sessionId, code, message }`; a `run_failed`/`error`/malformed frame is an acceptance failure.

### Public SDK surface the test drives — `packages/sdk/src/app.ts` (VERBATIM `AgentApp`)

```ts
export interface AgentApp {
  agent(definition: AgentDefinition): AgentApp;               // register; duplicate tool names throw
  sessions: {
    create(opts: CreateSessionOptions): Promise<CreateSessionResult>;  // → { sessionId, clientToken, websocketUrl }
    get(id: string): Promise<SessionRecord>;
    messages: { list(sessionId: string, opts?: ListMessagesOptions): Promise<ListMessagesResult> };
  };
  runs: {
    create(opts: CreateRunOptions): Promise<AcceptedRun>;     // 202; execution is process-bound
    get(runId: string): Promise<RunRecord>;
    cancel(runId: string): Promise<AcceptedRun>;
  };
  listen(port?: number): Promise<void>;                        // starts tool runner + registers agents
  close(): Promise<void>;
}

// Constructors / builders (from packages/sdk/src/index.ts):
//   createAgentApp({ apiKey, baseUrl, runnerPublicKey?, runnerWorkspaceId?, runnerAudience? }) → AgentApp
//   defineAgent(...)   tool({ name, description, inputSchema /* Zod */, execute })
```

`createAgentApp` requires `apiKey` (throws `SwiftAgentError(VALIDATION, …)` after WS-41 if missing). `app.listen()` requires the runner verification env (`RUNNER_TOKEN_PUBLIC_KEY`, `RUNNER_WORKSPACE_ID`) or the equivalent options; it registers each agent with the control plane at `baseUrl` and starts the SDK tool runner (the same `startToolRunner` the fake runner uses).

### React client the frontend quickstart drives — `packages/react/src/client.ts`

```ts
export function createChatSession(opts: CreateChatSessionOptions): ChatSessionClient;
// opts: { token, websocketUrl, reconnect?, onError?, createWebSocket? }
//   - websocketUrl is the value returned by POST /v1/sessions (required; empty/invalid throws)
//   - token is appended as ?token=<jwt>
//   - createWebSocket lets the test inject a `ws`-backed socket in Node (no DOM WebSocket)
//   - onError receives a typed SwiftAgentError (WS-41) on an abnormal/auth close — NOT a raw Event
```

### Typed error contract the negative path asserts — `@swiftagent/shared` (VERBATIM)

```ts
export class SwiftAgentError extends Error {
  readonly code: SwiftAgentErrorCode;   // VALIDATION | UNAUTHORIZED | NOT_FOUND | CONFLICT | RATE_LIMIT
                                        // | PROVIDER_ERROR | FORBIDDEN | INTERNAL | TIMEOUT | CONNECTION_ERROR
  readonly statusCode: number;
  override readonly cause?: unknown;
  toJSON(): { code: SwiftAgentErrorCode; message: string; statusCode: number };
}
export function isSwiftAgentError(value: unknown): value is SwiftAgentError;
```

### GitHub Packages registry config — from WS-38 (consume)

- Root `.npmrc` (committed by WS-38): `@swiftagent:registry=https://npm.pkg.github.com`.
- Per-package `publishConfig.registry = https://npm.pkg.github.com`.
- **Cross-project install** (the throwaway consumer is a *different* project) needs a PAT with **`read:packages`** wired as `//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}` in the consumer's `.npmrc` — **never committed**; injected from a CI secret / a local user token. `secrets.GITHUB_TOKEN` (same-repo, `packages: read`) is sufficient in this repo's CI.
- **Dist-tags (WS-38):** stable releases on `main` are tagged `latest`; PR snapshots are published under the **`pr`** dist-tag at version `0.0.0-pr-<sha>`. The consumer installs `@swiftagent/sdk@pr` (etc.) on PR runs and `@swiftagent/sdk@latest` on `main` — both are real GitHub Packages installs.

### CI gate insertion point — `.github/workflows/ci.yml` (the job to model on)

```yaml
  integration-tests:
    name: Integration Tests
    runs-on: ubuntu-latest
    needs: [build-lint, unit-tests]
    services:
      redis:   { image: redis:7-alpine, ports: ['6379:6379'], options: '--health-cmd ...' }
      postgres:{ image: postgres:16-alpine, ... }        # shell-reachable DB for the drift guard
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4  { version: ${{ env.PNPM_VERSION }} }
      - uses: actions/setup-node@v4 { node-version: ${{ env.NODE_VERSION }}, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - name: Run integration tests
        run: pnpm test:integration
        env:
          REDIS_URL: redis://localhost:6379
          # DATABASE_URL is provisioned per-suite by test/setup-db.ts (Testcontainers).
```

## Design Notes

- **Testcontainers boot + migrate — reuse `test/setup-db.ts` verbatim.** The acceptance Vitest config's `globalSetup` points at the *existing* `./test/setup-db.ts`, which starts `postgres:16-alpine`, sets `DATABASE_URL`, and applies the committed `packages/db/drizzle` migrations through the Drizzle migrator (the single source of truth used by CI/deploy). No second container, no hand-written DDL, no shelling to `dist/migrate.js`. The suite then calls `createRuntimeHarness()` (reads `DATABASE_URL`) to compose the real runtime on top. Redis: the harness gateway runs `redisEnabled: false` (single-node), so **no Redis is required for the default acceptance path** — keep it OFF for determinism. Only if a suite explicitly exercises multi-node fanout would it need a `RedisContainer` (from `testcontainers`) / the CI `redis` service; do not add Redis unless a scenario requires it.

- **Stub-agent determinism — reuse the WS-25 fake path; DO NOT change the runtime loop.** The "deterministic stub streaming agent" is the existing `createFakeProvider()` registered under `fake` / model string `fake/deterministic` in `createRuntimeHarness()`. The tool round-trip is produced by the scripted responder `byTurn(toolTurn('echo', { v: 1 }), textTurn('Hi from acceptance'))` — turn 0 emits a `tool_call` for `echo`; after the tool result, turn 1 emits text and finishes. The `echo` tool is a **real SDK tool runner** (`startFakeRunner`) so `tool_call_started`/`tool_call_completed` are genuine round-trips, not mocks. **This selects the stub via a test model string (`fake/deterministic`) already registered in the harness — no runtime-loop change, no new provider.** The SDK-driven variant (below) seeds the agent with `modelConfig.model = 'fake/deterministic'` so the same provider is chosen. If the SDK path cannot reach the harness's in-process `ProviderRegistry` (because `app.listen()` registers agents against a *separately-booted* server process), spec the server to boot **in-process** within the test (via the harness composition), so the SDK's `baseUrl`/`websocketUrl` point at the harness's REST + gateway listeners — **flag this as the chosen minimal test-only wiring**; it registers/seeds through the same repos and provider registry without altering `apps/server` or the loop.

- **How the SDK drives the flow (two acceptable compositions — pick one, document it).**
  1. **In-process harness drive (primary).** Boot `buildRestApp(runService)` + `buildGateway(runService)` from `createRuntimeHarness()` on ephemeral ports. Point the SDK's `createAgentApp({ apiKey, baseUrl: <restUrl> })` at the REST listener; seed the workspace + API key (`seedWorkspaceWithKey`), the stub agent (`seedAgent({ model: 'fake/deterministic', tools: [seededTool('echo')], toolRunnerUrl })`), and start a `startFakeRunner` for `echo`. Then drive `app.sessions.create({ agentName })` → consume `{ sessionId, clientToken, websocketUrl }` → `connectWs(websocketUrl)` → `send_message` → assert. This exercises the **real public SDK client** (`ControlPlaneClient` under `createAgentApp`) against the real REST + gateway, deterministically.
  2. **Published-package drive (the registry proof).** The *same* flow, but the SDK/`@swiftagent/*` symbols are imported from the **installed published packages** in the throwaway consumer dir (see next note), proving the shipped artifacts resolve/typecheck/run. Because the consumer is outside the workspace, it points `baseUrl`/`websocketUrl` at the in-process server the suite booted (pass the URLs via env into the consumer entrypoint, or run the consumer's import+drive as a child `tsx` process). Keep the consumer minimal: import `createAgentApp`/`defineAgent`/`tool` + `createChatSession`, run one happy-path drive, exit 0.

- **GitHub Packages install (the SC-09 install proof) — registry-only, no tarball path.** A **real GitHub Packages install is the sole path that satisfies SC-09**; there is no local-tarball stand-in. `test/acceptance/install-published.ts` (a) makes a temp dir (`os.tmpdir()`), (b) **discovers which version/tag to install**: on a PR it targets WS-38's PRERELEASE snapshot via the **`pr`** dist-tag (install `@swiftagent/sdk@pr` etc., which resolves to `0.0.0-pr-<sha>`; the tag/version can be confirmed with `npm view @swiftagent/sdk dist-tags.pr --registry=https://npm.pkg.github.com` or by reading the WS-38 workflow output), and on `main` it targets the stable `latest` tag (`npm view @swiftagent/sdk version`). Detect PR vs main from the CI context (e.g. `GITHUB_EVENT_NAME`/`GITHUB_REF`) with a sensible local default. (c) writes a `package.json` depending on `@swiftagent/sdk` + `@swiftagent/react` (+ `@swiftagent/shared` if not transitive) at the resolved tag/version, (d) writes a consumer `.npmrc` with `@swiftagent:registry=https://npm.pkg.github.com` and `//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}` (token from env — a `read:packages` PAT locally, `secrets.GITHUB_TOKEN` in CI), (e) runs `npm install` (plain npm in the isolated dir — *not* pnpm workspace resolution, so `workspace:*` is not short-circuited and the real registry tarball is fetched), (f) imports the packages and runs a smoke drive. The resolved tag/version is logged loudly so a CI reader knows exactly which published artifact was exercised. **If the registry is unreachable or nothing is published under the expected tag, the step FAILS loudly — it does not fall back to a local build.** **Justification:** the real-registry install is the only thing that proves publishing (WS-38) actually produces installable artifacts; WS-38's PR snapshot publish (the `pr` dist-tag) is precisely what makes this registry-only path viable on PRs, so no tarball stand-in is needed.

- **`test/` tree excluded from typecheck/lint — validate via the runner (MEMORY).** Per project convention the root `test/` tree is **excluded** from `pnpm typecheck` / `pnpm lint`; it is validated by *running* it (Testcontainers, Docker). Therefore the acceptance suite is **not** covered by the SC-10 typecheck/lint gates — it is validated by `pnpm test:acceptance`. Do **not** attempt to add `test/acceptance/` to the typecheck/lint globs (that would fight the convention and pull test-only deps into the prod graph). State this explicitly in the CI job and the suite header. (The published-package consumer *does* get typechecked — but by its **own** `tsc` inside the throwaway dir against the installed `.d.ts`, proving the shipped types resolve; that is a runtime step of the acceptance suite, not the monorepo typecheck.)

- **No runtime-loop change; no SDK-surface change.** WS-42 authors a **test** and a **CI gate**. It must not edit `packages/sdk`, `packages/react`, `packages/runtime`, `packages/gateway`, `apps/server`, or the `ChatEvent` union. If the SDK-driven flow reveals a gap (e.g. no way to select the stub provider through the public path), **flag it for WS-36/the runtime program — do not patch the loop here.** The minimal test-only registration (seeding the stub agent + fake runner through the harness repos/registry) is confined to `test/`.

- **Fail loud, bounded, deterministic (mirror the smoke test).** Every wait is bounded: `connectWs` open timeout, per-`waitForType` timeout, an overall wall-clock budget per scenario, and — for the install step — a bounded `npm install` timeout. A realtime bug manifests as *silence*, so race the happy-path sequence against a `run_failed`/`error` watcher (as the smoke test does) so a failure frame fails fast. On any failure, print diagnostics: the `POST /v1/sessions` status/body (or the SDK `SwiftAgentError.code`/`message`/`cause`), the WS close code/reason, and `client.frames`. No real provider keys, no network nondeterminism (the only network hop is the GitHub Packages install, itself bounded + retried; it fails loud rather than falling back to a local build).

## Implementation Steps

1. **Confirm the dependency surface is live.** Verify: (a) `examples/quickstart/` exists (WS-39) and read its `backend/src/server.ts` + `frontend/src/App.tsx` so the acceptance flow mirrors the documented calls; (b) root `.npmrc` contains `@swiftagent:registry=https://npm.pkg.github.com` (WS-38); (c) WS-38 publishes to GitHub Packages — a stable `latest` from `main` **and** a PR snapshot under the `pr` dist-tag (`npm view @swiftagent/sdk dist-tags --registry=https://npm.pkg.github.com` should show `latest` and, for PR-time runs, `pr` → `0.0.0-pr-<sha>`); (d) `SwiftAgentError` is exported from `@swiftagent/shared` and routed through the SDK client (WS-41). **If (a) or (b) is missing, or WS-38's PR snapshot publish is absent (so a PR run has nothing to install), STOP and report which dependency is incomplete** — do not author around it, and do not substitute a local-tarball install.

2. **Add the acceptance Vitest config `test/vitest.acceptance.config.ts` (NEW).** Sibling of the integration config: `include: ['test/acceptance/**/*.acceptance.test.ts']`, `globalSetup: ['./test/setup-db.ts']`, `environment: 'node'`, `globals: true`, and generous `testTimeout` (e.g. 120_000) + `hookTimeout` (e.g. 120_000) to absorb the install + boot. No Redis by default.

3. **Author `test/acceptance/support/acceptance-server.ts` (NEW, if the drive needs a single composed handle).** Wrap `createRuntimeHarness()` + `buildRestApp` + `buildGateway` into `{ baseUrl, websocketBaseUrl, harness, teardown() }`. Seed helpers (`seedWorkspaceWithKey`, `seedAgent` with `model:'fake/deterministic'` + `tools:[seededTool('echo')]` + `toolRunnerUrl`, `seedSession`) and a `startFakeRunner` for `echo` live here. Set the fake responder to `byTurn(toolTurn('echo', { v: 1 }), textTurn('Hi from acceptance'))`. Keep it thin; reuse the harness — do not duplicate composition.

4. **Author `test/acceptance/quickstart.acceptance.test.ts` (NEW) — the happy path (SC-09).** Boot the server (Step 3). Drive the documented quickstart via the **public SDK**: `const app = createAgentApp({ apiKey, baseUrl })`; register the stub agent via `app.agent(defineAgent(...))` where the tool is `tool({ name:'echo', description, inputSchema: z.object({}).passthrough(), execute })` (matching the seeded `echo`); `await app.sessions.create({ agentName })` → destructure `{ sessionId, clientToken, websocketUrl }`; `const client = await connectWs(websocketUrl, OPEN_TIMEOUT_MS)`; `client.send({ type:'send_message', content:'hello from quickstart' })`. Assert, each frame `ChatEventSchema`-validated and bounded, and raced against a `run_failed`/`error` watcher: `message_started → token(≥1) → tool_call_started → tool_call_completed → message_completed`. Assert `framesOfType('tool_call_started')[0].toolName === 'echo'`. `await client.close(); await teardown()`.

5. **Add the tool-round-trip assertion explicitly (SC-09).** In the same or a sibling test, assert the round-trip beyond mere sequence: a `tool_call_started` with `toolName:'echo'` and a matching `callId`, then a `tool_call_completed` with the same `callId` and a terminal `status`. This proves the tool ran on the real SDK runner, not that a frame merely appeared.

6. **Author `test/acceptance/install-published.ts` (NEW) + the install test (SC-09).** Implement the throwaway-consumer **registry-only** install per Design Notes (temp dir, consumer `.npmrc` with scope map + `${NODE_AUTH_TOKEN}`; detect PR vs main and resolve the tag/version accordingly — `pr` dist-tag → `0.0.0-pr-<sha>` on PRs, `latest` stable on main; `npm install`; loud tag/version logging). Export a function the suite awaits. Add `test/acceptance/install-registry.acceptance.test.ts` (or a block in the main suite) that: runs the install, asserts `@swiftagent/sdk`/`@swiftagent/react`/`@swiftagent/shared` resolve in the consumer's `node_modules`, imports them (`createAgentApp`, `createChatSession`, `SwiftAgentError`) and asserts the symbols are defined and typecheck against the shipped `.d.ts` (run `tsc --noEmit` inside the consumer dir), and — as the capstone — runs the consumer's one happy-path drive against the in-process server (URLs passed via env). Bound the whole step; if the registry is unreachable or nothing is published under the expected tag, **fail loud (non-zero) — never silently pass and never fall back to a local tarball**.

7. **Author the negative path (SC-09 / WS-41).** Add a test that drives a deliberately-broken flow through the SDK and asserts a **typed** `SwiftAgentError`, not an opaque failure: e.g. (a) `createAgentApp({ apiKey: '' })` throws `SwiftAgentError(VALIDATION, …)` (message names `apiKey`); (b) `app.sessions.create` with a bad API key surfaces `isSwiftAgentError(e) === true` with `code === 'UNAUTHORIZED'` and a readable message; and/or (c) a client connect with a tampered/missing token yields `onError` receiving a `SwiftAgentError` (not `[object Event]`) on the abnormal close. Assert `isSwiftAgentError(e)`, the `code`, and that `e.message` is human-readable.

8. **Add the root script (MODIFY `package.json`).** `"test:acceptance": "vitest run --config test/vitest.acceptance.config.ts"` (+ optional `"test:acceptance:install": "tsx test/acceptance/install-published.ts"`). Confirm `tsx`, `ws`, `@testcontainers/postgresql`, `testcontainers`, and the workspace `@swiftagent/*` devDeps needed are already present in the root `package.json` (they are, for the integration suites) — add none unless a genuinely new dep is required (flag it if so).

9. **Wire the CI gate (MODIFY `.github/workflows/ci.yml`).** Add an `acceptance-tests` job `needs: [build-lint, unit-tests, integration-tests]`, `runs-on: ubuntu-latest`, `permissions: { contents: read, packages: read }` (for the GitHub Packages install). Steps: checkout → `pnpm/action-setup@v4` → `actions/setup-node@v4` (with `registry-url: https://npm.pkg.github.com` + `scope: '@swiftagent'` so `NODE_AUTH_TOKEN` wires the consumer auth) → `pnpm install --frozen-lockfile` → `pnpm build` → `pnpm test:acceptance` with `env: { NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }} }` (Testcontainers uses the ubuntu-runner Docker daemon; no `services:` block needed since the DB comes from Testcontainers and Redis is OFF by default). A non-zero exit **blocks the pipeline** (default `run` behavior) — this is the required gate. Ensure the job runs on both `pull_request` and `push` (inherits the workflow `on:`).

10. **Verification (see Tests + CLAUDE.md §4).** Because `test/` is excluded from typecheck/lint, validate by running: `pnpm test:acceptance` locally (needs Docker) must pass; run the negative and install scenarios; then run the full monorepo gates (`pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:integration`) and confirm **no regression** (SC-10; honor the MEMORY pre-existing-failure notes — do not attribute those to this change). Grep-sweep (CLAUDE.md §10) for any accidental committed token (`_authToken`, literal PATs) in the new files.

## Tests

This workstream's **deliverable IS a test suite.** The scenarios below are the acceptance suite's own cases (run via `pnpm test:acceptance`); the final numbered item is the meta-verification that the monorepo gates still pass.

1. **Happy-path event sequence (SC-09).** Boot the stub-agent stack on Testcontainers PG (Redis OFF). Drive `createAgentApp` → `app.sessions.create` → `connectWs(websocketUrl)` → `send_message`. Assert the exact ordered sequence `message_started → token(≥1) → tool_call_started → tool_call_completed → message_completed`, every frame `ChatEventSchema`-validated, bounded by per-wait + overall-budget timeouts, raced against a `run_failed`/`error` watcher. Exits green; on failure prints diagnostics (POST status/body or `SwiftAgentError`, WS close code, `client.frames`).

2. **Tool-call round-trip (SC-09).** Assert the round-trip is real: a `tool_call_started` with `toolName:'echo'` + a `callId`, then a `tool_call_completed` with the **same** `callId` and a terminal `status`, produced by the real SDK tool runner (`startFakeRunner`) via the scripted `byTurn(toolTurn('echo',…), textTurn(…))` responder — not a mocked frame.

3. **Negative case surfaces a typed `SwiftAgentError` (SC-09 / WS-41).** At least one of: `createAgentApp({ apiKey:'' })` throws `SwiftAgentError(VALIDATION, …)` naming `apiKey`; a bad-API-key `sessions.create` rejects with `isSwiftAgentError(e) && e.code === 'UNAUTHORIZED'`; a missing/tampered client token yields `onError(SwiftAgentError)` (readable message, **not** `[object Event]` / a bare `HTTP 401`). Assert `isSwiftAgentError`, `.code`, and a human-readable `.message`.

4. **Install-from-registry resolution check (SC-09 — the install proof).** Run `install-published.ts`: install the published `@swiftagent/*` from `npm.pkg.github.com` into a throwaway consumer — the PRERELEASE `pr`-tag snapshot on PRs, the stable `latest` on `main` (a real registry install either way; **no tarball path**) — assert the packages resolve in the consumer's `node_modules`, `import` `createAgentApp`/`createChatSession`/`SwiftAgentError` and assert they are defined, `tsc --noEmit` the consumer against the shipped `.d.ts`, and run the consumer's one happy-path drive against the in-process server. Log the resolved tag/version loudly. A missing publish / unreachable registry **fails the test**, it does not degrade to a local build.

5. **Bounded / fail-loud check.** Point one scenario at a torn-down/unreachable server and assert it fails **non-zero within the wall-clock budget** (does not hang) with captured diagnostics — mirroring the smoke test's deliberately-broken-target behavior.

6. **CI gate wiring.** Confirm `.github/workflows/ci.yml` has an `acceptance-tests` job `needs: [build-lint, unit-tests, integration-tests]` with `packages: read` + `NODE_AUTH_TOKEN`, running `pnpm test:acceptance`, and that a non-zero exit blocks the pipeline. Lint the workflow (`actionlint`).

7. **Monorepo gates unaffected (SC-10).** `pnpm typecheck`, `pnpm lint`, `pnpm test` pass; `pnpm test:integration` shows no **new** failures beyond the documented pre-existing ones (MEMORY: `@swiftagent/server` exit-1 and 3 `@swiftagent/api` failures are pre-existing). The new config/script/CI-job must not regress install or build. (The acceptance suite itself is validated by `pnpm test:acceptance`, not by typecheck/lint, since `test/` is excluded — state this.)

## Acceptance Criteria

1. A NEW acceptance suite (`test/acceptance/quickstart.acceptance.test.ts`) exists that, against a Testcontainers-Postgres-backed locally-booted stack (migrations applied via the existing `test/setup-db.ts`), drives the documented quickstart through the **public SDK** — `createAgentApp` → `app.sessions.create` → `connectWs(websocketUrl)` (reusing `test/support/ws-client.ts`) → `send_message` — and asserts the ordered `message_started → token(≥1) → tool_call_started → tool_call_completed → message_completed` `ChatEvent` sequence, every frame validated with `ChatEventSchema`, treating `run_failed`/`error`/malformed frames as failures (SC-09).
2. The suite exercises a **real tool-call round-trip** against a **deterministic streaming stub agent** (`fake/deterministic` provider + the `echo` SDK tool runner via `byTurn(toolTurn('echo',…), textTurn(…))`) — `tool_call_started`/`tool_call_completed` carry a matching `callId` and `toolName:'echo'` — with **no real provider key** and no runtime-loop change (SC-09).
3. A NEW `test/acceptance/install-published.ts` **installs the published `@swiftagent/sdk` + `@swiftagent/react` (+ `@swiftagent/shared`) from GitHub Packages** (`npm.pkg.github.com`) into a throwaway consumer using a `read:packages` token — **this real registry install is the ONLY path that satisfies SC-09; there is no local-tarball fallback** — imports them, typechecks against the shipped `.d.ts`, and runs a happy-path drive. On PRs it installs WS-38's PRERELEASE snapshot via the `pr` dist-tag (`@swiftagent/sdk@pr` → `0.0.0-pr-<sha>`); on `main` it installs the stable `latest` version; the resolved tag/version is logged loudly. A missing publish or unreachable registry **fails loud** rather than degrading to a local build. The install auth is **never committed** (token from `NODE_AUTH_TOKEN` / a CI secret) (SC-09).
4. A **negative case** asserts a typed, human-readable `SwiftAgentError` (via `isSwiftAgentError` + `.code` + readable `.message`, e.g. `VALIDATION`/`UNAUTHORIZED`/`CONNECTION_ERROR`) on a deliberately-broken flow — never `[object Event]` or a bare `HTTP 401` (SC-09 / WS-41).
5. The suite is **bounded and deterministic**: `connectWs` open timeout, per-`waitForType` timeouts, an overall per-scenario wall-clock budget, a bounded install step, a `run_failed`/`error` failure watcher, and diagnostics printed on failure; a deliberately-broken-target scenario fails **non-zero within the budget** rather than hanging (SC-09).
6. A root script `test:acceptance` (`vitest run --config test/vitest.acceptance.config.ts`) exists, and `.github/workflows/ci.yml` has an **`acceptance-tests` job** `needs: [build-lint, unit-tests, integration-tests]` with `permissions: packages: read` + `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`, running `pnpm test:acceptance` as a **required gate** — a non-zero exit blocks the pipeline; the workflow lints clean (`actionlint`) (SC-09).
7. The workstream authors **only** the test/config/script/CI-gate — no change to `packages/sdk`, `packages/react`, `packages/runtime`, `packages/gateway`, `apps/server`, `test/setup-db.ts`, the `ChatEvent` union, or the docs. Any gap found in the public SDK path is **flagged** for the owning workstream, not patched here.
8. The monorepo gates remain green (SC-10): `pnpm typecheck`, `pnpm lint`, `pnpm test` pass and `pnpm test:integration` shows no new failures beyond the documented pre-existing ones; the acceptance suite (living under the typecheck/lint-excluded `test/` tree) is validated by `pnpm test:acceptance` — this exclusion is stated explicitly rather than silently leaving the suite unvalidated.
