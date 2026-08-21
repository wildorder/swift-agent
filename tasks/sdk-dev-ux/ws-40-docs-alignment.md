# WS-40: Documentation Alignment with Actual APIs

## Goal

Reconcile every developer-facing document with the **actual shipped SDK surface** and create the missing READMEs, so that a developer reading the docs sees code that compiles and runs against the finalized packages. Today the "quickstart" lives only inside two mirror files (`docs/vision.md` and `swift-agent.md`) whose Developer-Experience examples and API-surface tables have drifted from the code: they show a **raw JSON-Schema** `inputSchema` where `tool()` actually takes a **Zod** schema; they omit the richer fluent surface that `packages/sdk/src/app.ts` actually ships (`app.runs.get`, `app.runs.cancel`, `app.sessions.get`, `app.sessions.messages.list`, `app.close()`); they imply `app.listen()` is zero-config when it in fact **requires runner-token verification config**; and their `ToolContext` / `sessions.create` shapes lag the real types. There are **no README files anywhere** in the repo (no root README, no per-package READMEs). This workstream (a) creates per-package READMEs for `@swiftagent/sdk`, `@swiftagent/react`, `@swiftagent/shared` and a root `README.md`; (b) fixes the four discrepancies in the two mirror docs and keeps them consistent; (c) establishes a single canonical quickstart doc surface pointing at the WS-39 example; and (d) runs a CLAUDE.md-rule-10 grep sweep to purge every stale form. Snippets are **sourced from the maintained example** (`examples/quickstart/`, WS-39) so docs and example stay in lockstep. This WS edits docs/READMEs only — it does **NOT** change SDK code. If a doc reveals a genuine code bug, flag it in the PR description; do not fix it here.

## Traceability

- **SC-06:** The quickstart, per-package READMEs, and the vision's API-surface tables match the shipped APIs, with example-sourced snippets.
- **SC-10:** Monorepo type-checking, linting, unit tests, and integration tests pass. There is no docs test harness, so "pass" here means the doc changes do not break any repo-referenced check — the existing `pnpm typecheck` / `pnpm lint` / `pnpm test` stay green (docs are markdown; the risk is only in doc-referenced code paths, which this WS does not touch).

## Dependencies

- **WS-36 — SDK API Finalization & Surface Lockdown** — the source of truth for what docs describe. The finalized public surface (fluent `app.sessions.*` / `app.runs.*`, locked `exports` maps, the audited `@swiftagent/react` export set) is what the READMEs and API-surface tables must reflect. Do not document any symbol that is not exported from a package root after WS-36.
- **WS-39 — Maintained Example Application** — the example app under `examples/quickstart/` is the canonical, CI-green source for every snippet. READMEs copy/derive minimal snippets from `examples/quickstart/{backend/src/server.ts, frontend/src/App.tsx, README.md}`; the quickstart doc walks through that example.

> If WS-39 has not landed `examples/quickstart/` when this WS starts, still author the READMEs against the verified code interfaces below, but **point** the quickstart link at `examples/quickstart/` (the agreed WS-39 path) and keep snippets minimal and hand-verified against the code — do not invent example files. Note the ordering assumption in the PR.

## Context Files (Agent MUST read before implementing)

