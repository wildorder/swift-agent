# WS-43: Local Stack Coherence

## Goal

Make `docker compose up` produce a **genuinely working end-to-end local stack from a clean checkout** — including every credential, identity, and fixture a real tool round trip needs — and prove it with an automated smoke check that asserts the tool events.

The compose repair is the smaller half. Today's `docker-compose.yml` publishes `3000` and `3001` and hands clients `PUBLIC_WEBSOCKET_URL: ws://localhost:3001`, but `apps/server/src/main.ts:99` binds a **single** listener on `API_PORT` (3000) serving REST + WebSocket — port 3001 has nothing behind it. Fixing that yields a stack that *connects* and still cannot complete a turn, because a clean checkout has Postgres, Redis, and the listener and **nothing else**: no model configuration, no workspace, no API key, no agent, no tool, no runner keys, no runner. `test/smoke/realtime-smoke.ts` makes this concrete — it hard-requires a pre-seeded `SMOKE_API_KEY` and an existing `smoke-echo` agent and does not self-provision (its env check exits at `realtime-smoke.ts:125-136`).

Five cohesive deliverables:

1. **Compose repair (SC-02).** Published ports and `PUBLIC_WEBSOCKET_URL` match the single listener: publish only `3000`, and hand out a WebSocket URL that actually resolves — which means fixing **two** defects in the current value, not one: the port (3001 → 3000) *and* the missing canonical path (`/v1/stream`), since `packages/api/src/routes/sessions.ts:34` builds `websocketUrl` as `` `${publicWebsocketUrl}?token=${clientToken}` `` verbatim.
2. **Self-provisioning local bootstrap (SC-01).** A one-shot compose service that establishes, idempotently: a model configuration the server accepts; a workspace; a **raw dev API key whose stored hash matches, surfaced to the developer**; a registered agent carrying at least one tool; and runner signing/verification keys with a **reachable runner service** on the compose network.
3. **Deterministic tool-calling model fixture (SC-01).** A zero-cost provider (sibling of the existing `echo` provider in `packages/models`) that deterministically emits a `tool_call` chunk on its first turn and streams tokens after the tool result — so the smoke check asserts a real tool round trip rather than depending on a live provider deciding to call a tool.
4. **Smoke check without pre-supplied secrets (SC-01).** The smoke check runs against compose with **no pre-supplied `SMOKE_API_KEY` and no manually seeded `smoke-echo` agent**, and asserts **both `tool_call_started` and `tool_call_completed`**, not only token frames. The existing cloud smoke path (deploy workflows call `pnpm smoke:realtime` with `SMOKE_API_KEY` + `smoke-echo`) must keep working unchanged.
5. **Documentation.** The one-command local path in `README.md` and `docs/quickstart.md`, including **where the generated dev API key appears**.

Also verified along the way: the compose stack migrates via the **existing** `AUTO_MIGRATE` flag (consumed at `apps/server/src/config.ts:130` — mechanism unchanged) and serves REST + WebSocket on one port.

This workstream adds **no public runtime or SDK surface** — provisioning uses existing repositories, migrations, and configuration. Everything it creates is development-only and must be **inert or absent** in the deploy template (WS-47) and the playground (WS-49).

## Traceability

- **SC-01** — From a clean checkout, `docker compose up` starts Postgres, Redis, and the server AND self-provisions everything a real turn needs, after which an automated smoke check completes a streaming turn over WebSocket asserting BOTH `tool_call_started` and `tool_call_completed`, with no manual seeding and no pre-supplied `SMOKE_API_KEY`.
- **SC-02** — `docker-compose.yml` contains no port or `PUBLIC_WEBSOCKET_URL` value that contradicts the single-listener behaviour in `apps/server/src/main.ts`.

## Dependencies

