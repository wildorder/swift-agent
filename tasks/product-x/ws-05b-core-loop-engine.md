# WS-05b: Core Loop, Engine & Memory

## Goal

Implement the `AgentEngine`, the core async generator loop (message → model → tool → model → response), the `ContextBuilder` for assembling model context with memory strategies, and the memory strategy implementations. This workstream consumes the `ToolExecutor` interface (WS-05a) and `ModelProvider` interface (WS-04a) as injected dependencies.

## Dependencies

- WS-03
- WS-04a
- WS-05a

## Package

`packages/runtime`

## Files Touched

- `packages/runtime/src/types.ts`
- `packages/runtime/src/engine.ts`
- `packages/runtime/src/session-lock.ts`
- `packages/runtime/src/loop.ts`
- `packages/runtime/src/context-builder.ts`
- `packages/runtime/src/memory/strategy.ts`
- `packages/runtime/src/memory/last-n.ts`
- `packages/runtime/src/memory/summary.ts`
- `packages/runtime/src/index.ts`

## Implementation Steps

1. **Types (`types.ts`)**: Define `AgentEngineDeps`: `{ db: { messages: MessageRepo; runs: RunRepo; toolCalls: ToolCallRepo; sessions: SessionRepo }; modelRegistry: ProviderRegistry; toolExecutor: ToolExecutor; tracer?: Tracer; logger?: Logger }`. Define `AgentEngineOptions`: `{ maxToolIterations?: number; toolTimeoutMs?: number; memoryStrategy?: 'last_n' | 'summary'; lastN?: number }` with defaults (10, 30000, 'last_n', 50). Define `RunContext`: `{ sessionId: string; runId: string; agentConfig: AgentRecord; abortSignal: AbortSignal; iterationCount: number }`.

2. **Memory strategy interface (`memory/strategy.ts`)**: `export interface MemoryStrategy { trim(messages: MessageRecord[]): MessageRecord[] }`. Export `MemoryStrategyName = 'last_n' | 'summary'`. Export `createMemoryStrategy(name: MemoryStrategyName, options: { lastN?: number }): MemoryStrategy`.

3. **Last-N strategy (`memory/last-n.ts`)**: `export class LastNMemoryStrategy implements MemoryStrategy`. Constructor takes `{ maxMessages: number }` (default 50). `trim(messages)`: return the last `maxMessages` from the array. System messages are excluded from the count — they're injected separately by the `ContextBuilder`. Preserve ordering.

4. **Summary strategy stub (`memory/summary.ts`)**: `export class SummaryMemoryStrategy implements MemoryStrategy`. `trim()` passes through unchanged with a logged warning that summary is not yet implemented. This is explicitly a Phase 2 feature — no model calls for summarization in MVP.

5. **ContextBuilder (`context-builder.ts`)**: Class `ContextBuilder`. Constructor `(agent: AgentRecord, memory: MemoryStrategy)`. Method `build(history: MessageRecord[]): ModelMessage[]`:
   - Start with system message from `agent.systemPrompt` (if non-empty) as `{ role: 'system', content: agent.systemPrompt }`.
   - Apply memory strategy to trim `history`.
   - Map each `MessageRecord` to `ModelMessage`:
     - `user` / `assistant` messages → straightforward mapping.
     - `tool` role messages → map to `{ role: 'tool', content, toolCallId }` by parsing the stored `content` or metadata to extract `toolCallId` linkage (align with how WS-03/WS-05a persist tool results).
   - Return the assembled `ModelMessage[]` array ready for `ModelRequest.messages`.

6. **Core loop (`loop.ts`)**: Export `async function* runAgentLoop(ctx: RunContext, deps: AgentEngineDeps, userContent: string): AsyncGenerator<ChatEvent>`:
   - **Step 1**: Persist user message via `deps.db.messages.create({ sessionId, role: 'user', content: userContent, runId: ctx.runId })`.
   - **Step 2**: Yield `{ type: 'message_started', messageId, runId, sessionId }`.
   - **Step 3**: Create `Run` via `deps.db.runs.create({ runId, sessionId, status: 'running', model: ctx.agentConfig.modelConfig.model })`.
   - **Step 4 — Iteration loop** (while `ctx.iterationCount < maxToolIterations`):
     - Load message history via `deps.db.messages.listBySession(sessionId)`.
     - Build context via `ContextBuilder.build(history)`.
     - Resolve model provider via `deps.modelRegistry.resolveForModel(agent.modelConfig.model)`.
     - Call `provider.generate({ model: modelId, messages: context, tools: agentToolSchemas, signal: ctx.abortSignal })`.
     - Buffer assistant text. For each `ModelStreamChunk`:
       - `token` → append to buffer, yield `{ type: 'token', text, runId, sessionId }`.
       - `tool_call` → yield `{ type: 'tool_call_started', callId, runId, sessionId, toolName }`. Create `ToolCall` record (status: started). Execute via `deps.toolExecutor.execute(call, { sessionId, runId }, signal)`. Update `ToolCall` record (status: completed/failed, output). Yield `{ type: 'tool_call_completed', callId, runId, sessionId, toolName, status }`. Persist tool result as a `MessageRecord` (role: tool). Increment `ctx.iterationCount`.
       - `finish` → break inner stream loop.
     - If no tool calls occurred in this iteration: we're done. Break outer loop.
     - If tool calls occurred: continue outer loop (re-call model with updated context).
   - **Step 5 — Completion**: Persist assistant message (buffered text). `deps.db.runs.complete(runId, tokenUsage)`. Yield `{ type: 'message_completed', messageId, runId, sessionId }`.
   - **Step 6 — Max iterations**: If loop exits due to `maxToolIterations`, persist what we have, mark run failed, yield `{ type: 'run_failed', runId, sessionId, code: 'MAX_ITERATIONS', message }`.
   - **Error handling**: Wrap entire loop in try/catch. On error: `deps.db.runs.fail(runId)`. Yield `{ type: 'run_failed', runId, sessionId, code, message }`.