- `CLAUDE.md` — mechanical overrides. Especially: **rule 4** (forced verification — run `pnpm typecheck` / `pnpm lint` / `pnpm test`, fix all errors before claiming done), **rule 9** (re-read every file immediately before editing; the Edit tool fails silently on stale context), and **rule 10** (no semantic search — grep each reference form separately).
- `packages/sdk/src/index.ts` — the SDK public barrel: exactly what `@swiftagent/sdk` exports (`createAgentApp`, `defineAgent`, `tool`, `toolToJsonSchema`, `ControlPlaneClient`, `startToolRunner`, and the type-only exports). Documented surface must not exceed this.
- `packages/sdk/src/app.ts` — the real `AgentApp` interface and `createAgentApp` implementation, including the full fluent surface and the runner-token verification requirement in `.listen()`.
- `packages/sdk/src/tool.ts` — the real `tool()` (Zod `inputSchema`) and `toolToJsonSchema()` helper (Zod → JSON Schema for the wire form).
- `packages/sdk/src/agent.ts` — `defineAgent()` and how it maps `SdkAgentConfig` → `AgentDefinition`.
- `packages/sdk/src/types.ts` — `ToolDefinition`, `ToolContext`, `SdkAgentConfig`, `CreateSessionOptions`/`Result`, `CreateRunOptions`, `AcceptedRun`, `CreateAgentAppConfig`, and the runner-verification config fields.
- `packages/react/src/index.ts` — the React public barrel (`useAgentChat`, `useConnection`, `createChatSession`, state helpers, and the exported public types).
- `packages/react/src/hooks/use-agent-chat.ts` — the real `useAgentChat` signature and return shape.
- `packages/react/src/types.ts` — `UseAgentChatArgs`, `UseAgentChatResult`, `CreateChatSessionOptions`, `ChatSessionClient`, `ConnectionStatus`, `ChatMessage`.
- `packages/react/src/client.ts` — `createChatSession` and the canonical `websocketUrl` handling (the source of the "there is no hardcoded default; a missing `websocketUrl` throws" behavior).
- `packages/shared/src/index.ts` — the `@swiftagent/shared` public surface (ID prefixes, `ChatEvent` union + schemas, `ENV_KEYS`, runner protocol constants, record types).
- `docs/vision.md` (Developer Experience ≈ lines 143–216; API Surface ≈ lines 218–268; Key Types ≈ lines 242–268) — one of the two mirror files to fix.
- `swift-agent.md` (the SAME example block, ≈ lines 144–272) — the mirror; must stay identical in the aligned sections.
- `docs/as-built.md` and `docs/snapshots/*.md` — **read-only** canonical phrasing (e.g. `GET /v1/stream?token=<client-jwt>`, `provider/model-id`, two auth layers). Match their wording; do not edit them.
- `tasks/realtime-cloud-delivery/ws-34-client-docs-alignment.md` — the reference spec for structure/density and, specifically, its "Docs alignment scope" and grep-sweep step (steps 8–9) — this WS extends that same sweep to `inputSchema` and README surfaces.
- `docs/programs/sdk-dev-ux-program.md` — program context (SC-06 / SC-10, WS-36/WS-39 dependencies, GitHub Packages as the private registry).
- `examples/quickstart/README.md`, `examples/quickstart/backend/src/server.ts`, `examples/quickstart/frontend/src/App.tsx` (WS-39) — the snippet source of truth (read whatever exists; if absent, see the Dependencies note).

## Package

- `docs/` — the two mirror docs (`docs/vision.md`, `swift-agent.md`) and a new canonical quickstart pointer (`docs/quickstart.md`).
- Per-package READMEs — `packages/sdk/README.md`, `packages/react/README.md`, `packages/shared/README.md` (all **NEW**).
- Repo root — `README.md` (**NEW**): project overview + quickstart pointer.

No `packages/**/*.ts` source is modified. `docs/programs/**`, `docs/snapshots/**`, and `docs/as-built.md` are **read-only** here.

## Files Touched