- **WS-51 — Canonical Verification Gate Stability.** Provides the deterministic gate: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` pass repeatably (the apps/server index-export test no longer flakes on a timing margin under parallel turbo load), so this workstream's checkpoint is judged on a gate that only goes red for real defects. WS-43 consumes that stability and must itself finish with all four commands green (program-wide checkpoint rule).

## Context Files (Agent MUST read before implementing)

- `C:\dev\swift-agent\CLAUDE.md` — conventions (Zod source of truth; factory repos `createXxxRepo(db)`; prefixed IDs `ws_`/`ak_`/`agt_`; env vars via `ENV_KEYS`; forced verification; NO SEMANTIC SEARCH).
- `C:\dev\swift-agent\docs\programs\oss-direction-manifest.json` — `constraints.localBootstrap` and `constraints.canonicalGate`, `successCriteria[SC-01, SC-02]`, `workstreams[WS-43]` (includes/excludes are canonical there).
- `C:\dev\swift-agent\docker-compose.yml` — the file under repair: `build:` from `apps/server/Dockerfile`, ports `3000:3000` + `3001:3001`, `PUBLIC_WEBSOCKET_URL: ws://localhost:3001`, `GATEWAY_PORT: '3001'`, `AUTO_MIGRATE: 'true'`, committed dev `CLIENT_JWT_SECRET`, optional `.env` via `env_file`. Note it sets **no model-provider key** — see Design Notes on the boot gap.
- `C:\dev\swift-agent\apps\server\src\main.ts` — the single listener (`await api.app.listen({ port: apiPort, host: '0.0.0.0' })` at **line 99** — verified; the program doc's `main.ts:99` citation is accurate), the `AUTO_MIGRATE` block (lines 31–43, migrating from `packages/db/drizzle`), and the banner note that `GATEWAY_PORT` is intentionally not a listening port.
- `C:\dev\swift-agent\apps\server\src\config.ts` — `loadServerConfig`: required vars (lines 85–101) including **"at least one of OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_API_KEY"** — the reason a clean-checkout compose cannot even boot today; `AUTO_MIGRATE` read at **line 130** (verified; the manifest's `config.ts:130` citation is accurate); the `DEPLOY_ENV` cloud-env pattern (read directly from env, not ENV_KEYS) to mirror for the new local-fixture flag.
- `C:\dev\swift-agent\apps\server\src\container.ts` — the echo-provider registration precedent (lines 154–160: always registered with a throwaway config, excluded from `registeredProviders`); the runner signing-key wiring (lines 174–186: `RUNNER_TOKEN_PRIVATE_KEY` imported lazily via `importRunnerPrivateKey`, only failing when a remote tool actually runs); the outbound URL policy (lines 190–194: `requireHttps` defaults **true** unless `RUNNER_REQUIRE_HTTPS` is explicitly `false` — compose must set it, or the `http://runner:…` target is rejected).
- `C:\dev\swift-agent\packages\db\src\provision-smoke.ts` — the model for the bootstrap script: idempotent find-or-create of workspace → API key (`key_hash = sha256(raw)`) → echo agent, using `createWorkspaceRepo`/`createApiKeyRepo`/`createAgentRepo` and `generate*Id()` from shared. The new local provisioner is a sibling, not an edit of this file (the cloud deploy workflows invoke `provision-smoke.js` by path — do not break them).
- `C:\dev\swift-agent\packages\db\src\repositories\api-key-repo.ts` — `create({apiKeyId, workspaceId, keyHash, name})`, `getByKeyHash(keyHash)`; auth stores only the sha256 hex hash.
- `C:\dev\swift-agent\packages\db\src\repositories\agent-repo.ts` — `create(...)` accepts `tools?: ToolDefinition[]` and `toolRunnerUrl?: string | null`; `getByName(workspaceId, name)` for idempotency.
- `C:\dev\swift-agent\packages\models\src\providers\echo.ts` — the zero-cost provider precedent (streams the last user message; **emits no `tool_call` chunk**, which is why it cannot satisfy SC-01's tool round trip) and the provider ordering contract to honour: `token*` → `tool_call*` → exactly one `finish`.
- `C:\dev\swift-agent\packages\models\src\types.ts` — `ModelStreamChunkSchema` (`token` / `tool_call {toolName, callId, arguments}` / `finish {finishReason, usage}`), `ProviderConfig`, `ModelRequest` (with runtime-only `signal`).
- `C:\dev\swift-agent\packages\models\src\registry.ts` — `ProviderRegistry.register(providerId, factory, config)` and `resolveForModel('fixture/…')` — the provider id is the segment before the `/` in the agent's `modelConfig.model`.
- `C:\dev\swift-agent\test\support\fake-provider.ts` — the design model for the fixture: a scripted provider whose turn index is derived from how many `tool`-role messages are in the request (`byTurn`), honouring `request.signal`. The fixture is the same idea made **production-shaped** (no test-only handle, fixed script) and living in `packages/models` so the Docker image contains it.
- `C:\dev\swift-agent\test\smoke\realtime-smoke.ts` — the smoke check to extend: `requireEnv()` hard-exits without `SMOKE_API_KEY`; `SMOKE_AGENT_NAME` defaults to `smoke-echo`; asserts `message_started → token → message_completed` only; bounded waits via `test/support/ws-client.ts` (`connectWs`, `WsClient.waitForType/waitFor`).
- `C:\dev\swift-agent\packages\sdk\src\tool-runner.ts` — `startToolRunner({port, registry, auth})`: the real runner server (versioned `POST /tools/:toolName`, scoped-token verification, unauthenticated `GET /health`) the local runner service starts. Read `packages/sdk/src/types.ts` for `ToolRegistry` / `RunnerAuthConfig` shapes.
- `C:\dev\swift-agent\packages\shared\src\config.ts` — `ENV_KEYS`: `RUNNER_TOKEN_PRIVATE_KEY` / `RUNNER_TOKEN_PUBLIC_KEY` (PEM PKCS8/SPKI or JWK JSON), `RUNNER_WORKSPACE_ID`, `RUNNER_AUDIENCE` (falls back to `TOOL_RUNNER_PUBLIC_URL`), `RUNNER_REQUIRE_HTTPS`. Use existing keys only; add none.
- `C:\dev\swift-agent\test\support\runtime-harness.ts` — end-to-end precedent for the whole credential topology: EdDSA keypair via `jose.generateKeyPair`, `sha256` API-key hashing that matches auth, agent seeded with `tools` + `toolRunnerUrl`, dev policy `{requireHttps: false, allowLoopback: true}`.
- `C:\dev\swift-agent\apps\server\Dockerfile` — two stages: `builder` (full workspace source + all deps, `pnpm turbo run build --filter=@swiftagent/server...`) and the prod `runner` stage (`--prod` prune; contains `packages/db/dist` and `packages/db/drizzle` but **not** `@swiftagent/sdk`). This is why the bootstrap one-shot can run from the prod image while the local tool-runner service must run from the `builder` target (see Design Notes). `EXPOSE 3000`, healthcheck on `/health`.
- `C:\dev\swift-agent\packages\api\src\server.ts` — lines 33–50: the `LOCAL_ONLY_WEBSOCKET_URL = 'ws://localhost:3001'` doc comment enumerating exactly what is wrong with that shape ("`ws:` scheme, `:3001` port, **no `/v1/stream` path**") — authoritative confirmation the corrected compose value needs the path.
- `C:\dev\swift-agent\.github\workflows\deploy-dev.yml` — **READ-ONLY** (any change here is excluded): how the cloud path provisions (`provision-smoke.js` as an ECS one-off with `SMOKE_API_KEY`) and then runs `pnpm smoke:realtime` with `SMOKE_AGENT_NAME: smoke-echo`. The smoke-check extension must leave this invocation working byte-for-byte.
- `C:\dev\swift-agent\README.md` (Self-hosting table, Development section) and `C:\dev\swift-agent\docs\quickstart.md` — the docs surfaces to update with the one-command local path.

## Package

`apps/server`, `packages/db`, `packages/models`, `test/smoke`, `docs/` (per the manifest). Root glue only where unavoidable: a `smoke:local` script in the root `package.json` (sibling of the existing `smoke:realtime`) and a `.gitignore` entry for the generated-credentials directory.

`infra/`, `.github/workflows/*`, `packages/sdk`, `packages/api`, `packages/runtime`, `packages/gateway` are **read but not modified**.

## Files Touched

- `docker-compose.yml` **(MODIFY)** — the SC-02 repair plus the bootstrap topology:
  - `swift-agent` service: publish **only** `3000:3000`; set `PUBLIC_WEBSOCKET_URL: ws://localhost:3000/v1/stream`; **remove** the `GATEWAY_PORT` env line and the `3001:3001` mapping (the env *key* remains valid in `ENV_KEYS` for the standalone gateway — compose merely stops implying the server binds it); add `LOCAL_FIXTURE_PROVIDER: 'true'`, `RUNNER_REQUIRE_HTTPS: 'false'`, and the dev-only `RUNNER_TOKEN_PRIVATE_KEY` (see Design Notes).
  - `bootstrap` service **(NEW)** — one-shot, prod image (`build:` same Dockerfile), `command: ["node", "packages/db/dist/provision-local.js"]`, `depends_on: swift-agent: condition: service_healthy` (so `AUTO_MIGRATE` has created the schema), bind mount `./.swiftagent-local:/bootstrap-out`.
  - `runner` service **(NEW)** — `build: { context: ., dockerfile: apps/server/Dockerfile, target: builder }`, `command: ["pnpm", "exec", "tsx", "test/smoke/local-runner.ts"]`, `depends_on: bootstrap: condition: service_completed_successfully`, env `RUNNER_TOKEN_PUBLIC_KEY` (dev pair of the private key) + bind mount `./.swiftagent-local:/bootstrap-out:ro` (reads the workspace id), internal port only (no host publish needed).
- `packages/db/src/provision-local.ts` **(NEW)** — the idempotent local bootstrap (see Implementation Steps 3).
- `packages/models/src/providers/tool-fixture.ts` **(NEW)** — `createToolFixtureProvider(config: ProviderConfig): ModelProvider`, the deterministic tool-calling fixture.
- `packages/models/src/index.ts` **(MODIFY)** — export `createToolFixtureProvider` from the barrel (grep-verify all barrel/type/test references per CLAUDE.md rule 10).
- `packages/models/src/__tests__/tool-fixture.test.ts` **(NEW)** — unit tests for the fixture.
- `apps/server/src/config.ts` **(MODIFY)** — `LOCAL_FIXTURE_PROVIDER` boot flag: read directly from env (mirroring `AUTO_MIGRATE`/`DEPLOY_ENV`, NOT added to `ENV_KEYS`), satisfies the at-least-one-model-key requirement locally, **hard error when `DEPLOY_ENV` is a cloud env** (see Design Notes).
- `apps/server/src/container.ts` **(MODIFY)** — register the `fixture` provider **only when the flag is set** (unlike echo, which stays always-registered for the cloud smoke); excluded from `registeredProviders` like echo, or listed with a `(local)` marker — pick one and doc-comment it.
- `apps/server/src/__tests__/config.test.ts` / `apps/server/src/__tests__/container.test.ts` **(MODIFY)** — extend for the flag semantics and gated registration.
- `test/smoke/local-runner.ts` **(NEW)** — the compose runner-service entry point: `startToolRunner` from `@swiftagent/sdk` with one `local_echo` tool.
- `test/smoke/realtime-smoke.ts` **(MODIFY)** — key-file fallback + `REQUIRE_TOOLS` mode (see Implementation Steps 6); cloud invocation unchanged by default.
- `package.json` (root) **(MODIFY)** — `"smoke:local"` script.
- `.gitignore` **(MODIFY)** — add `.swiftagent-local/`.
- `README.md`, `docs/quickstart.md` **(MODIFY)** — the one-command local path and where the dev key appears.

## Existing Interfaces to Consume

**The single listener the compose values must agree with** (`apps/server/src/main.ts:98-99`):

```typescript
  // 7. Start listening — a SINGLE public listener serving REST + WS (SC-01).
  await api.app.listen({ port: apiPort, host: '0.0.0.0' });
```

**How `PUBLIC_WEBSOCKET_URL` becomes the client's URL — verbatim prefix, so the path must be in the env value** (`packages/api/src/routes/sessions.ts:34`):

```typescript
    const websocketUrl = `${publicWebsocketUrl}?token=${clientToken}`;
```

**The boot gap: at least one real provider key is required today** (`apps/server/src/config.ts:92-100`):

```typescript
  // At least one model provider key is required
  const modelKeys = [
    ENV_KEYS.OPENAI_API_KEY,
    ENV_KEYS.ANTHROPIC_API_KEY,
    ENV_KEYS.GOOGLE_API_KEY,
  ] as const;
  const hasModelKey = modelKeys.some((k) => !!env[k]);
  if (!hasModelKey) {
    missing.push(`At least one of: ${modelKeys.join(', ')}`);
  }
```

**The always-registered zero-cost-provider precedent the fixture follows (registration site)** (`apps/server/src/container.ts:154-160`):

```typescript
  // Echo provider — always registered, needs no API key, makes no external
  // call. Reachable only by an agent whose modelConfig.model is `echo/*` (the
  // seeded `smoke-echo` agent used by the deployed realtime smoke test). The
  // explicit throwaway config stops the registry resolving a real env key. It
  // is intentionally NOT added to `registeredProviders`, which tracks only the
  // key-gated real providers surfaced in the startup banner.
  modelRegistry.register('echo', createEchoProvider, { apiKey: 'echo-provider-no-key' });
```

**Runner key + outbound policy wiring — the env the compose file must satisfy** (`apps/server/src/container.ts:174-194`):

```typescript
  const privateKeyMaterial = config[ENV_KEYS.RUNNER_TOKEN_PRIVATE_KEY];
  // Import lazily + once: buildContainer is sync, and tool-less deployments
  // never mint, so a missing key only fails when a remote tool actually runs.
  // ...
  // Deployed environments require HTTPS and disallow loopback; dev/test (https
  // not required) allow loopback for a local runner.
  const requireHttps = config[ENV_KEYS.RUNNER_REQUIRE_HTTPS] !== false;
  const runnerPolicy: OutboundUrlPolicy = {
    requireHttps,
    allowLoopback: !requireHttps,
  };
```

**The idempotent provisioning pattern to mirror** (`packages/db/src/provision-smoke.ts:44-46, 85-91, 99-106`):

```typescript
function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}
// ...
      const apiKey = await apiKeyRepo.create({
        apiKeyId: generateApiKeyId(),
        workspaceId,
        keyHash,
        name: 'Realtime Smoke Key',
      });
// ...
      const agent = await agentRepo.create({
        agentId: generateAgentId(),
        workspaceId,
        name: AGENT_NAME,
        modelConfig: { model: ECHO_MODEL },
        systemPrompt: '…',
        memoryConfig: { strategy: 'last_n', maxMessages: 50 },
      });
```

(`agentRepo.create` additionally accepts `tools?: ToolDefinition[]` and `toolRunnerUrl?: string | null` — `packages/db/src/repositories/agent-repo.ts:8-17` — which the local agent uses and the smoke agent does not.)

**The provider chunk contract the fixture must honour** (`packages/models/src/types.ts:72-95`):

```typescript
export const ToolCallChunkSchema = z.object({
  type: z.literal('tool_call'),
  toolName: z.string().min(1),
  callId: z.string().min(1),
  arguments: z.unknown(),
}).strict();
// ModelStreamChunk = token | tool_call | finish; order: token* → tool_call* → exactly one finish
```

**Turn indexing for the two-turn script** (`test/support/fake-provider.ts:159-164` — the pattern, reimplemented production-shaped in the fixture):

```typescript
export function byTurn(...turns: ScriptedTurn[]): FakeResponder {
  return (request: ModelRequest): ScriptedTurn => {
    const idx = request.messages.filter((m) => m.role === 'tool').length;
    return turns[Math.min(idx, turns.length - 1)] ?? { finishReason: 'stop' };
  };
}
```

**The runner server the local runner service starts** (`packages/sdk/src/tool-runner.ts:114`):

```typescript
export async function startToolRunner(opts: ToolRunnerOptions): Promise<FastifyInstance> {
// opts: { port, registry: ToolRegistry, auth: RunnerAuthConfig, toolTimeoutMs?, ... }
// GET /health (no auth) · POST /tools/:toolName (scoped-token verified)
```

**The tool events the smoke check must assert** (`packages/shared/src/types/events.ts:80-95`):

```typescript
export const ToolCallStartedEventSchema = z.object({
  type: z.literal('tool_call_started'),
  callId: z.string(), runId: z.string(), sessionId: z.string(), toolName: z.string(),
}).strict();
export const ToolCallCompletedEventSchema = z.object({
  type: z.literal('tool_call_completed'),
  callId: z.string(), runId: z.string(), sessionId: z.string(), toolName: z.string(),
  status: ToolCallStatusSchema,
}).strict();
```

**The smoke check's current hard requirement to relax locally** (`test/smoke/realtime-smoke.ts:125-136`):

```typescript
function requireEnv(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.SMOKE_BASE_URL;
  const apiKey = process.env.SMOKE_API_KEY;
  // ... exits 1 when either is missing
```

## Design Notes

- **Discrepancies found between program docs and the tree (spec corrected to match the tree):**
  1. The program doc says compose "publishes port `3001`"; it actually publishes **both** `3000:3000` and `3001:3001`. The defect is the same — 3001 has no listener behind it — but the repair removes a mapping rather than changing one.
  2. `PUBLIC_WEBSOCKET_URL: ws://localhost:3001` is wrong in **two** ways, and the program docs name only the port: the canonical `/v1/stream` **path is also missing**, and `sessions.ts:34` appends only `?token=…` to the configured value. `packages/api/src/server.ts:34-37` documents the correct local shape. The corrected value is `ws://localhost:3000/v1/stream`.
  3. Not named in the program docs at all: a clean-checkout `docker compose up` cannot even **boot** — `loadServerConfig` requires at least one real model-provider key (`config.ts:92-100`) and compose sets none (only the optional `.env` could supply one). WS-43 owns this gap too — "a model configuration the server accepts" is the bootstrap's first listed obligation — via the `LOCAL_FIXTURE_PROVIDER` flag below.
  4. `main.ts:99` and `config.ts:130` citations in the manifest/program doc were **verified accurate** against the tree.
- **The `LOCAL_FIXTURE_PROVIDER` boot flag (chosen over a dummy real-provider key).** Setting a placeholder `OPENAI_API_KEY` in compose would boot the server but register a real OpenAI provider with a garbage key — a confusing foot-gun the startup banner would present as a working provider. Instead: a boot-time env flag read directly from `env` in `loadServerConfig` (exactly the `AUTO_MIGRATE` / `DEPLOY_ENV` pattern — deployment marker, **not** added to `ENV_KEYS`/ConfigSchema, so no shared-package change and no new public surface). Semantics: (a) when `'true'`, the at-least-one-model-key requirement is satisfied even with no real key present; (b) when `'true'` **and** `DEPLOY_ENV` is a cloud env (`dev`/`staging`/`prod`), `loadServerConfig` fails fast with an explicit error — the flag is structurally unreachable in every deployed environment, which is how this workstream honours "bootstrap credentials or fixture must be inert or absent in any non-local deployment": the fixture provider is **absent** unless the flag is set, and the flag refuses to coexist with a cloud `DEPLOY_ENV`. (c) `container.ts` registers `fixture` only under the flag; real keys, when present in `.env`, register alongside as today.
- **The fixture provider lives in `packages/models`, not test support.** The Docker image must contain it (`packages/models/dist` ships in the prod stage), and `packages/models` is a **private** workspace package, so this adds no public surface. Script (fixed, not configurable): **turn 0** (no `tool`-role message in the request): yield one token (e.g. `"Calling local_echo… "`), then exactly one `tool_call` — `toolName: 'local_echo'`, a deterministic `callId` (e.g. `fixture_call_1`), `arguments: { message: 'hello from the local fixture', shout: false }` — then `finish` with `finishReason: 'tool_calls'`-style reason consistent with what the runtime loop expects for a tool round (verify against `packages/runtime/src/loop.ts`'s handling before choosing the literal). **Turn 1+** (≥1 `tool`-role message): stream a short token sequence that references the tool result, then `finish {finishReason: 'stop'}`. Honour `request.signal` (mirror echo's abort checks). Zero external calls, zero cost, fully deterministic — the smoke assertion can rely on exactly one `tool_call_started`/`tool_call_completed` pair per turn.
- **Runner keys: a committed dev-only keypair in `docker-compose.yml`, following the committed `CLIENT_JWT_SECRET: dev-jwt-secret-change-in-production` precedent.** The server reads `RUNNER_TOKEN_PRIVATE_KEY` from env at container start, *before* any bootstrap step can run — so bootstrap-generated keys would require a server restart or an image entrypoint change (rejected: the image is shared with cloud deploys). Generate one EdDSA keypair once at implementation time (`jose.generateKeyPair('EdDSA')`, export as JWK JSON), commit the private JWK into the `swift-agent` service env and the public JWK into the `runner` service env, both under a loud `# DEV ONLY — local compose only; deployed environments provision their own keys (see infra/)` comment. These values sign only short-lived scoped tokens for the local runner on the local network; the leak-risk mitigation is structural: WS-47/WS-49 author their own secrets and never copy compose env (acceptance criterion 9 pins this).
- **The dev API key is generated, not committed.** The risk register calls a *known* dev API key reachable anywhere a live vulnerability, so unlike the runner keypair (useless without the local DB) the API key is minted fresh by the bootstrap: `ak_local_` + 32+ hex chars of `crypto.randomBytes`, hash stored via `apiKeyRepo` (sha256 hex — must match `packages/api` auth middleware hashing, same as `provision-smoke.ts`), raw value **surfaced twice**: printed once in the bootstrap service's log output (clearly framed, greppable) and written to `./.swiftagent-local/dev-api-key` via the bind mount. `.swiftagent-local/` is gitignored. Idempotency: if a key file already exists AND its hash matches a stored key, reuse; otherwise mint and write.
- **Workspace-id handoff to the runner.** `startToolRunner`'s auth verifies the token's workspace claim, so the runner needs the bootstrap-created workspace's `ws_` id. The bootstrap writes it to `./.swiftagent-local/runner-env.json` (alongside the key); the `runner` service starts only after `bootstrap` completes (`service_completed_successfully`) and reads the file at startup. (A fixed deterministic workspace id is an acceptable simplification — the repos accept caller-supplied ids — but the file handoff is recommended since the mount already exists for the key.)
- **The local agent.** Name `local-dev` (distinct from `smoke-echo`), `modelConfig: { model: 'fixture/tool-call' }`, `tools: [ { name: 'local_echo', description: …, inputSchema: { type: 'object', … } } ]` (JSON-Schema wire form, as persisted — see `runtime-harness.ts`'s `seededTool`), `toolRunnerUrl: 'http://runner:8090'`. `RUNNER_REQUIRE_HTTPS: 'false'` on the server service is **load-bearing**: without it the outbound policy defaults to HTTPS-only and rejects the compose-network `http://` target.
- **Why the runner service runs from the Dockerfile's `builder` target.** The prod image is `--prod`-pruned and does not contain `@swiftagent/sdk` (see the Dockerfile's copied-package list and the project memory on undeclared workspace deps). The `builder` stage has the full workspace source and dev deps including `tsx`, so `pnpm exec tsx test/smoke/local-runner.ts` runs there without publishing or altering the Dockerfile. `test/smoke` is in this workstream's package roster; `@swiftagent/sdk` and `zod` are already root devDependencies, so the import is declared. Validate the runner entry with the existing `pnpm smoke:typecheck` / `pnpm smoke:lint` scripts (the root `test/` tree is outside the configured gate — per project memory — so these scripts are the check).
- **Smoke check evolution, cloud path preserved.** Extend `test/smoke/realtime-smoke.ts` rather than forking a divergent copy (the manifest allows extend-or-replace; extending keeps one flow, per the file's own "keep in lockstep" note). Two additions, both opt-in so the deploy workflows' current invocation (`SMOKE_BASE_URL` + `SMOKE_API_KEY` + `SMOKE_AGENT_NAME=smoke-echo`) behaves byte-for-byte identically: (1) **key-file fallback** — when `SMOKE_API_KEY` is unset, read `SMOKE_API_KEY_FILE` (path, defaulting under `smoke:local` to `./.swiftagent-local/dev-api-key`); only if neither yields a key does `requireEnv` exit. (2) **`REQUIRE_TOOLS=1` mode** — after `message_started`, additionally await `tool_call_started` then `tool_call_completed` (validating both against `ChatEventSchema` and asserting matching `callId`s and a success status) before awaiting `message_completed`. The root `smoke:local` script wires the local defaults — `SMOKE_BASE_URL=http://localhost:3000`, `SMOKE_AGENT_NAME=local-dev`, `REQUIRE_TOOLS=1`, `SMOKE_API_KEY_FILE=./.swiftagent-local/dev-api-key` — before invoking `tsx test/smoke/realtime-smoke.ts`. POSIX-style inline env prefixes do not work in Windows shells, so set the defaults inside the script itself (a ~10-line `test/smoke/local-smoke-entry.ts` wrapper that assigns `process.env` fallbacks then imports the smoke module, or equivalent) rather than in the package.json command line.
- **`AUTO_MIGRATE` is verified, not changed.** The mechanism (`config.ts:130`, `main.ts:31-43`, migrations folder `packages/db/drizzle` — present in the prod image per the Dockerfile) stays exactly as is. The bootstrap depends on the server's healthcheck rather than running migrations itself, so the migration path exercised is precisely the one the include names. A fresh-volume `docker compose up` must show `Running database migrations… Migrations complete.` before `/health` goes green.
- **What stays out (restating every manifest exclude as a hard boundary):** do **not** remove or deprecate the `GATEWAY_PORT` env key or touch the standalone-gateway entry point (compose merely stops setting the var); do **not** change the `AUTO_MIGRATE` mechanism; **no** change under `infra/` or to the AWS deploy workflows (`deploy-dev/staging/prod.yml`, `ci.yml`); the bootstrap credentials and fixture must be **inert or absent in every non-local deployment** — the flag-gated fixture, cloud-env hard error, generated (not committed) API key, and dev-labeled runner keypair are this spec's mechanisms for that; **no new public runtime or SDK surface** — provisioning uses existing repositories, migrations, and configuration only (the boot flag is private `apps/server` configuration); the scaffold-generated compose file is **WS-46's** and the managed-host deploy config is **WS-47's** — both consume this wiring, so keep it consumable (documented env names, documented topology) but do not author either artifact here. Genuine server defects discovered during the repair are **reported, not silently absorbed** (risk register: "compose repair reveals deeper env-wiring breakage").

## Implementation Steps

1. **Compose repair (SC-02).** In `docker-compose.yml`: drop the `3001:3001` mapping and the `GATEWAY_PORT` env line; set `PUBLIC_WEBSOCKET_URL: ws://localhost:3000/v1/stream`. Sanity-boot (`docker compose up postgres redis swift-agent` with a temporary real key or after step 2) and confirm the banner shows one port.
2. **Boot flag (`apps/server/src/config.ts` + `container.ts`).** Implement `LOCAL_FIXTURE_PROVIDER` per Design Notes: env-read like `AUTO_MIGRATE`; satisfies the model-key requirement; hard error alongside a cloud `DEPLOY_ENV` (fold into the same fail-fast `missing` aggregation so it reports with other config errors). In `container.ts`, register `createToolFixtureProvider` under provider id `fixture` only when the flag is set, with a doc comment mirroring the echo block and naming the cloud-env guard. Surface the flag in `redactConfig`'s banner output as a plain boolean.
3. **Fixture provider (`packages/models/src/providers/tool-fixture.ts`).** Implement per Design Notes (two-turn script keyed on `tool`-role message count; ordering contract `token* → tool_call* → finish`; abort checks). **Before choosing the `finishReason` literal for the tool-call turn, read `packages/runtime/src/loop.ts`** to confirm what the loop keys the next round on (tool_call chunks vs. finishReason), and match the real providers' behaviour. Export from the barrel; grep all reference categories (direct, type, string-literal `'fixture'`, re-exports, tests).
4. **Local bootstrap (`packages/db/src/provision-local.ts`).** Modeled on `provision-smoke.ts`, idempotent throughout: (a) find-or-create workspace `Local Dev Workspace`; (b) dev API key — reuse when the mounted key file's hash matches a stored key, else mint `ak_local_…` from `crypto.randomBytes`, store sha256 hash via `apiKeyRepo.create`, write raw to `/bootstrap-out/dev-api-key` (mode-restricted) and print it once, clearly framed, in the log; (c) find-or-create agent `local-dev` with `modelConfig {model: 'fixture/tool-call'}`, one `local_echo` tool (JSON-Schema wire form), `toolRunnerUrl: 'http://runner:8090'`; (d) write `/bootstrap-out/runner-env.json` (`{ workspaceId }`); (e) exit 0 only when all steps converged. Required env: `DATABASE_URL`. No `SMOKE_API_KEY` involvement anywhere.
5. **Local runner (`test/smoke/local-runner.ts`).** Read the public key from env and the workspace id from `/bootstrap-out/runner-env.json`; build a `ToolRegistry` with one `local_echo` tool (deterministic result, e.g. echo the message back uppercased when `shout`); `startToolRunner({ port: 8090, registry, auth: { publicKey, workspaceId, audience: 'http://runner:8090' } })` — match the exact `RunnerAuthConfig` field names in `packages/sdk/src/types.ts`, and keep the audience identical to the agent's `toolRunnerUrl` (the mint binds `aud` to it, `container.ts:199-204`). Log a single ready line.
6. **Compose topology.** Add the `bootstrap` and `runner` services and the `./.swiftagent-local` bind mounts per Files Touched; add the dev runner keypair env values with their DEV-ONLY comments; add `LOCAL_FIXTURE_PROVIDER: 'true'` and `RUNNER_REQUIRE_HTTPS: 'false'` to `swift-agent`. Add `.swiftagent-local/` to `.gitignore`.
7. **Smoke extension (`test/smoke/realtime-smoke.ts`).** Implement the key-file fallback and `REQUIRE_TOOLS` mode per Design Notes, updating the file's header comment to document both paths (cloud unchanged; local self-provisioned). Keep every existing bound/timeout/diagnostic mechanism; extend `printDiagnostics` so a missing tool event failure shows the frames received. Add the root `smoke:local` script. Run `pnpm smoke:typecheck` and `pnpm smoke:lint`.
8. **End-to-end proof (SC-01).** From a clean state (`docker compose down -v`, delete `./.swiftagent-local`): `docker compose up -d --build`, wait for `bootstrap` to exit 0 and `runner` to be ready, then `pnpm smoke:local` with **no** `SMOKE_API_KEY` in the environment. It must pass, asserting `message_started → tool_call_started → tool_call_completed(succeeded) → message_completed` (plus tokens). Repeat `docker compose up` a second time **without** `-v` to prove bootstrap idempotency (no duplicate rows, same key still works). Record both transcripts in the PR.
9. **AUTO_MIGRATE verification.** In the clean-state run of step 8, capture the server log lines proving migrations ran via the existing flag before `/health` went green.
10. **Docs.** README: update the Self-hosting rung row for `docker compose up` and add/extend a "Run locally" subsection — the exact command sequence (`docker compose up`, then `pnpm smoke:local` as the optional proof), where the dev API key appears (`./.swiftagent-local/dev-api-key` and the `bootstrap` service log), and how to use that key with the quickstart backend (`SWIFT_AGENT_API_KEY`). `docs/quickstart.md`: add the local-stack path as the zero-external-key way to run the example against `http://localhost:3000`, cross-linking README. Do not touch the GitHub-Packages install wording (WS-44's surface).
11. **Gate + scope check.** `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` all green (WS-51's stabilized gate); `git status` confirms no change under `infra/` or `.github/`.

## Tests

> Unit tests run in the configured gate. The end-to-end compose proof (Implementation Step 8) is the SC-01 evidence and is run manually/recorded — Docker-in-CI wiring is not required by this workstream (WS-50 later adds CI compose pulls).

**`packages/models/src/__tests__/tool-fixture.test.ts` (NEW):**

1. **Turn-0 shape.** A request with no `tool`-role message yields, in order: ≥1 `token`, exactly one `tool_call` with `toolName: 'local_echo'`, a non-empty deterministic `callId`, object `arguments`, then exactly one `finish` — and every chunk parses under `ModelStreamChunkSchema` (SC-01).
2. **Turn-1 shape.** A request containing a `tool`-role message yields tokens then a single `finish {finishReason: 'stop'}` and **no** `tool_call` (SC-01).
3. **Determinism.** Two identical requests produce chunk-for-chunk identical output (same `callId`, same arguments).
4. **Abort.** A pre-aborted / mid-stream-aborted `request.signal` throws rather than continuing (mirror the echo provider's tests if present, else the echo behaviour).

**`apps/server/src/__tests__/config.test.ts` (MODIFY — extend existing suite):**

5. **Flag satisfies the model-key requirement.** `loadServerConfig` with `LOCAL_FIXTURE_PROVIDER='true'`, no provider keys, valid DB/JWT env → succeeds.
6. **Without the flag the requirement stands.** Same env minus the flag → throws listing `At least one of: …` (existing behaviour preserved).
7. **Cloud refusal.** `LOCAL_FIXTURE_PROVIDER='true'` + `DEPLOY_ENV='prod'` (and `'dev'`) → throws with a message naming the flag; the error aggregates with other missing-var messages.

**`apps/server/src/__tests__/container.test.ts` (MODIFY — extend existing suite):**

8. **Gated registration.** With the flag set, `modelRegistry.resolveForModel('fixture/tool-call')` resolves; without it, it throws/fails to resolve. Echo remains registered in both cases; `registeredProviders` handling matches the doc-commented choice.

**`test/smoke` (validated via `pnpm smoke:typecheck` + `pnpm smoke:lint`, exercised by the compose proof):**

9. **Key-file fallback.** With `SMOKE_API_KEY` unset and `SMOKE_API_KEY_FILE` pointing at a file, the smoke uses the file's contents; with neither, it exits 1 naming both options (manual check acceptable, or a small unit if the file is refactored to export testable pieces — do not destabilize the cloud path to make it unit-testable).
10. **`REQUIRE_TOOLS` assertion order (compose proof).** The recorded `pnpm smoke:local` transcript shows both tool events validated, `callId` matching between started/completed, and a success status — this is the SC-01 acceptance evidence.

**End-to-end protocol (Implementation Step 8, recorded in the PR):**

11. Clean-state `docker compose up` → bootstrap exit 0 → `pnpm smoke:local` PASS with no pre-supplied `SMOKE_API_KEY` and no manually seeded agent (SC-01).
12. Second `docker compose up` over the same volume → idempotent (no duplicates; same key file still authenticates) (SC-01).
13. Migration log lines present from the `AUTO_MIGRATE` path on the fresh-volume run (SC-01).

## Acceptance Criteria

1. `docker-compose.yml` publishes only port 3000 for the server and sets `PUBLIC_WEBSOCKET_URL: ws://localhost:3000/v1/stream`; no port or `PUBLIC_WEBSOCKET_URL` value contradicts the single listener at `apps/server/src/main.ts:99`, and the value includes the canonical `/v1/stream` path that `sessions.ts` prefixes verbatim (SC-02).
2. The `GATEWAY_PORT` env **key** remains defined in `@swiftagent/shared` `ENV_KEYS` and the standalone-gateway entry point is untouched; compose simply no longer sets the variable or maps the port (SC-02; scope excludes).
3. From a clean checkout with no `.env` and no exported secrets, `docker compose up` boots Postgres, Redis, and the server (the `LOCAL_FIXTURE_PROVIDER` flag satisfying the provider-key requirement), migrates via the **unchanged** `AUTO_MIGRATE` mechanism (`config.ts:130`), and serves REST + WebSocket on one port (SC-01).
4. The bootstrap self-provisions, idempotently and with no manual seeding: a server-accepted model configuration (`fixture/tool-call`), a workspace, a raw dev API key whose stored sha256 hash matches — surfaced to the developer in the bootstrap log **and** at `./.swiftagent-local/dev-api-key` (gitignored) — and a `local-dev` agent carrying the `local_echo` tool with a `toolRunnerUrl` (SC-01).
5. Runner signing/verification keys are wired (dev-only committed keypair, loudly labeled, following the compose `CLIENT_JWT_SECRET` precedent) and a runner service on the compose network is reachable by the server, verifying scoped tokens minted with the private key against the bootstrap workspace (SC-01).
6. The tool-calling model fixture in `packages/models` is deterministic, zero-cost, makes no external call, honours the `token* → tool_call* → finish` chunk contract and `request.signal`, and is registered **only** when `LOCAL_FIXTURE_PROVIDER` is set (SC-01).
7. The smoke check, run as `pnpm smoke:local` against the compose stack with **no pre-supplied `SMOKE_API_KEY`** (key read from the bootstrap-written file) and **no pre-seeded `smoke-echo` agent**, passes while asserting **both** `tool_call_started` and `tool_call_completed` (matching `callId`, success status), in addition to `message_started`/token/`message_completed` — evidenced by a recorded clean-state run (SC-01).
8. The cloud smoke path is byte-for-byte compatible: `pnpm smoke:realtime` with `SMOKE_BASE_URL`/`SMOKE_API_KEY`/`SMOKE_AGENT_NAME=smoke-echo` behaves exactly as before, `packages/db/src/provision-smoke.ts` is unmodified, and no file under `.github/workflows/` or `infra/` changed (scope excludes).
9. Nothing bootstrap-created can reach a non-local deployment: the fixture provider is absent without the flag, `loadServerConfig` hard-fails when the flag meets a cloud `DEPLOY_ENV`, the dev API key is generated per checkout (never committed), and the dev runner keypair values exist only in `docker-compose.yml` (with DEV-ONLY comments) — none of them referenced by any deploy surface (SC-01; scope excludes; risk register "bootstrap credentials leak").
10. No new public runtime or SDK surface was added: provisioning uses existing `createXxxRepo` repositories, existing migrations, and existing `ENV_KEYS`; the only configuration addition is the private `apps/server` boot flag, read like `AUTO_MIGRATE` (scope excludes).
11. `README.md` and `docs/quickstart.md` document the one-command local path — `docker compose up`, the optional `pnpm smoke:local` proof, and exactly where the generated dev API key appears — without touching the registry-install wording owned by WS-44 (SC-01).
12. `pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm test` are all green at checkpoint, and `pnpm smoke:typecheck` + `pnpm smoke:lint` pass for the touched smoke tree (program-wide checkpoint rule; WS-51 dependency).
