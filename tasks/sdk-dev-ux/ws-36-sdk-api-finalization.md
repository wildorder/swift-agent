# WS-36: SDK API Finalization & Surface Lockdown

## Goal

Finalize and lock the **public API surface** of the two developer-facing packages, `@swiftagent/sdk` (server SDK) and `@swiftagent/react` (client SDK), so that each package exposes **exactly** the surface advertised in the product vision — no more, no less — and so that surface cannot drift silently in the future.

Concretely, this workstream:

1. Audits both root barrels (`packages/sdk/src/index.ts`, `packages/react/src/index.ts`), classifies every current export as **PUBLIC** (intended, keep at root) or **INTERNAL** (implementation detail, must not be reachable from the package root), and removes the internal ones from the root barrel — relocating the two intentional low-level escape hatches (`ControlPlaneClient`, `SdkHttpError`) and the wire-schema/config values (`ToolRunnerRequestSchema`, `SdkAgentConfigSchema`) behind a **declared** `@swiftagent/sdk/internal` subpath rather than deleting them.
2. Finalizes the `exports` map in each `package.json` so that (a) the root entry point uses explicit `types` + `import` conditions (already true — confirm/lock), (b) the new `/internal` subpath is declared for `@swiftagent/sdk`, and (c) **no undeclared deep import path is resolvable** — `moduleResolution: "Node16"` (see `tsconfig.base.json`) enforces `exports` encapsulation, so a consumer doing `import ... from '@swiftagent/sdk/dist/runner-token.js'` fails to resolve.
3. Adds a **public API surface guard** — a Vitest export-snapshot test per package that imports the package root and asserts the sorted list of exported binding names equals a committed inline snapshot, so any accidental addition/removal of a root export fails CI.
4. Confirms the genuinely-internal helper module `packages/sdk/src/runner-token.ts` (and any other non-barrel module) is unreachable from the package root.
5. Reconciles the public **type** surface with the vision's advertised names and records the one known discrepancy — the vision prose shows `tool({ inputSchema: <JSON Schema object> })` but the real `tool()` takes a **Zod** `inputSchema` — as an explicit, intentional decision (keep Zod; it is the source of truth per the repo conventions) for WS-40 to align the docs prose to. **This workstream does not edit docs prose.**

**Explicitly out of scope (owned elsewhere):** versioning, `private`/`publishConfig`/`files`/registry configuration (WS-37/WS-38); editing `docs/*` / `swift-agent.md` prose (WS-40); introducing CJS builds or dual-format packaging (the vision mandates ESM-only — do **not** add a `require` condition). Runtime behavior of the SDK is **not** changed — this is a surface/packaging finalization, not a feature change.

## Traceability

- **SC-01:** `@swiftagent/sdk` and `@swiftagent/react` expose exactly the vision-advertised public surface (incl. fluent `app.sessions.*` / `app.runs.*`, `useAgentChat`, `createChatSession`) through explicit `exports` maps; internal modules are not reachable from the package root. — Delivered by the barrel audit (Steps 1–4), the `exports`-map finalization (Steps 5–7), the `/internal` relocation (Step 3), and the surface-guard tests (Tests 1–2, 5).
- **SC-10:** Monorepo type-checking, linting, unit tests, and integration tests pass. — Delivered by the forced-verification gate in Acceptance Criteria (`pnpm typecheck && pnpm lint && pnpm test`, plus `pnpm test:integration`).

## Dependencies

- **None in-program.** This is the **anchor workstream** of the `sdk-dev-ux` program. It depends only on the as-built SDK baseline (the fluent server SDK from WS-08 and the client SDK/`createChatSession` fix from WS-34, both already merged on `dev`). WS-37 (versioning) and WS-38 (publish config) consume the locked surface this workstream produces; do not pre-empt their concerns here.

## Context Files (Agent MUST read before implementing)

Per **CLAUDE.md** rule 6/9, re-read each file immediately before editing it (do not trust memory or this paste after 10+ messages). Per rule 10, when removing/relocating an export, grep separately for direct refs, type-level refs, string literals, re-exports/barrels, and tests.