- `README.md` **(NEW)** — root project overview: one-paragraph product summary (from `swift-agent.md`), the package list (`@swiftagent/sdk`, `@swiftagent/react`, `@swiftagent/shared`), a "Quickstart" section that links to `docs/quickstart.md` and `examples/quickstart/`, and repo dev commands (`pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test`). High-level; do not duplicate full code blocks — link to the quickstart.
- `docs/quickstart.md` **(NEW)** — the single canonical quickstart doc. Short prose walking through the WS-39 example: install (GitHub Packages, high-level per Design Notes), define an agent with a Zod-schema tool, `createAgentApp` + runner-token config, `app.listen()`, create a session, wire `useAgentChat` with `websocketUrl`. Every code block is copied/derived from `examples/quickstart/` and links to the exact file. Ends with "Run it" pointing at `examples/quickstart/README.md`.
- `packages/sdk/README.md` **(NEW)** — `@swiftagent/sdk` README: install line (GitHub Packages), a minimal usage snippet (Zod `tool`, `defineAgent`, fluent `createAgentApp` + `app.agent` + `app.listen` with the runner-token config note), the finalized public API surface table (matching `packages/sdk/src/index.ts` + `app.ts`), and a pointer to `examples/quickstart/` and `docs/quickstart.md`.
- `packages/react/README.md` **(NEW)** — `@swiftagent/react` README: install line, a minimal `useAgentChat({ sessionId, token, websocketUrl })` snippet, a note that `websocketUrl` is the canonical `wss://<host>/v1/stream?token=<jwt>` from `POST /v1/sessions` (no hardcoded default), the public surface (`useAgentChat`, `useConnection`, `createChatSession` + public types), and a pointer to the example.
- `packages/shared/README.md` **(NEW)** — `@swiftagent/shared` README: what it is (the shared source-of-truth package: Zod schemas, `ChatEvent` union, `ENV_KEYS`, ID prefixes, runner protocol constants), that it is a transitive dependency of the SDKs (installed automatically), and the top-level exports. Keep it concise — it is a support package, not a primary DX entry point.
- `docs/vision.md` **(MODIFY)** — fix discrepancies (1)–(4) in the Developer Experience examples, the API-surface tables, and the Key Types block; add a one-line pointer to `docs/quickstart.md` / `examples/quickstart/`. Do not restructure surrounding sections.
- `swift-agent.md` **(MODIFY)** — the identical fixes in the mirror block; keep it byte-consistent with `docs/vision.md` in the aligned sections.

## Existing Interfaces to Consume

These are the REAL, verified interfaces (read 2026-07-20). Every doc snippet MUST match these — not the current (wrong) doc text.

### `tool()` — Zod `inputSchema` (`packages/sdk/src/tool.ts`, `packages/sdk/src/types.ts`)

```ts
// ToolDefinition (packages/sdk/src/types.ts)
export interface ToolDefinition<TInput = any, TResult = any> {
  name: string;
  description: string;
  inputSchema: ZodType<TInput>;            // ← Zod schema, NOT a raw JSON-Schema object
  execute: (input: TInput, ctx: ToolContext) => Promise<TResult>;
}

// tool() (packages/sdk/src/tool.ts) — validates that inputSchema is a Zod schema
export function tool<TInput, TResult>(
  config: ToolDefinition<TInput, TResult>,
): ToolDefinition<TInput, TResult>;

// toolToJsonSchema() — converts the Zod inputSchema to the JSON-Schema wire form
export function toolToJsonSchema(def: ToolDefinition): ToolSchema; // { name, description, parameters }
```

**Canonical doc snippet** (use Zod; import `z`):

```ts
import { z } from 'zod';
import { tool } from '@swiftagent/sdk';

const lookupOrder = tool({
  name: 'lookupOrder',
  description: 'Look up an order by ID',
  inputSchema: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => db.orders.findById(orderId),
});
```

### `ToolContext` (`packages/sdk/src/types.ts`)

The real context carries WS-22 invocation identity — the vision's `ToolContext` (only `sessionId`, `userId`, `metadata`) is stale:

```ts
export interface ToolContext {
  sessionId: string;
  agentId: string;   // resolved agent id (matches signed token claim)
  runId: string;     // invocation scope
  callId: string;    // tc_ call id — invocation identity + idempotency key
  userId?: string;
  metadata?: Record<string, unknown>;
}
```

### `AgentApp` fluent surface (`packages/sdk/src/app.ts`)

```ts
export interface AgentApp {
  agent(definition: AgentDefinition): AgentApp;
  sessions: {
    create(opts: CreateSessionOptions): Promise<CreateSessionResult>;
    get(id: string): Promise<SessionRecord>;
    messages: {
      list(sessionId: string, opts?: ListMessagesOptions): Promise<ListMessagesResult>;
    };
  };
  runs: {
    create(opts: CreateRunOptions): Promise<AcceptedRun>;   // 202 accepted, poll get()
    get(runId: string): Promise<RunRecord>;
    cancel(runId: string): Promise<AcceptedRun>;            // idempotent
  };
  listen(port?: number): Promise<void>;
  close(): Promise<void>;
}
```

### `createAgentApp` config + `.listen()` runner-token requirement (`packages/sdk/src/app.ts`, `types.ts`)

