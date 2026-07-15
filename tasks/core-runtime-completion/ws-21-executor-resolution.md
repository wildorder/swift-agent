# WS-21: Per-Agent Executor Resolution

## Goal

Replace the server-wide, always-empty `LocalToolExecutor` with per-agent executor resolution driven by the active run's agent. Today `apps/server` constructs one `new LocalToolExecutor()` and hands it to `AgentEngine`, so every agent — regardless of its `toolRunnerUrl` — executes against an empty in-process registry, and the existing `RemoteToolExecutor` / `createToolExecutor` factory are dead code. This workstream introduces a `ToolExecutorResolver` that maps an `AgentRecord` to the correct executor (remote for SDK-runner agents, local for explicit platform/test tools), wires it through `AgentEngine`/`runAgentLoop`, removes unconditional local selection from server composition, and guarantees that concurrent agents with different runner configurations cannot cross-route calls to each other's runners.

## Traceability

- **SC-07** — Two agents with different runner configurations use their respective executors without cross-routing.

## Dependencies

- **WS-19** — `AgentRecord.tools` is persisted (executor resolution reads the full agent record).
- **product-x WS-05a** — `ToolExecutor`, `LocalToolExecutor`, `RemoteToolExecutor`, `createToolExecutor`.
- **product-x WS-11** — `apps/server` `buildContainer` composition.

## Context Files (Agent MUST read before implementing)

- `c:\dev\swift-agent\CLAUDE.md` — conventions (factory functions, executor interface neutrality).
- `c:\dev\swift-agent\packages\runtime\src\tool-executor.ts` — `ToolExecutor`, `ToolCall`, `ToolCallContext`, `ToolCallResult`.
- `c:\dev\swift-agent\packages\runtime\src\tool-executor-factory.ts` — existing `createToolExecutor(agent, { authToken })`.
- `c:\dev\swift-agent\packages\runtime\src\tool-executor-local.ts` — `LocalToolExecutor` + `registerTool`.
- `c:\dev\swift-agent\packages\runtime\src\tool-executor-remote.ts` — `RemoteToolExecutor` options.
- `c:\dev\swift-agent\packages\runtime\src\engine.ts` — `AgentEngine` (loads agent, builds `RunContext`).
- `c:\dev\swift-agent\packages\runtime\src\loop.ts` — where `deps.toolExecutor.execute(...)` is called.
- `c:\dev\swift-agent\packages\runtime\src\types.ts` — `AgentEngineDeps` (currently `toolExecutor: ToolExecutor`).
- `c:\dev\swift-agent\packages\runtime\src\index.ts` — runtime barrel.
- `c:\dev\swift-agent\apps\server\src\container.ts` — the `new LocalToolExecutor()` composition to replace.

## Package

`packages/runtime`, `packages/shared`, `apps/server`

## Files Touched

- `packages/runtime/src/tool-executor-resolver.ts` **(NEW)** — `ToolExecutorResolver` interface + default implementation.
- `packages/runtime/src/types.ts` **(MODIFY)** — replace `toolExecutor: ToolExecutor` with `toolExecutorResolver: ToolExecutorResolver` in `AgentEngineDeps`.
- `packages/runtime/src/engine.ts` **(MODIFY)** — resolve the executor for the run's agent and pass it into the loop.
- `packages/runtime/src/loop.ts` **(MODIFY)** — consume a resolved executor (via deps or `RunContext`) instead of `deps.toolExecutor`.
- `packages/runtime/src/index.ts` **(MODIFY)** — export resolver types/factory.
- `apps/server/src/container.ts` **(MODIFY)** — build a `ToolExecutorResolver` (interim config-token auth) instead of a fixed `LocalToolExecutor`.
- `packages/shared/src/config.ts` **(MODIFY)** — add `ENV_KEYS.INTERNAL_RUNNER_TOKEN` (interim runner auth token; superseded by WS-22).
- `packages/runtime/src/__tests__/executor-resolution.test.ts` **(NEW)** — resolution + no-cross-routing tests.

## Existing Interfaces to Consume

**Executor contract** (`packages/runtime/src/tool-executor.ts`):

```typescript
export type ToolCallResult = { ok: true; output: unknown } | { ok: false; error: string };
export type ToolCallContext = { sessionId: string; runId: string; userId?: string; metadata?: Record<string, unknown> };
export type ToolCall = { toolName: string; callId: string; arguments: unknown };
export interface ToolExecutor {
  execute(call: ToolCall, ctx: ToolCallContext, signal: AbortSignal): Promise<ToolCallResult>;
}
```

**Existing factory** (`packages/runtime/src/tool-executor-factory.ts`):