- `CLAUDE.md` — mechanical overrides. Binding here: **rule 4** forced verification (run `pnpm typecheck` + `pnpm lint` + tests, fix ALL), **rule 9** re-read before/after each edit, **rule 10** no-semantic-search grep discipline (search direct refs, type refs, string literals, dynamic imports, re-exports/barrels, and tests as *separate* greps).
- `packages/sdk/src/index.ts` — the server-SDK root barrel to audit and prune. Current contents pasted below.
- `packages/sdk/src/app.ts` — defines the `AgentApp` interface + `createAgentApp`. The fluent `sessions.*` / `runs.*` surface **already exists** — finalize, do not build. Note it *imports* `ControlPlaneClient`, `startToolRunner`, and the `RunnerVerifyKey` type internally; relocating those from the root barrel must not break these intra-package imports (they import from `./client.js` / `./tool-runner.js` directly, not from the barrel).
- `packages/sdk/src/client.ts` — `ControlPlaneClient` (low-level control-plane HTTP client). Decide: keep public or move behind `/internal`. Recommendation below: move to `/internal`.
- `packages/sdk/src/types.ts` — all SDK value/type exports: `SdkHttpError`, `ToolRunnerRequestSchema`, `SdkAgentConfigSchema`, `ToolRegistry` (internal), `RunnerAuthConfig` (internal), plus the developer-facing types (`ToolContext`, `ToolDefinition`, `SdkAgentConfig`, session/run option+result types, re-exported shared records).
- `packages/sdk/src/tool.ts` — `tool()` (Zod `inputSchema`) + `toolToJsonSchema()`. Source of the Zod-vs-JSON-Schema discrepancy with the vision prose.
- `packages/sdk/src/agent.ts` — `defineAgent()`. Public.
- `packages/sdk/src/tool-runner.ts` — `startToolRunner()`. Currently root-exported; decide public vs `/internal` (recommendation: `/internal` — it is used by `app.listen()` and is not in the vision surface, but is a legitimate advanced entry point).
- `packages/sdk/src/runner-token.ts` — **internal** verification helper. Currently NOT exported from the barrel (correct). Must stay unreachable from root; only its *type* `RunnerVerifyKey` is imported by `types.ts`/`app.ts` internally.
- `packages/sdk/package.json` — current `exports` map has only `"."`. You own the *shape* of this map (root + any `/internal` subpath). Do NOT touch `private`/`version`/`files`/`publishConfig` (WS-38).
- `packages/react/src/index.ts` — the client-SDK root barrel to audit. Current contents pasted below.
- `packages/react/src/types.ts` — client types: `ChatEvent` (re-export), `ConnectionStatus`, `ToolCallInfo`, `ChatMessage`, `ReconnectOptions`, `CreateChatSessionOptions`, `ChatSessionClient`, `UseAgentChatArgs`, `UseAgentChatResult`.
- `packages/react/src/client.ts` — `createChatSession()` (the vision-advertised vanilla client; note the returned object is internally widened with an `onStatusChange` member via a cast — that member is intentionally NOT on the public `ChatSessionClient` type and must stay hidden).
- `packages/react/src/hooks/use-agent-chat.ts` — `useAgentChat()` (vision-advertised). Public.
- `packages/react/src/hooks/use-connection.ts` — `useConnection()` + its `UseConnectionOptions` / `UseConnectionResult` types. **Decision (M-002, resolved):** `useConnection` is an internal composition helper, not in the vision surface — it is made **internal**: removed from the root barrel (along with `UseConnectionOptions` / `UseConnectionResult`) so the react root is exactly the vision surface (SC-01). The module **stays** — `useAgentChat` imports it internally — it is just no longer root-reachable. Justified in Design Notes.
- `packages/react/src/state.ts` — `chatReducer`, `initialChatState`, `ChatState`, `ChatAction`, `InternalAction`. **Decision point:** these are reducer internals of `useAgentChat`, not in the vision surface. Recommendation: remove from the root barrel (they leak the internal state machine). Justify below.
- `packages/react/package.json` — current `exports` map has only `"."`. You own its shape. Do NOT touch `private`/`version`/`sideEffects`/`publishConfig` semantics beyond what SC-01 requires (WS-38).
- `packages/shared/src/index.ts` — source of `ChatEvent` (re-exported by react) and the record types (`SessionRecord`, `MessageRecord`, `RunRecord`, `AgentRecord`) and `RunnerRequestSchema` (aliased as `ToolRunnerRequestSchema` in the sdk) re-exported by the sdk. Confirms which names are shared-owned vs sdk-owned.
- `docs/vision.md` (API Surface, ≈ lines 218–268) — the authoritative list of the advertised public surface (server: `createAgentApp`, `defineAgent`, `tool`, `app.agent`, `app.sessions.create/get`, `app.sessions.messages.list`, `app.runs.create`; client: `useAgentChat`, `createChatSession`). Read-only reference for **what** the surface must be — do not edit it (WS-40 owns doc prose).
- `tsconfig.base.json` — confirms `module`/`moduleResolution: "Node16"`, `verbatimModuleSyntax: true`, `isolatedModules: true`. Node16 resolution is what makes the `exports` map an actual encapsulation boundary for TypeScript consumers.

## Package

- `packages/sdk` (`@swiftagent/sdk`) — primary.
- `packages/react` (`@swiftagent/react`) — primary.

No other packages are modified. (`@swiftagent/shared` is read-only context — its re-exported names are consumed, not changed.)

## Files Touched