7. **Session lock (`session-lock.ts`)**: Class `SessionLock` implementing per-session single-flight enforcement. Internal `Map<sessionId, { runId: string; abort: AbortController }>` tracking the currently active run per session. Methods:
   - `acquire(sessionId: string, runId: string): void` — if session already has an active run, throw `SwiftAgentError` with code `RUN_IN_PROGRESS` (include the existing `runId` in the error for diagnostics). Otherwise, store the entry.
   - `release(sessionId: string, runId: string): void` — remove the entry only if it matches the given `runId` (guards against stale releases).
   - `isActive(sessionId: string): boolean` — returns whether a run is in-flight for the session.
   This prevents two concurrent `engine.run()` calls on the same session from producing interleaved, incoherent conversation state (e.g., two tabs sending messages simultaneously). The gateway surfaces `RUN_IN_PROGRESS` as a structured error event to the client so the frontend can show "waiting for current response" UX.

8. **AgentEngine (`engine.ts`)**: Class `AgentEngine`. Constructor `(deps: AgentEngineDeps, options?: AgentEngineOptions)`. Holds a `SessionLock` instance. Method `run(sessionId: string, userMessage: string, signal?: AbortSignal): AsyncGenerator<ChatEvent>`:
   - **Acquire session lock** via `this.sessionLock.acquire(sessionId, runId)`. If `RUN_IN_PROGRESS`, throw immediately (gateway catches and sends error event to client).
   - Validate session exists and is `active` via `deps.db.sessions.getById(sessionId)`.
   - Load agent config via session's `agentId`.
   - Resolve `ToolExecutor` — the executor is passed in via `deps.toolExecutor` (already configured for local or remote by the caller/container).
   - Build `ContextBuilder` with agent config and resolved memory strategy.
   - Generate `runId` via `generateRunId()` from `@swiftagent/shared`.
   - Create `RunContext` with merged `AbortSignal`.
   - Delegate to `runAgentLoop(ctx, deps, userMessage)` and yield all events.
   - **Release session lock** in a `finally` block: `this.sessionLock.release(sessionId, runId)` — ensures cleanup on success, failure, or cancellation.

9. **Package exports (`index.ts`)**: Export `AgentEngine`, `SessionLock`, `ContextBuilder`, `MemoryStrategy`, `LastNMemoryStrategy`, `SummaryMemoryStrategy`, `createMemoryStrategy`, `runAgentLoop`, and all types from `types.ts`. Re-export `ToolExecutor`, `LocalToolExecutor`, `RemoteToolExecutor`, `createToolExecutor` from WS-05a files.

## Tests

1. **Happy path**: Mock model yields tokens + finish (no tool calls). Assert: user message persisted, run created + completed, assistant message persisted, events: `message_started` → `token`* → `message_completed`.
2. **Single tool round-trip**: Mock model yields tool_call first round, then tokens + finish second round. Assert: `tool_call_started` → `tool_call_completed` events, tool call record created, second model call receives tool result in context.
3. **Multiple sequential tools**: Two tool calls across iterations. Assert ordering, correct DB records, context grows with each tool result.
4. **Tool failure**: Mock executor returns `{ ok: false }`. Assert `tool_call_completed` reflects failure status. Document and test whether the run continues or fails.
5. **Max iterations**: Mock model always returns tool_call. Assert loop stops at `maxToolIterations` with `run_failed` event with code `MAX_ITERATIONS`.
6. **Memory last-N**: History of 100 messages, lastN=10. Assert context builder produces system message + 10 most recent messages.
7. **Summary stub**: `SummaryMemoryStrategy.trim()` passes through with warning log (no error).
8. **Cancellation**: Abort signal mid-token stream. Assert run marked failed, `run_failed` event emitted, no orphaned `running` run records.
9. **Session validation**: Run against non-existent or closed session. Assert error before any events.
10. **Context builder**: System prompt injected first, tool messages mapped with `toolCallId`, message ordering preserved after trim.
11. **Session lock — concurrent rejection**: Two `engine.run()` calls on the same `sessionId` — second throws `RUN_IN_PROGRESS` before persisting anything.
12. **Session lock — release on success**: After a run completes, a new run on the same session succeeds.
13. **Session lock — release on failure**: If the run fails or is cancelled, the lock is released (subsequent run succeeds).
14. **Session lock — cross-session independence**: Concurrent runs on different sessions both succeed.

## Acceptance Criteria

1. The engine executes the full loop: persist user message → run → model stream → [tool → model]* → persist assistant → complete run, emitting `ChatEvent` types in order.
2. Token streaming yields `token` events for each chunk from the model provider.
3. Tool calls create and update `ToolCall` records; tool results appear in subsequent model context.
4. `last_n` memory strategy limits history as configured; `summary` is stubbed without breaking imports.
5. Max tool iterations and tool timeouts are enforced; infinite loops cannot occur.
6. Failures update `Run` to `failed` and emit `run_failed` with actionable error payload.
7. `AbortSignal` cancels the run and leaves persisted state consistent (no orphaned `running` runs).
8. Concurrent `engine.run()` calls on the same session are rejected with `RUN_IN_PROGRESS` error — no interleaved conversation state is possible. The lock is always released in `finally` (success, failure, or cancellation).
