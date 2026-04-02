# WS-05a: Tool Executor

## Goal

Implement the `ToolExecutor` interface and its two concrete implementations — `LocalToolExecutor` (in-process handlers) and `RemoteToolExecutor` (HTTP to customer's tool runner) — plus the factory that selects the correct mode based on agent config. This is a self-contained, independently testable unit that the core runtime loop (WS-05b) imports as a dependency.

## Dependencies

- WS-01
- WS-02

## Package

`packages/runtime`

## Files Touched

- `packages/runtime/src/tool-executor.ts`
- `packages/runtime/src/tool-executor-local.ts`
- `packages/runtime/src/tool-executor-remote.ts`
- `packages/runtime/src/tool-executor-factory.ts`

## Implementation Steps

1. **Interface and types (`tool-executor.ts`)**: Define `ToolCallResult = { ok: true; output: unknown } | { ok: false; error: string }`. Define `ToolCallContext = { sessionId: string; runId: string; userId?: string; metadata?: Record<string, unknown> }`. Export `interface ToolExecutor { execute(call: { toolName: string; callId: string; arguments: unknown }, ctx: ToolCallContext, signal: AbortSignal): Promise<ToolCallResult> }`. This file contains only the interface and shared types — no implementation.

2. **LocalToolExecutor (`tool-executor-local.ts`)**: Class `LocalToolExecutor implements ToolExecutor`. Internal `Map<string, ToolHandler>` where `ToolHandler = (input: unknown, ctx: ToolCallContext) => Promise<unknown>`. Methods:
   - `registerTool(name: string, handler: ToolHandler): void` — stores handler; duplicate name throws.
   - `execute(call, ctx, signal)`: Look up handler by `call.toolName`. If not found, return `{ ok: false, error: 'Unknown tool: {toolName}' }`. If found, execute with timeout: `Promise.race([handler(call.arguments, ctx), timeoutPromise])`. On success, return `{ ok: true, output: result }`. On timeout, return `{ ok: false, error: 'Tool execution timed out after {ms}ms' }`. On handler throw, return `{ ok: false, error: err.message }`. Respect `signal` — if aborted before completion, return `{ ok: false, error: 'Aborted' }`.
   - Constructor accepts `{ timeoutMs?: number }` (default 30000).

3. **RemoteToolExecutor (`tool-executor-remote.ts`)**: Class `RemoteToolExecutor implements ToolExecutor`. Constructor takes `{ toolRunnerUrl: string; authToken: string; timeoutMs?: number; maxRetries?: number; retryDelayMs?: number }` (defaults: 30000ms timeout, 1 retry, 1000ms delay). The `authToken` is the workspace API key — sent as `Authorization: Bearer {authToken}` on every outbound request so the customer's tool runner can verify calls originate from Swift Agent (the SDK's tool runner validates this header; see WS-08). Implements `execute`:
   - Build URL: `{toolRunnerUrl}/tools/{call.toolName}`
   - Send `POST` with JSON body `{ input: call.arguments, context: ctx }` and header `Authorization: Bearer {authToken}` using `fetch` or `undici`.
   - Pass `signal` merged with timeout via `AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])`.
   - On HTTP 2xx: parse response body. If `{ result }` field exists, return `{ ok: true, output: result }`. If `{ error }` field exists, return `{ ok: false, error: error.message || error }`.
   - On HTTP 4xx: return `{ ok: false, error: 'Tool runner returned {status}: {body}' }` — no retry (client error).
   - On HTTP 5xx or network error: retry up to `maxRetries` times with `retryDelayMs` delay between attempts. After exhausting retries, return `{ ok: false, error: 'Tool runner unreachable after {attempts} attempts: {lastError}' }`.
   - On timeout/abort: return `{ ok: false, error: 'Tool execution timed out' }` or `{ ok: false, error: 'Aborted' }`.

4. **Factory (`tool-executor-factory.ts`)**: Export `createToolExecutor(agent: AgentRecord, opts: { authToken: string }): ToolExecutor`. Import `AgentRecord` from `@swiftagent/shared`. If `agent.toolRunnerUrl` is a non-empty string, return `new RemoteToolExecutor({ toolRunnerUrl: agent.toolRunnerUrl, authToken: opts.authToken })`. Otherwise return `new LocalToolExecutor()`. The `authToken` is the workspace API key, resolved by the caller (service composition layer, WS-11) from the agent's workspace. The factory is the only place that decides which mode — consumers always work with the `ToolExecutor` interface.

## Tests

1. **LocalToolExecutor — happy path**: Register handler, execute with valid input → returns `{ ok: true, output }` with correct output.
2. **LocalToolExecutor — handler receives context**: Assert `ctx.sessionId`, `ctx.runId` are passed through to the handler.
3. **LocalToolExecutor — unregistered tool**: Execute unknown tool name → `{ ok: false, error }` containing the tool name.
4. **LocalToolExecutor — handler throws**: Handler throws Error → `{ ok: false, error: err.message }`.
5. **LocalToolExecutor — timeout**: Handler delays beyond configured timeout → `{ ok: false, error }` mentioning timeout duration.
6. **LocalToolExecutor — abort signal**: Pre-aborted signal → immediate `{ ok: false, error: 'Aborted' }`.
7. **RemoteToolExecutor — success**: Mock HTTP server returns `{ result: { temp: 72 } }` → `{ ok: true, output: { temp: 72 } }`. Assert outbound request includes `Authorization: Bearer {authToken}` header.
8. **RemoteToolExecutor — error payload**: Mock server returns `{ error: { message: 'not found' } }` with 200 → `{ ok: false, error }`.
9. **RemoteToolExecutor — HTTP 400**: Mock server returns 400 → `{ ok: false }`, no retry.
10. **RemoteToolExecutor — retry on 500**: First request returns 500, second returns 200 with result → asserts two requests made, final result is ok.
11. **RemoteToolExecutor — retry exhausted**: Both attempts return 500 → `{ ok: false, error }` mentioning attempt count.
12. **RemoteToolExecutor — timeout**: Mock server hangs → returns error after configured timeout.
13. **RemoteToolExecutor — network failure**: Connection refused → `{ ok: false, error }` with actionable message.
14. **Factory — remote**: Agent with `toolRunnerUrl: "http://localhost:4000"` → executor makes HTTP calls (verify via mock).
15. **Factory — local**: Agent with `toolRunnerUrl: null` → executor uses in-process handlers.

## Acceptance Criteria

1. `ToolExecutor` is a clean interface with `execute()` returning `ToolCallResult` — no implementation details leak.
2. `LocalToolExecutor` registers and executes in-process handlers with timeout and error handling.
3. `RemoteToolExecutor` sends `POST {toolRunnerUrl}/tools/{name}` with `{ input, context }` body and `Authorization: Bearer` header, parses responses, retries on 5xx/network errors.
4. `createToolExecutor(agent)` returns `RemoteToolExecutor` when `toolRunnerUrl` is set, `LocalToolExecutor` otherwise.
5. Both implementations respect `AbortSignal` for cancellation.
6. All error paths return structured `{ ok: false, error: string }` — no thrown exceptions from `execute()`.