- `packages/sdk/src/index.ts` **(MODIFY)** — prune internal exports to the vision-advertised public surface only.
- `packages/sdk/src/internal.ts` **(NEW)** — the declared `@swiftagent/sdk/internal` entry point; re-exports the low-level escape hatches (`ControlPlaneClient`, `SdkHttpError`, `startToolRunner`, `ToolRunnerRequestSchema`, `SdkAgentConfigSchema`) and the advanced types they need. Documented as unstable/advanced.
- `packages/sdk/package.json` **(MODIFY)** — add the `"./internal"` key to `exports` with explicit `types`+`import`; keep `"."` explicit. (Do NOT touch `private`/`version`/`files`/`publishConfig`.)
- `packages/sdk/src/__tests__/public-api.test.ts` **(NEW)** — export-snapshot guard for the sdk root (and an assertion that `/internal` carries the escape hatches and that a representative internal deep path is not re-exported at root).
- `packages/react/src/index.ts` **(MODIFY)** — prune reducer/state internals **and `useConnection` (+ `UseConnectionOptions`/`UseConnectionResult`)** from the root barrel; keep exactly the vision surface (`useAgentChat`, `createChatSession`) + their public types.
- `packages/react/package.json` **(MODIFY)** — keep `"."` explicit `types`+`import` (confirm/lock; likely no shape change). (Do NOT touch `private`/`version`/`sideEffects`/`publishConfig`.)
- `packages/react/src/__tests__/public-api.test.ts` **(NEW)** — export-snapshot guard for the react root.

> No source *logic* files change. `runner-token.ts`, `client.ts`, `tool-runner.ts`, `state.ts`, `use-connection.ts` keep their `export`s (they are consumed intra-package and, for the relocated ones, re-exported via `internal.ts`); only the **root barrels** and the **`exports` maps** change what is reachable from outside the package.

## Existing Interfaces to Consume

### Current server-SDK root barrel — `packages/sdk/src/index.ts` (VERBATIM)

```ts
// Core API
export { createAgentApp } from './app.js';
export type { AgentApp } from './app.js';
export { defineAgent } from './agent.js';
export { tool, toolToJsonSchema } from './tool.js';

// Client
export { ControlPlaneClient } from './client.js';

// Tool runner
export { startToolRunner } from './tool-runner.js';

// Types — values
export { SdkHttpError, ToolRunnerRequestSchema, SdkAgentConfigSchema } from './types.js';

// Types — type-only
export type {
  ToolContext,
  ToolDefinition,
  ToolSchema,
  SdkAgentConfig,
  AgentDefinition,
  CreateAgentAppConfig,
  ToolRunnerRequest,
  ToolRunnerSuccessResponse,
  ToolRunnerErrorResponse,
  ToolRegistry,
  CreateSessionOptions,
  CreateSessionResult,
  ListMessagesOptions,
  ListMessagesResult,
  CreateRunOptions,
  AcceptedRun,
  AgentRecord,
  SessionRecord,
  MessageRecord,
  RunRecord,
} from './types.js';
```

### The fluent `AgentApp` interface (already implemented) — `packages/sdk/src/app.ts`

```ts
export interface AgentApp {
  /** Register an agent definition. Duplicate tool names across agents throw. */
  agent(definition: AgentDefinition): AgentApp;

  /** Session management helpers delegating to the control plane API. */
  sessions: {
    create(opts: CreateSessionOptions): Promise<CreateSessionResult>;
    get(id: string): Promise<SessionRecord>;
    messages: {
      list(sessionId: string, opts?: ListMessagesOptions): Promise<ListMessagesResult>;
    };
  };

  /** Run management helpers delegating to the control plane API. */
  runs: {
    create(opts: CreateRunOptions): Promise<AcceptedRun>;
    get(runId: string): Promise<RunRecord>;
    cancel(runId: string): Promise<AcceptedRun>;
  };

  /** Start the tool runner and register all agents with the control plane. */
  listen(port?: number): Promise<void>;

  /** Stop the tool runner server. */
  close(): Promise<void>;
}
```

### Current client-SDK root barrel — `packages/react/src/index.ts` (VERBATIM)

```ts
// Vanilla JS client
export { createChatSession } from './client.js';

// React hooks
export { useAgentChat } from './hooks/use-agent-chat.js';
export { useConnection } from './hooks/use-connection.js';

// State
export { chatReducer, initialChatState } from './state.js';
export type { ChatState, ChatAction, InternalAction } from './state.js';

// Types
export type {
  ChatEvent,
  ChatMessage,
  ChatSessionClient,
  ConnectionStatus,
  CreateChatSessionOptions,
  ReconnectOptions,
  ToolCallInfo,
  UseAgentChatArgs,
  UseAgentChatResult,
} from './types.js';
export type { UseConnectionOptions, UseConnectionResult } from './hooks/use-connection.js';
```

### Current `exports` maps (both packages, VERBATIM)

`packages/sdk/package.json`:

```json
"exports": {
  ".": {
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js"
  }
}
```

`packages/react/package.json`:

```json
"exports": {
  ".": {
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js"
  }
}
```

### Relevant type facts (from `types.ts` — do not re-derive)

- `tool()`'s `ToolDefinition<TInput, TResult>.inputSchema` is a **Zod** `ZodType<TInput>` (not a JSON Schema object). `toolToJsonSchema()` converts it to OpenAPI-3 JSON Schema for API registration. The vision prose's `inputSchema: object` is the loose doc form; the real, stable contract is Zod.
- `ToolRegistry = Map<string, ToolDefinition>` and `RunnerAuthConfig` are commented `// (internal)` in `types.ts` — `ToolRegistry` is currently *type-exported from the root barrel* (a leak: it exposes the internal registry shape). It should not be at root.
- `ToolRunnerRequestSchema` is an alias of shared's `RunnerRequestSchema`; `ToolRunnerRequest = z.infer<...>`. These are the runner *wire contract*, owned by `@swiftagent/shared`. They are advanced/internal from the SDK's perspective.