```ts
export interface CreateAgentAppConfig {
  apiKey: string;              // required — throws "apiKey is required" if missing
  baseUrl?: string;
  runnerPublicKey?: string;    // PEM (SPKI) or JWK JSON — overrides RUNNER_TOKEN_PUBLIC_KEY
  runnerAudience?: string;     // overrides RUNNER_AUDIENCE; defaults to TOOL_RUNNER_PUBLIC_URL
  runnerWorkspaceId?: string;  // ws_ id — overrides RUNNER_WORKSPACE_ID
}
```

`app.listen()` throws unless runner-token verification config is resolvable. It reads (config field → env fallback):
- `runnerPublicKey` → `RUNNER_TOKEN_PUBLIC_KEY` — **required** (`"Runner verification requires RUNNER_TOKEN_PUBLIC_KEY (PEM or JWK)"`).
- `runnerWorkspaceId` → `RUNNER_WORKSPACE_ID` — **required** (`"Runner verification requires RUNNER_WORKSPACE_ID"`).
- `runnerAudience` → `RUNNER_AUDIENCE` → falls back to `TOOL_RUNNER_PUBLIC_URL` (or `http://127.0.0.1:<port>`).

So docs must NOT imply `app.listen()` is zero-config; document that a runner public key and workspace id are required (via env or config).

### `CreateSessionOptions` / `CreateSessionResult` (`packages/sdk/src/types.ts`)

```ts
interface CreateSessionOptions { agentName: string; userId?: string; metadata?: Record<string, unknown>; }
interface CreateSessionResult { sessionId: string; clientToken: string; websocketUrl: string; }
```

Note the field is **`agentName`**, not `agent` — the vision's `sessions.create({ agent: '...' })` is wrong.

### `useAgentChat` (`packages/react/src/hooks/use-agent-chat.ts`, `types.ts`)

```ts
interface UseAgentChatArgs {
  sessionId: string;
  token: string;
  websocketUrl?: string;   // canonical wss://<host>/v1/stream?token=<jwt> from POST /v1/sessions
  reconnect?: ReconnectOptions;
  createWebSocket?: (url: string) => WebSocket;
  onError?: (error: unknown) => void;
}
interface UseAgentChatResult {
  messages: ChatMessage[];
  send: (content: string) => void;
  isStreaming: boolean;
  connectionStatus: ConnectionStatus;
  lastError: string | null;
}
```

`websocketUrl` MUST be threaded through (WS-34): it is the source of truth. There is **no** hardcoded default — `createChatSession` throws `createChatSession requires a websocketUrl (the value returned by POST /v1/sessions)` when it is missing. No `/ws` or `api.swiftagent.dev/ws` form is valid anywhere.

### `createChatSession` (`packages/react/src/client.ts`)

```ts
function createChatSession(opts: CreateChatSessionOptions): ChatSessionClient;
// ChatSessionClient: sendMessage(content), onEvent(handler) => unsub, disconnect(), get connectionStatus
```

### `@swiftagent/shared` public surface (`packages/shared/src/index.ts`)

High-level for the README: `ChatEvent` discriminated union + `ChatEventSchema` and the per-event schemas; `ENV_KEYS` + `loadConfig` + `AppConfig`; ID prefixes (`PREFIX_SESSION` … `ses_`, `msg_`, `run_`, `tc_`, `agt_`, `ws_`, `ak_`, `usr_`, …) and `generate*Id`/`parsePrefix` helpers; record types (`AgentRecord`, `SessionRecord`, `MessageRecord`, `RunRecord`, `WorkspaceRecord`, `ApiKeyRecord`, `UserRecord`, …) with their Zod schemas; runner protocol constants (`RUNNER_PROTOCOL_VERSION`, `RUNNER_MAX_*`, `Runner*Schema`); `createRedisClient`; `SwiftAgentError` / `SwiftAgentErrorCode` / `isSwiftAgentError`.

## Design Notes

### The four discrepancies to fix (verified against code 2026-07-20)