```typescript
export function createToolExecutor(agent: AgentRecord, opts: { authToken: string }): ToolExecutor {
  if (agent.toolRunnerUrl) {
    return new RemoteToolExecutor({ toolRunnerUrl: agent.toolRunnerUrl, authToken: opts.authToken });
  }
  return new LocalToolExecutor();
}
```

**`AgentEngineDeps` today** (`packages/runtime/src/types.ts`):

```typescript
export type AgentEngineDeps = {
  db: { messages: MessageRepo; runs: RunRepo; toolCalls: ToolCallRepo; sessions: SessionRepo; agents: AgentRepo };
  modelRegistry: ProviderRegistry;
  toolExecutor: ToolExecutor;     // <-- replace this
  tracer?: Tracer;
  logger?: Logger;
};
```

**`AgentEngine.run` today** (`packages/runtime/src/engine.ts`) already loads `agentConfig = await this.deps.db.agents.getById(session.agentId)` and builds `ctx = { sessionId, runId, agentConfig, abortSignal, iterationCount }` before `yield* runAgentLoop(ctx, this.deps, userMessage, this.options)`.

**Loop call site today** (`packages/runtime/src/loop.ts`):

```typescript
const result = await deps.toolExecutor.execute(
  call,
  { sessionId: ctx.sessionId, runId: ctx.runId },
  ctx.abortSignal,
);
```

**Server composition today** (`apps/server/src/container.ts`):

```typescript
const toolExecutor = new LocalToolExecutor();
const engine = new AgentEngine({ db: { ... }, modelRegistry, toolExecutor });
```

## Design Notes

- **Resolver interface** — protocol-neutral so a future `McpToolExecutor` can be selected without touching sessions, the loop, or persistence:
  ```typescript
  export interface ToolExecutorResolver {
    resolve(agent: AgentRecord): Promise<ToolExecutor> | ToolExecutor;
  }
  ```
- **Resolution rules** (default implementation):
  1. `agent.toolRunnerUrl` is a non-empty string → `RemoteToolExecutor` for that URL, authenticated with a token from an injected `resolveAuthToken(agent)` callback. **Do NOT attempt to recover a raw workspace API key** — `ApiKeyRepo` stores and returns only SHA-256 hashes (`packages/db/src/repositories/api-key-repo.ts`), so raw keys are unrecoverable. For this workstream, `resolveAuthToken` returns an **interim** server-configured token (from `ENV_KEYS.INTERNAL_RUNNER_TOKEN`, or a static token minted from `RUNNER_TOKEN_SECRET`). WS-22 **replaces** this callback with short-lived per-call scoped credentials and modifies this resolver's contract accordingly — mark the interim wiring with `TODO(WS-22)`.
  2. No runner URL but the agent declares tools that are explicitly platform-internal/test → `LocalToolExecutor` with those handlers registered. Local execution must be **explicit**, not the silent default.
  3. Neither remote config nor a valid local registration for a tool-bearing agent → fail fast with a `SwiftAgentError(VALIDATION)` describing the missing execution configuration. (An agent with zero tools needs no executor and never reaches execution.)
- **Scoping / no cross-routing (SC-07)** — the executor is resolved from `ctx.agentConfig` at the start of each run and used only for that run. Two runs for two different agents resolve two independent executors bound to their own `toolRunnerUrl`. The resolver must not cache a single executor across agents in a way that leaks one agent's runner URL to another.
- **Caching** — the default resolver MAY memoize executors keyed by `(agentId, toolRunnerUrl)` to avoid rebuilding per run, but a change in `toolRunnerUrl` (agent re-registration) must produce a different executor. Never key the cache by anything coarser than the agent.

## Implementation Steps

1. **Resolver (`packages/runtime/src/tool-executor-resolver.ts`)**: Define `ToolExecutorResolver` (interface above). Implement `createToolExecutorResolver(opts: { resolveAuthToken: (agent: AgentRecord) => Promise<string> | string; registerLocalTools?: (agent: AgentRecord, local: LocalToolExecutor) => number })`. The `registerLocalTools` callback **returns the count** of handlers it registered (do not rely on inspecting `LocalToolExecutor` internals, whose `handlers` map is private). In `resolve(agent)`: if `agent.toolRunnerUrl`, build (or return memoized) a `RemoteToolExecutor` using `await resolveAuthToken(agent)`; else if `registerLocalTools` returns `> 0` for a fresh `LocalToolExecutor`, return that configured executor; else if the agent has tools, throw `SwiftAgentError(VALIDATION, 'No execution configuration for agent {agentId}')`; else return a no-op `LocalToolExecutor` (agent has no tools). Memoize keyed by `\`${agent.agentId}:${agent.toolRunnerUrl ?? 'local'}\``.