## Design Notes

### Public-vs-internal classification — `@swiftagent/sdk`

Map each current root export to a fate. "Public (root)" = stays in `index.ts`. "Internal (`/internal`)" = moves to the new `@swiftagent/sdk/internal` subpath. "Remove" = dropped from every public entry point (still `export`ed from its source module for intra-package use, just not re-exported publicly).

| Current root export | Kind | Fate | Justification |
|---|---|---|---|
| `createAgentApp` | value | **Public (root)** | Vision top-level entry. |
| `AgentApp` (type) | type | **Public (root)** | Return type of `createAgentApp`; users annotate with it. |
| `defineAgent` | value | **Public (root)** | Vision top-level entry. |
| `tool` | value | **Public (root)** | Vision top-level entry. |
| `toolToJsonSchema` | value | **Internal (`/internal`)** | A serialization helper for registration payloads; not in the vision surface. Advanced/tooling use only. |
| `ControlPlaneClient` | value | **Internal (`/internal`)** | Low-level raw HTTP client. The fluent `app.sessions.*`/`app.runs.*` is the intended surface; keep the raw client as a documented escape hatch, not root API. |
| `startToolRunner` | value | **Internal (`/internal`)** | Used by `app.listen()`. A legitimate advanced entry (custom runner hosting) but not vision surface. |
| `SdkHttpError` | value | **Internal (`/internal`)** | Thrown by the raw client; needed by advanced callers doing `instanceof` on `/internal` client errors. Not vision surface. |
| `ToolRunnerRequestSchema` | value | **Internal (`/internal`)** | Runner wire schema (shared-owned alias). Advanced/testing only. |
| `SdkAgentConfigSchema` | value | **Internal (`/internal`)** | Zod schema backing `defineAgent`; advanced validation use. Not vision surface. |
| `ToolContext` (type) | type | **Public (root)** | Second arg to every tool `execute` — developers annotate handlers with it. Vision "Key Types". |
| `ToolDefinition` (type) | type | **Public (root)** | Return of `tool()`; vision "Key Types". |
| `SdkAgentConfig` (type) | type | **Public (root)** | Arg to `defineAgent` (vision `AgentConfig`). |
| `AgentDefinition` (type) | type | **Public (root)** | Return of `defineAgent`; passed to `app.agent()`. |
| `CreateAgentAppConfig` (type) | type | **Public (root)** | Arg to `createAgentApp`. |
| `CreateSessionOptions`/`CreateSessionResult` | type | **Public (root)** | Arg/return of `app.sessions.create`. |
| `ListMessagesOptions`/`ListMessagesResult` | type | **Public (root)** | Arg/return of `app.sessions.messages.list`. |
| `CreateRunOptions`/`AcceptedRun` | type | **Public (root)** | Arg/return of `app.runs.create`/`cancel`. |
| `AgentRecord`/`SessionRecord`/`MessageRecord`/`RunRecord` | type | **Public (root)** | Return types of the fluent helpers; re-exported from `@swiftagent/shared`. Keep at root so users need not depend on `@swiftagent/shared` directly. |
| `ToolSchema` (type) | type | **Internal (`/internal`)** | Serialized-schema shape produced by `toolToJsonSchema`; pairs with it. Advanced. |
| `ToolRunnerRequest` (type) | type | **Internal (`/internal`)** | Wire type; pairs with `ToolRunnerRequestSchema`. |
| `ToolRunnerSuccessResponse`/`ToolRunnerErrorResponse` | type | **Internal (`/internal`)** | Runner wire response shapes. Advanced. |
| `ToolRegistry` (type) | type | **Remove** | Internal registry `Map` shape (commented `// internal`). Leaks an implementation detail; not needed by any public signature. Drop from all public entry points. |

**Result — sdk root public surface (18 names):** `createAgentApp`, `defineAgent`, `tool` (values); `AgentApp`, `ToolContext`, `ToolDefinition`, `SdkAgentConfig`, `AgentDefinition`, `CreateAgentAppConfig`, `CreateSessionOptions`, `CreateSessionResult`, `ListMessagesOptions`, `ListMessagesResult`, `CreateRunOptions`, `AcceptedRun`, `AgentRecord`, `SessionRecord`, `MessageRecord`, `RunRecord` (types). (Type-only names still appear as bindings in `import * as` at runtime? No — pure `export type` names erase at runtime; the runtime-visible root exports are the 3 values. The snapshot guard therefore must assert the *type-level* surface via a `.d.ts`/`import type` check as well; see Tests.)

### The `/internal` subpath decision (sdk)