1. **`inputSchema` is Zod, not raw JSON Schema.** The vision/`swift-agent.md` show `inputSchema: { type: 'object', properties: { orderId: { type: 'string' } }, required: [...] }`. The real `tool()` (`packages/sdk/src/tool.ts`) rejects that at runtime (`Tool "inputSchema" must be a Zod schema`) — it requires a Zod schema (`.safeParse` check). Replace every tool example with `inputSchema: z.object({ orderId: z.string() })` and add the `import { z } from 'zod'` line. Mention `toolToJsonSchema()` as the helper that produces the JSON-Schema **wire** form (that's what the API registration payload carries), so a reader who saw JSON Schema on the wire understands the mapping. Also fix the **Key Types** block: `ToolDefinition.inputSchema` is `ZodType<TInput>` (not `object`), and `ToolContext` must include `agentId`, `runId`, `callId` (see interfaces above).

2. **The fluent surface is richer than the vision table.** `packages/sdk/src/app.ts` ships `app.runs.get`, `app.runs.cancel`, `app.sessions.get`, `app.sessions.messages.list`, and `app.close()` — the vision's server-SDK table lists only `create`/`get`/`messages.list`/`runs.create`. Extend the API-surface table (and the SDK README) to reflect exactly what `AgentApp` exports: add `app.sessions.get(id)` (already present — keep), `app.sessions.messages.list(id, opts?)`, `app.runs.get(runId)`, `app.runs.cancel(runId)`, and `app.close()`. Note that `app.runs.create` returns an **accepted** run (202) — poll `app.runs.get` for terminal status; `app.runs.cancel` is idempotent.

3. **`useAgentChat` must thread `websocketUrl`.** WS-34 already corrected the code and the vision's React example to pass `websocketUrl`. Verify (grep) that **no** `/ws`, `/ws"`, `/ws'`, or `api.swiftagent.dev/ws` reference survives in any doc, README, or example, and that every `useAgentChat` / `createChatSession` doc snippet threads `websocketUrl`. State the "no hardcoded default; missing `websocketUrl` throws" behavior in the React README.

4. **`app.listen()` is not zero-config.** The vision shows a bare `app.listen();`. The real `.listen()` requires runner-token verification config (`RUNNER_TOKEN_PUBLIC_KEY`, `RUNNER_WORKSPACE_ID`, optional `RUNNER_AUDIENCE`/`TOOL_RUNNER_PUBLIC_URL`) via env or `createAgentApp` config, else it throws. Docs (quickstart + SDK README) must mention this — e.g. "`app.listen()` starts the tool runner and requires runner-token verification config (`RUNNER_TOKEN_PUBLIC_KEY`, `RUNNER_WORKSPACE_ID`) via env vars or `createAgentApp({ runnerPublicKey, runnerWorkspaceId })`." Do not silently keep the bare `app.listen();` without this note.

### Additional real drifts found (fix while aligning; they are doc-only)

- `sessions.create({ agent: '...' })` in the vision uses `agent`; the real `CreateSessionOptions` field is **`agentName`**. Fix the example to `agentName`.
- The vision's create-session example calls `agentClient.sessions.create(...)` against an undefined `agentClient`; in the shipped SDK this is `app.sessions.create(...)`. Align to `app.sessions.create(...)` (the fluent surface on the `createAgentApp` return value).

> **Only align docs.** If any of the above turns out to reflect a genuine code bug (it does not — the code is the source of truth here), flag it in the PR; do not modify `packages/**/*.ts` in this WS.

### Quickstart-doc placement decision

**Decision: create a single top-level `docs/quickstart.md` that references `examples/quickstart/`, and link it from both mirror docs and the root README.** Rationale: (a) the program (SC-06, WS-39) wants a canonical quickstart whose snippets are sourced from the example, and a doc file can walk through the example with prose + links while the example stays runnable; (b) a `docs/quickstart.md` gives a stable, linkable URL for the vision and READMEs without duplicating the full runnable app; (c) `examples/quickstart/README.md` (owned by WS-39) remains the "how to actually run it" entry — `docs/quickstart.md` links to it rather than duplicating run instructions. So: `docs/quickstart.md` = narrative walk-through with example-sourced snippets; `examples/quickstart/README.md` = runnable entry. Avoid two competing narratives — keep `docs/quickstart.md` thin and defer "run it" to the example README.

### GitHub Packages install wording (coordinate with WS-38; keep high-level)

The `@swiftagent` scope publishes to **GitHub Packages** (`npm.pkg.github.com`), the org's private registry (WS-38). READMEs must state install at a high level without pinning WS-38's exact `.npmrc`/token mechanics (that is WS-38's doc surface). Use wording like:

> Install from GitHub Packages (the `@swiftagent` scope's private registry). Configure your `.npmrc` to point `@swiftagent:registry=https://npm.pkg.github.com` with a `read:packages` token, then:
> ```
> pnpm add @swiftagent/sdk
> ```

`@swiftagent/shared` is a transitive dependency of both SDKs — its README notes it is installed automatically with the SDKs and rarely added directly. Do not document a public-npm install (public registry is a later flip, out of scope).

### Do-not-touch

- `docs/as-built.md`, `docs/snapshots/**`, `docs/programs/**` — read-only for canonical phrasing. Do not edit.
- No `packages/**/*.ts` source edits. This is a docs/README-only WS.
- Keep `docs/vision.md` and `swift-agent.md` **consistent** in the aligned sections (they carry the identical block) — apply the same edit to both.

## Implementation Steps

Ordered. Per CLAUDE.md rule 9, re-read each target file immediately before editing it.

1. **Confirm the baseline.** Glob `**/README*` (excluding `node_modules`) to confirm no project README exists, and glob `examples/quickstart/**` to see what WS-39 has landed. Read the WS-39 example files if present; if absent, note the ordering assumption (Dependencies note) and proceed against verified code interfaces. Re-read `packages/sdk/src/{index,app,tool,agent,types}.ts`, `packages/react/src/{index.ts,hooks/use-agent-chat.ts,types.ts,client.ts}`, and `packages/shared/src/index.ts` to confirm the interfaces in this spec still match (do not trust memory — code is source of truth).

2. **Write `packages/shared/README.md`** (NEW) — concise support-package README: purpose (shared Zod schemas, `ChatEvent` union, `ENV_KEYS`, ID prefixes, runner protocol constants), "installed transitively with the SDKs" note, and the top-level export groups from `packages/shared/src/index.ts`. No large code blocks.

3. **Write `packages/sdk/README.md`** (NEW) — install (GitHub Packages wording), minimal usage snippet sourced from `examples/quickstart/backend/src/server.ts` (Zod `tool`, `defineAgent`, `createAgentApp`, `app.agent`, `app.listen` **with** the runner-token config note), the full public API-surface table matching `packages/sdk/src/index.ts` + the `AgentApp` interface (all of `agent`, `sessions.create/get`, `sessions.messages.list`, `runs.create/get/cancel`, `listen`, `close`), and links to `docs/quickstart.md` + `examples/quickstart/`.

4. **Write `packages/react/README.md`** (NEW) — install, minimal `useAgentChat({ sessionId, token, websocketUrl })` snippet sourced from `examples/quickstart/frontend/src/App.tsx`, the "canonical `websocketUrl` / no default / throws when missing" note, the public surface (`useAgentChat`, `useConnection`, `createChatSession` + public types), and a link to the example.

5. **Write `docs/quickstart.md`** (NEW) — narrative walk-through per the placement decision: install, define agent + Zod tool, `createAgentApp` + runner-token config, `app.listen()`, `app.sessions.create({ agentName })`, wire `useAgentChat` with `websocketUrl`; every snippet copied/derived from `examples/quickstart/` with a link to the exact file; end with "Run it →" linking `examples/quickstart/README.md`.

6. **Write root `README.md`** (NEW) — product overview paragraph, package list, "Quickstart" section linking `docs/quickstart.md` and `examples/quickstart/`, and dev commands (`pnpm install` / `typecheck` / `lint` / `test`). No full code blocks — link out.

7. **Fix `docs/vision.md`** (MODIFY) — apply discrepancies (1)–(4) plus the `agentName` / `app.sessions.create` drifts: rewrite the `tool()` example to Zod + `import { z }`; fix the create-session example to `app.sessions.create({ agentName: 'support-assistant', ... })`; add the runner-token note to the `app.listen()` example; extend the server-SDK API-surface table with `app.sessions.get`, `app.sessions.messages.list`, `app.runs.get`, `app.runs.cancel`, `app.close`; fix the **Key Types** block (`inputSchema: ZodType<TInput>`, `ToolContext` with `agentId`/`runId`/`callId`); add a one-line pointer to `docs/quickstart.md`.

8. **Fix `swift-agent.md`** (MODIFY) — apply the identical edits to the mirror block so the two files stay consistent in the aligned sections. Diff the two aligned blocks to confirm they match.

9. **Grep sweep (CLAUDE.md rule 10 — search each form separately).** Across `docs/`, root `*.md`, all `README*` (excluding `node_modules`), and `examples/**/*.{ts,tsx,md}`, search separately for each stale form and fix every **doc/README/example-doc** hit (leave `packages/**/*.ts` source untouched — flag, don't fix):
   - `/ws"` , `/ws'` , `` `/ws `` (backtick-quoted path)
   - `api.swiftagent.dev/ws`
   - JSON-Schema tool `inputSchema`: search `inputSchema:` and inspect each hit; any `type: 'object'` / `properties:` / `required:` form in a `tool(...)` example is stale → convert to Zod.
   - `sessions.create({ agent:` / `agent: '` in a session-create example → `agentName`.
   - `app.listen()` occurrences → ensure each is accompanied by the runner-token note (or a link to it).
   - `useAgentChat(` / `createChatSession(` occurrences → confirm each threads `websocketUrl`.
   Also confirm at least one canonical `/v1/stream` reference remains in the aligned examples/docs. If any grep returns suspiciously few results, re-run narrowed (CLAUDE.md rule 8 — suspected truncation).

10. **Verify.** From the repo root run `pnpm typecheck`, `pnpm lint`, and `pnpm test` (and, if Docker is available, `pnpm test:integration`). Docs are markdown so these should be unaffected, but per CLAUDE.md rule 4 you must run them and confirm green (the pre-existing `@swiftagent/server` / `@swiftagent/api` failures noted in memory are not caused by this WS — call them out as pre-existing if they appear). Report the exact commands and results in the PR.

11. **PR notes.** State: docs-only change; no `packages/**/*.ts` edited; `as-built`/`snapshots`/`programs` untouched; the two mirror docs kept consistent; and any code bug flagged (none expected) with file/line.

## Tests

There is no docs test harness; these are grep-style assertions (run as documented manual greps in the PR, or as a small Vitest that reads the files with `fs.readFileSync` — either is acceptable). All paths exclude `node_modules`.

1. **No stale WebSocket endpoint form.** `grep -R` across `docs/`, root `*.md`, `README*`, `examples/**` finds **zero** occurrences of `/ws"`, `/ws'`, `` `/ws ``, or `api.swiftagent.dev/ws`. (Legitimate `ws://`, `wss://`, `/v1/stream`, and variable names are allowed and must not be flagged.)

2. **Canonical stream endpoint present.** At least one `/v1/stream` reference exists in the aligned examples (`docs/vision.md`, `swift-agent.md`, and/or `docs/quickstart.md` / `packages/react/README.md`), matching the as-built phrasing.

3. **No JSON-Schema `inputSchema` in tool examples.** Across all docs/READMEs/example docs, every `inputSchema` inside a `tool(...)` example is a Zod form (`z.object(`, `z.string(`, etc.); **no** `inputSchema: {` immediately followed by `type: 'object'` / `properties:` / `required:` remains. Assert each file containing a `tool(` example also contains a `zod` import (`from 'zod'`).

4. **Each README/quickstart threads `websocketUrl`.** Every `useAgentChat(` and `createChatSession(` snippet in `packages/react/README.md`, `docs/quickstart.md`, `docs/vision.md`, and `swift-agent.md` includes a `websocketUrl` argument/prop.

5. **`app.listen()` carries the runner-token note.** Every `app.listen()` occurrence in `docs/quickstart.md`, `packages/sdk/README.md`, `docs/vision.md`, and `swift-agent.md` is within a few lines of a mention of `RUNNER_TOKEN_PUBLIC_KEY` / `RUNNER_WORKSPACE_ID` / "runner-token" (i.e. it is not presented as zero-config).

6. **`agentName` not `agent` in session-create examples.** No `sessions.create({ agent:` (bare `agent` key) remains; every session-create example uses `agentName`.

7. **API-surface table matches the shipped `AgentApp`.** `packages/sdk/README.md` and the `docs/vision.md` server-SDK table list every method of the real `AgentApp` interface — `agent`, `sessions.create`, `sessions.get`, `sessions.messages.list`, `runs.create`, `runs.get`, `runs.cancel`, `listen`, `close` — and no symbol absent from `packages/sdk/src/index.ts` / `app.ts`.

8. **READMEs exist.** `README.md`, `packages/sdk/README.md`, `packages/react/README.md`, `packages/shared/README.md`, and `docs/quickstart.md` all exist and are non-empty.

9. **Mirror consistency.** The aligned Developer-Experience + API-surface blocks in `docs/vision.md` and `swift-agent.md` are equivalent (same code, same tables) — a diff of those sections shows no substantive divergence.

10. **Repo checks green.** `pnpm typecheck`, `pnpm lint`, and `pnpm test` pass (or fail only on the memory-documented pre-existing `@swiftagent/server` / `@swiftagent/api` issues, explicitly identified as unrelated). Commands and results reported.

## Acceptance Criteria

1. **READMEs created.** `README.md` (root), `packages/sdk/README.md`, `packages/react/README.md`, and `packages/shared/README.md` exist, each with a GitHub-Packages install line, a minimal example-sourced snippet, and a pointer to `examples/quickstart/` / `docs/quickstart.md`. The SDK and React snippets use the real APIs (Zod `tool`, fluent `createAgentApp`, `useAgentChat` with `websocketUrl`).
2. **Canonical quickstart doc.** `docs/quickstart.md` exists, walks through the WS-39 example with example-sourced snippets, and is linked from the root README and both mirror docs; it defers "run it" instructions to `examples/quickstart/README.md`.
3. **Discrepancy (1) fixed.** Every tool example in docs/READMEs uses a **Zod** `inputSchema` (with a `zod` import); no raw JSON-Schema `inputSchema` remains; `toolToJsonSchema()` is referenced as the wire-form helper; the Key Types block shows `inputSchema: ZodType<TInput>` and the full `ToolContext` (`agentId`/`runId`/`callId`).
4. **Discrepancy (2) fixed.** The server-SDK API-surface table (vision + SDK README) reflects the full shipped `AgentApp` surface — `sessions.get`, `sessions.messages.list`, `runs.get`, `runs.cancel`, `close` included — and nothing beyond the public exports.
5. **Discrepancy (3) fixed.** Every `useAgentChat` / `createChatSession` snippet threads `websocketUrl`; no `/ws` or `api.swiftagent.dev/ws` form remains anywhere in docs/READMEs/example docs; the React README documents "canonical `websocketUrl`, no default, throws when missing."
6. **Discrepancy (4) fixed.** Every `app.listen()` example is accompanied by the runner-token verification note (`RUNNER_TOKEN_PUBLIC_KEY` / `RUNNER_WORKSPACE_ID` via env or `createAgentApp` config); no doc implies zero-config `listen()`.
7. **Additional drifts fixed.** Session-create examples use `agentName` (not `agent`) and call `app.sessions.create(...)` (not an undefined `agentClient`).
8. **Mirror consistency.** `docs/vision.md` and `swift-agent.md` remain consistent in every aligned section.
9. **Read-only respected.** `docs/as-built.md`, `docs/snapshots/**`, and `docs/programs/**` are unchanged; no `packages/**/*.ts` source file is modified; any genuine code bug discovered is flagged in the PR, not fixed here.
10. **Grep sweep clean.** The rule-10 grep sweep (Tests 1, 3, 4, 5, 6) passes with zero stale hits in docs/READMEs/example docs.
11. **Repo checks green (SC-10).** `pnpm typecheck`, `pnpm lint`, and `pnpm test` pass — or fail only on the memory-documented pre-existing failures, explicitly identified as unrelated — with the exact commands and results reported.