2. **Deps (`packages/runtime/src/types.ts`)**: Replace `toolExecutor: ToolExecutor` with `toolExecutorResolver: ToolExecutorResolver`. Import the resolver type.

3. **Engine (`packages/runtime/src/engine.ts`)**: After loading `agentConfig`, call `const toolExecutor = await this.deps.toolExecutorResolver.resolve(agentConfig)`. Pass this executor to the loop. Prefer adding `toolExecutor` to `RunContext` (extend `RunContext` with `toolExecutor: ToolExecutor`) so the loop reads the run-scoped executor rather than a deps-wide one — this makes cross-routing structurally impossible.

4. **RunContext (`packages/runtime/src/types.ts`)**: Add `toolExecutor: ToolExecutor` to `RunContext`.

5. **Loop (`packages/runtime/src/loop.ts`)**: Change `deps.toolExecutor.execute(...)` to `ctx.toolExecutor.execute(...)`. Remove any other reference to `deps.toolExecutor`.

6. **Barrel (`packages/runtime/src/index.ts`)**: Export `ToolExecutorResolver`, `createToolExecutorResolver`. Keep exporting `createToolExecutor` (still used by the resolver).

7. **Server composition (`apps/server/src/container.ts`)**: Remove `const toolExecutor = new LocalToolExecutor()`. Build a resolver:
   - Provide `resolveAuthToken(agent)` that returns an **interim** server-configured token (from `ENV_KEYS.INTERNAL_RUNNER_TOKEN` in config; add the env key to `packages/shared/src/config.ts` if absent). Do NOT read `apiKeyRepo` — raw keys are unrecoverable. Add a `TODO(WS-22)` note that this is replaced by scoped per-call credentials.
   - Pass `toolExecutorResolver` into `new AgentEngine({ db, modelRegistry, toolExecutorResolver })`.
   - Keep the `Container` shape otherwise unchanged.

8. **Cross-routing guard test hook**: Ensure the resolver never mutates a shared `LocalToolExecutor` registry across agents — each remote executor is bound to exactly one `toolRunnerUrl`.

## Tests

1. **Resolve remote**: agent with `toolRunnerUrl:'https://runner.a'` → `resolve` returns a `RemoteToolExecutor` whose outbound calls hit `runner.a` (assert via mock fetch).
2. **Resolve local explicit**: agent without a runner URL but with a registered internal tool handler → returns a `LocalToolExecutor` that executes the handler.
3. **Fail fast**: tool-bearing agent with no runner URL and no local registration → `resolve` throws `SwiftAgentError(VALIDATION)`.
4. **No-op for tool-less agent**: agent with `tools: []` and no runner URL → resolves without throwing; execution path is never reached.
5. **No cross-routing (SC-07)**: build two agents A (`runner.a`) and B (`runner.b`); resolve both; execute a call through each; assert A's executor only ever calls `runner.a` and B's only `runner.b` — even when resolved/executed interleaved.
6. **Re-registration changes executor**: resolve agent with `runner.a`, then resolve the same `agentId` after `toolRunnerUrl` changes to `runner.b` → second executor targets `runner.b` (cache keyed by url).
7. **Engine wiring**: `AgentEngine.run` with a resolver deps resolves the executor from the run's agent and the loop uses `ctx.toolExecutor` (assert executor invoked with correct `runId`).
8. **Server composition**: `buildContainer` builds an engine backed by a resolver, not a fixed `LocalToolExecutor` (assert no `LocalToolExecutor` singleton is shared).

## Acceptance Criteria

1. A `ToolExecutorResolver` exists in `@swiftagent/runtime`, is protocol-neutral, and maps an `AgentRecord` to the correct `ToolExecutor`.
2. Agents with a `toolRunnerUrl` resolve to `RemoteToolExecutor`; explicit internal/test tools resolve to `LocalToolExecutor`; missing/invalid execution config for a tool-bearing agent fails fast before invocation.
3. `AgentEngineDeps` no longer carries a fixed `toolExecutor`; the executor is resolved per run and carried on `RunContext`, and the loop uses `ctx.toolExecutor`.
4. `apps/server` no longer unconditionally constructs a `LocalToolExecutor`; it composes a resolver.
5. Two agents with different runner configurations execute against their own runners with no cross-routing, verified under interleaved execution (SC-07).
6. `pnpm exec tsc --noEmit` and `pnpm exec eslint . --quiet` pass; new resolution tests pass.