**Chosen approach: relocate, don't delete.** `ControlPlaneClient`, `SdkHttpError`, `startToolRunner`, `toolToJsonSchema`, `ToolRunnerRequestSchema`, `SdkAgentConfigSchema` (and their paired advanced types) are legitimate escape hatches used by power users, tests, and future internal tooling — deleting them from the public API entirely would be user-hostile and would break the sdk's own `__tests__` that import them. Segregating them behind a **declared, documented-as-unstable** `@swiftagent/sdk/internal` entry point (a) keeps the root surface exactly the vision surface (SC-01), (b) makes "you are reaching into internals" explicit at the import site, and (c) still lets WS-37/WS-38 decide independently whether `/internal` ships in `files`. `internal.ts` carries a top banner comment: *"Unstable surface — not covered by semver; may change or be removed in any minor. Prefer the root `@swiftagent/sdk` API."*

### Public-vs-internal classification — `@swiftagent/react`

| Current root export | Kind | Fate | Justification |
|---|---|---|---|
| `createChatSession` | value | **Public (root)** | Vision-advertised vanilla client. |
| `useAgentChat` | value | **Public (root)** | Vision-advertised React hook. |
| `useConnection` | value | **Internal (remove from root)** | Not in vision. An internal composition helper that `useAgentChat` builds on. Removed from the root barrel to make the react surface exactly the vision surface (SC-01). The source module stays (imported by `useAgentChat`); it is just not root-reachable. |
| `chatReducer` | value | **Remove** | Internal state machine of `useAgentChat`. Exposing it invites consumers to couple to the reducer's action shape. |
| `initialChatState` | value | **Remove** | Pairs with `chatReducer`; same reasoning. |
| `ChatState` (type) | type | **Remove** | Internal reducer state shape. |
| `ChatAction` (type) | type | **Remove** | Internal action union (includes `InternalAction`). |
| `InternalAction` (type) | type | **Remove** | Literally named "internal". |
| `ChatEvent` (type) | type | **Public (root)** | Vision `ChatEvent` union; re-exported from shared. Consumers use it in `onEvent` handlers. |
| `ChatMessage` (type) | type | **Public (root)** | Element type of `useAgentChat().messages`. |
| `ChatSessionClient` (type) | type | **Public (root)** | Return type of `createChatSession`. |
| `ConnectionStatus` (type) | type | **Public (root)** | Field of `useAgentChat` result / client. |
| `CreateChatSessionOptions` (type) | type | **Public (root)** | Arg to `createChatSession`. |
| `ReconnectOptions` (type) | type | **Public (root)** | Nested option in both entry points. |
| `ToolCallInfo` (type) | type | **Public (root)** | Nested in `ChatMessage.toolCalls`. |
| `UseAgentChatArgs` (type) | type | **Public (root)** | Arg to `useAgentChat`. |
| `UseAgentChatResult` (type) | type | **Public (root)** | Return of `useAgentChat`. |
| `UseConnectionOptions`/`UseConnectionResult` (type) | type | **Internal (remove from root)** | Arg/return of `useConnection`; removed from root along with it. Still exported from `hooks/use-connection.ts` for intra-package use. |

**`useConnection` — made internal (M-002, resolved).** It is not in the vision's advertised list. SC-01 requires the react root to expose **exactly** the vision-advertised public surface — no more, no less — so `useConnection` (and its `UseConnectionOptions` / `UseConnectionResult` types) is **removed from the root barrel**. This is the deciding factor: "already exported and stable" does not override the exactly-vision mandate, and `useConnection` is a thin composition helper `useAgentChat` builds on rather than a surface users need directly. The **source module `hooks/use-connection.ts` stays** — `useAgentChat` imports it internally — it simply becomes non-root-reachable; the finalized `exports` map (single `"."` entry) blocks deep imports under Node16, so plain removal from the barrel is sufficient. We therefore **remove the reducer/state quintet** (`chatReducer`/`initialChatState`/`ChatState`/`ChatAction`/`InternalAction`) **and `useConnection` + its two types**, leaving exactly the vision surface. No `@swiftagent/react/internal` subpath is introduced — nothing else genuinely needs to be root-reachable, so a subpath would be dead weight (unlike the sdk, whose escape hatches justify `@swiftagent/sdk/internal`). (If a future WS needs `useConnection` or the reducer for advanced use, it can add `@swiftagent/react/internal` then.)

**Result — react root public surface:** values `createChatSession`, `useAgentChat`; types `ChatEvent`, `ChatMessage`, `ChatSessionClient`, `ConnectionStatus`, `CreateChatSessionOptions`, `ReconnectOptions`, `ToolCallInfo`, `UseAgentChatArgs`, `UseAgentChatResult`.

### ESM-only constraint

Both packages are `"type": "module"` and build with plain `tsc` to `dist/*.js` + `*.d.ts`. **Do not** add a `require`/CJS condition, a `default` fallback, or a dual `main`/`module` split. The `exports` conditions are exactly `types` (first, per TS resolver requirement) then `import`. The existing `main`/`types` top-level fields are retained for legacy resolvers but the `exports` map is authoritative under Node16 resolution.

### Encapsulation is real under Node16

Because every package sets `moduleResolution: "Node16"` (`tsconfig.base.json`), once the `exports` map lists only `"."` (and, for the sdk, `"./internal"`), a consumer importing any other subpath — e.g. `@swiftagent/sdk/dist/runner-token.js` or `@swiftagent/react/dist/state.js` — gets a `TS2307` "Cannot find module" and a Node `ERR_PACKAGE_PATH_NOT_EXPORTED` at runtime. No extra tooling is needed to *block* deep imports; the guard test exists to catch *root-surface* drift, which `exports` alone cannot detect.

### Type discrepancy for WS-40 (record only, do not edit docs)

Vision prose (`docs/vision.md` "Key Types") shows `ToolDefinition.inputSchema: object` and `tool({ inputSchema: <JSON Schema> })`. The real, intended, **stable** contract is **Zod**: `inputSchema: ZodType<TInput>`, validated at runtime by `tool()` (`typeof config.inputSchema.safeParse === 'function'`) and converted to JSON Schema only for registration via `toolToJsonSchema()`. **Decision: keep Zod** (Zod schemas are the source of truth per CLAUDE.md conventions; deriving types via `z.infer` is the repo standard). Record this in the PR description as the authoritative contract so **WS-40** aligns the doc prose to Zod (and not the reverse). Do not change `docs/vision.md` here.

## Implementation Steps

1. **Re-read (CLAUDE.md 6/9).** Immediately re-read `packages/sdk/src/index.ts`, `types.ts`, `app.ts`, `client.ts`, `tool.ts`, `tool-runner.ts`, `package.json`; and `packages/react/src/index.ts`, `state.ts`, `hooks/use-connection.ts`, `package.json`. Confirm the pasted barrels/exports match reality before editing.

2. **Grep the blast radius (CLAUDE.md 10).** For every symbol being **relocated to `/internal`** (`ControlPlaneClient`, `startToolRunner`, `SdkHttpError`, `toolToJsonSchema`, `ToolRunnerRequestSchema`, `SdkAgentConfigSchema`, `ToolSchema`, `ToolRunnerRequest`, `ToolRunnerSuccessResponse`, `ToolRunnerErrorResponse`) and every symbol being **removed** (`ToolRegistry` from sdk; `chatReducer`, `initialChatState`, `ChatState`, `ChatAction`, `InternalAction`, `useConnection`, `UseConnectionOptions`, `UseConnectionResult` from react), run *separate* greps for: (a) direct import from the package name (`@swiftagent/sdk'`, `@swiftagent/react'`), (b) direct import from the barrel/source path, (c) type-level uses, (d) string literals of the name, (e) re-exports in any other barrel, (f) test files. Record which call sites (esp. the sdk/react `__tests__`) import these — those tests must be repointed to `@swiftagent/sdk/internal` (or the source module) rather than the root. **Do not assume one grep is complete.**

3. **Create `packages/sdk/src/internal.ts` (NEW).** Add the unstable-surface banner comment, then re-export the relocated escape hatches from their source modules:
   ```ts
   /**
    * @swiftagent/sdk/internal — UNSTABLE advanced surface.
    * Not covered by semver; may change or be removed in any minor release.
    * Prefer the root `@swiftagent/sdk` API. Exposed for power users, custom
    * runner hosting, raw control-plane access, and the SDK's own tests.
    */
   export { ControlPlaneClient } from './client.js';
   export { startToolRunner } from './tool-runner.js';
   export { toolToJsonSchema } from './tool.js';
   export { SdkHttpError, ToolRunnerRequestSchema, SdkAgentConfigSchema } from './types.js';
   export type {
     ToolSchema,
     ToolRunnerRequest,
     ToolRunnerSuccessResponse,
     ToolRunnerErrorResponse,
     RunnerAuthConfig,
   } from './types.js';
   ```
   (Include `RunnerAuthConfig` since `startToolRunner` takes it; it is otherwise unreachable.)

4. **Prune `packages/sdk/src/index.ts` (MODIFY).** Reduce to exactly the 18-name public surface from Design Notes: keep `createAgentApp`, `AgentApp`, `defineAgent`, `tool`, and the public type block **minus** `ToolSchema`, `ToolRunnerRequest`, `ToolRunnerSuccessResponse`, `ToolRunnerErrorResponse`, `ToolRegistry`. Remove the `ControlPlaneClient`, `startToolRunner`, `toolToJsonSchema`, and `SdkHttpError`/`ToolRunnerRequestSchema`/`SdkAgentConfigSchema` lines. Add a one-line comment pointing advanced users to `@swiftagent/sdk/internal`.

5. **Finalize `packages/sdk/package.json` `exports` (MODIFY).** Add the `"./internal"` key; keep `"."` explicit; `types` first, then `import`, ESM-only:
   ```json
   "exports": {
     ".": {
       "types": "./dist/index.d.ts",
       "import": "./dist/index.js"
     },
     "./internal": {
       "types": "./dist/internal.d.ts",
       "import": "./dist/internal.js"
     }
   }
   ```
   Leave `main`, `types`, `private`, `version`, `scripts`, `dependencies` untouched. Add **no** `require`/`default` condition. Do **not** add `files`/`publishConfig` (WS-38).

6. **Prune `packages/react/src/index.ts` (MODIFY).** Remove the `// State` block entirely (`chatReducer`, `initialChatState`, and the `ChatState`/`ChatAction`/`InternalAction` type export). Also remove the `useConnection` value export (from the `// React hooks` block) and the `UseConnectionOptions`/`UseConnectionResult` type-export line. Keep exactly `createChatSession`, `useAgentChat`, and the public type block (`ChatEvent`, `ChatMessage`, `ChatSessionClient`, `ConnectionStatus`, `CreateChatSessionOptions`, `ReconnectOptions`, `ToolCallInfo`, `UseAgentChatArgs`, `UseAgentChatResult`). Note `hooks/use-connection.ts` keeps its own `export`s — it is still imported by `useAgentChat`; only the root re-exports are dropped.

7. **Confirm/lock `packages/react/package.json` `exports` (MODIFY if needed).** Ensure the single `"."` entry has `types` then `import`, ESM-only. It already does — if so, this is a no-op confirmation (state that in the PR). Do **not** add an `/internal` subpath (nothing to put in it). Leave `sideEffects: false`, `private`, `version`, `peerDependencies` untouched.

8. **Repoint internal call sites (from Step 2).** Any sdk `__tests__` (or other intra-package code) that imported a relocated symbol *from the package root* now imports it from `@swiftagent/sdk/internal` or directly from the source module (`./client.js`, etc.). Intra-package production code already imports from source modules (e.g. `app.ts` → `./client.js`), so it should need no change — verify per Step 2's grep results. Any react test importing the reducer quintet must import from `../state.js` (source), not the root barrel; likewise any react test importing `useConnection` / `UseConnectionOptions` / `UseConnectionResult` must import from `../hooks/use-connection.js` (source), not the root barrel.

9. **Write the two guard tests (NEW)** per the Tests section.

10. **Verify (CLAUDE.md 4 — forced verification).** From the repo root run `pnpm typecheck`, then `pnpm lint`, then `pnpm test`, then `pnpm test:integration` (Testcontainers/Docker). Fix **all** errors. If any pre-existing failure is hit, cross-check against the user memory notes (server vitest exit 1; api /health+/workspaces; test-tree not typechecked) and confirm it is unrelated to this change before proceeding. Report exact commands + results.

## Tests

All new tests are Vitest, placed in each package's existing `src/__tests__/` directory (matching `packages/sdk/src/__tests__/*.test.ts` and `packages/react/src/__tests__/*.test.ts`).

1. **sdk root export-snapshot guard** — `packages/sdk/src/__tests__/public-api.test.ts`. `import * as sdk from '../index.js'` and assert `Object.keys(sdk).sort()` deep-equals the committed inline array of **runtime** (value) exports: `['createAgentApp', 'defineAgent', 'tool']`. This fails if any value export is added to or removed from the root. Also assert each expected key is a `function`.

2. **sdk root type-surface guard (compile-time)** — in the same file, add a type-level assertion block that imports the public *types* and would fail `tsc` if any were removed/renamed:
   ```ts
   import type {
     AgentApp, ToolContext, ToolDefinition, SdkAgentConfig, AgentDefinition,
     CreateAgentAppConfig, CreateSessionOptions, CreateSessionResult,
     ListMessagesOptions, ListMessagesResult, CreateRunOptions, AcceptedRun,
     AgentRecord, SessionRecord, MessageRecord, RunRecord,
   } from '../index.js';
   type _Assert<T> = T extends never ? never : true;
   // referencing each type keeps them load-bearing for the surface check
   const _typeSurface: _Assert<AgentApp> extends never ? never : true = true;
   void _typeSurface;
   ```
   (The value assertion in Test 1 is the runtime guard; this block guards the type surface — since `pnpm typecheck` runs on `src/`, a removed/renamed public type breaks the build here.)

3. **sdk `/internal` carries the escape hatches** — `import * as internal from '../internal.js'` and assert `Object.keys(internal).sort()` deep-equals `['ControlPlaneClient', 'SdkAgentConfigSchema', 'SdkHttpError', 'ToolRunnerRequestSchema', 'startToolRunner', 'toolToJsonSchema']`. Confirms the relocated values are reachable via the declared subpath.

4. **Internal-not-at-root assertion** — assert that the relocated names are **absent** from the root namespace: `expect((sdk as Record<string, unknown>).ControlPlaneClient).toBeUndefined()` for `ControlPlaneClient`, `startToolRunner`, `toolToJsonSchema`, `SdkHttpError`, `ToolRunnerRequestSchema`, `SdkAgentConfigSchema`. This is the SC-01 "internal modules not reachable from root" runtime check.

5. **react root export-snapshot guard** — `packages/react/src/__tests__/public-api.test.ts`. `import * as react from '../index.js'` and assert `Object.keys(react).sort()` deep-equals `['createChatSession', 'useAgentChat']` (the runtime value exports — exactly the vision surface, **no `useConnection`**), and that the removed values are absent: `expect((react as Record<string, unknown>).chatReducer).toBeUndefined()` and the same for `initialChatState` and `useConnection`. Add the analogous compile-time type-surface block (Test 2 style) importing the retained public types (`ChatEvent`, `ChatMessage`, `ChatSessionClient`, `ConnectionStatus`, `CreateChatSessionOptions`, `ReconnectOptions`, `ToolCallInfo`, `UseAgentChatArgs`, `UseAgentChatResult`) from `../index.js` — **not** `UseConnectionOptions`/`UseConnectionResult`, which are no longer root-exported.

6. **Regression: existing sdk/react suites still pass** — the pre-existing `__tests__` (e.g. `app.test.ts`, `tool-runner.test.ts`, `client.test.ts`, `hooks.test.ts`, `state.test.ts`) must pass after their imports are repointed (Step 8). No behavioral change is expected; a failure here means an import was missed. `state.test.ts` in particular must import `chatReducer`/`initialChatState` from `../state.js` (source), not the root barrel; and any test exercising `useConnection` must import it from `../hooks/use-connection.js` (source), not the root barrel.

> Note on the snapshot form: use an **inline committed array** (not Vitest `toMatchSnapshot()` file snapshots) so the expected surface is reviewed in the diff and cannot be silently `-u`-updated without a visible code change. A surface change must edit this array explicitly.

## Acceptance Criteria

1. `packages/sdk/src/index.ts` exports exactly the public surface: values `createAgentApp`, `defineAgent`, `tool`; and the 15 public types (`AgentApp`, `ToolContext`, `ToolDefinition`, `SdkAgentConfig`, `AgentDefinition`, `CreateAgentAppConfig`, `CreateSessionOptions`, `CreateSessionResult`, `ListMessagesOptions`, `ListMessagesResult`, `CreateRunOptions`, `AcceptedRun`, `AgentRecord`, `SessionRecord`, `MessageRecord`, `RunRecord`). `ControlPlaneClient`, `startToolRunner`, `toolToJsonSchema`, `SdkHttpError`, `ToolRunnerRequestSchema`, `SdkAgentConfigSchema`, `ToolSchema`, `ToolRunnerRequest`, `ToolRunnerSuccessResponse`, `ToolRunnerErrorResponse`, and `ToolRegistry` are **no longer** reachable from `@swiftagent/sdk` root.
2. `@swiftagent/sdk/internal` exists as a declared `exports` subpath and re-exports `ControlPlaneClient`, `startToolRunner`, `toolToJsonSchema`, `SdkHttpError`, `ToolRunnerRequestSchema`, `SdkAgentConfigSchema` (plus their advanced types). `ToolRegistry` is removed from all public entry points.
3. `packages/react/src/index.ts` exports **exactly** the vision-advertised surface: values `createChatSession`, `useAgentChat` (no `useConnection`); and the public types listed in Design Notes (`ChatEvent`, `ChatMessage`, `ChatSessionClient`, `ConnectionStatus`, `CreateChatSessionOptions`, `ReconnectOptions`, `ToolCallInfo`, `UseAgentChatArgs`, `UseAgentChatResult`). `chatReducer`, `initialChatState`, `ChatState`, `ChatAction`, `InternalAction`, `useConnection`, `UseConnectionOptions`, and `UseConnectionResult` are **no longer** reachable from `@swiftagent/react` root (per SC-01 exactly-vision). `hooks/use-connection.ts` still exists and is imported internally by `useAgentChat`; it is simply not root-reachable (and the single-`"."` `exports` map blocks deep imports under Node16).
4. Both `package.json` `exports` maps use explicit `types`+`import` conditions and are **ESM-only** (no `require`/`default`/CJS condition added). The sdk map has `"."` and `"./internal"`; the react map has `"."`. `private`, `version`, `files`, `publishConfig`, `sideEffects` are unchanged (deferred to WS-37/WS-38).
5. Deep imports of undeclared subpaths (e.g. `@swiftagent/sdk/dist/runner-token.js`, `@swiftagent/react/dist/state.js`) do not resolve under Node16 resolution — confirmed by the fact that `pnpm typecheck` passes with only declared entry points and no source references such paths. `runner-token.ts` is reachable from neither the root nor `/internal` (only its type is used intra-package).
6. The export-snapshot guard tests (Tests 1–5) exist for both packages, use committed inline arrays (not file snapshots), and fail if the root surface changes; the compile-time type-surface blocks fail `tsc` if a public type is removed/renamed.
7. All pre-existing sdk/react unit tests pass with imports repointed to `@swiftagent/sdk/internal` / source modules where they previously used the root barrel.
8. The Zod-`inputSchema` public contract is documented in the PR description as the authoritative, stable form (for WS-40 to align docs prose to); `docs/vision.md` and other prose are **not** edited in this workstream.
9. **Forced verification (CLAUDE.md rule 4):** `pnpm typecheck && pnpm lint && pnpm test` all pass green, and `pnpm test:integration` passes (or any failure is shown to be a documented pre-existing issue unrelated to this change, per the user memory notes). The exact commands and their results are reported in the PR.
