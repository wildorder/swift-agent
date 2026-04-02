# WS-09: Client SDKs (@swiftagent/react)

## Goal

Implement the client-side libraries for connecting to the WebSocket gateway: a vanilla JS `createChatSession` client and a `useAgentChat` React hook that aggregate streaming `ChatEvent`s into typed chat messages with correct status transitions, connection state, auto-reconnection, and queued sends while offline. The client SDK imports `ChatEvent` types from `@swiftagent/shared` (WS-02) to type the event stream and state reducer.

## Dependencies

- WS-02
- WS-06

## Package

`packages/react`

## Files Touched

- `packages/react/src/client.ts`
- `packages/react/src/hooks/use-agent-chat.ts`
- `packages/react/src/hooks/use-connection.ts`
- `packages/react/src/state.ts`
- `packages/react/src/types.ts`
- `packages/react/src/index.ts`

## Implementation Steps

1. **Types (`types.ts`)**: Import `ChatEvent` from `@swiftagent/shared`. Define `ChatMessage` — `{ id: string; role: "user" | "assistant" | "tool"; content: string; status: "pending" | "streaming" | "complete"; toolCalls?: ToolCallInfo[] }`. `ToolCallInfo` aligned with stream events. `ConnectionStatus` — `"connecting" | "connected" | "disconnected"`. `UseAgentChatResult`, `CreateChatSessionOptions` — `{ sessionId: string; token: string; websocketUrl?: string; reconnect?: { maxRetries: number; baseDelayMs: number } }`.

2. **createChatSession (`client.ts`)**: `export function createChatSession(opts: CreateChatSessionOptions): ChatSessionClient`. Build WebSocket URL from `websocketUrl` + token query or subprotocol (match gateway). Return object: `sendMessage(content: string): void` — queue if not connected, else send JSON `{ type: "send_message", content }`; `onEvent(handler: (event: ChatEvent) => void): () => void` — subscribe to parsed events, return unsubscribe; `disconnect(): void` — idempotent close; getter or observable `connectionStatus`. Implement exponential backoff reconnect (configurable max retries); flush queue on reconnect. Parse each frame with Zod or type guards; invalid frames call optional `onError`. Use browser `WebSocket` or `ws` in tests via injection factory `options.createWebSocket`.

3. **State reducer (`state.ts`)**: `export function chatReducer(state: ChatState, event: ChatAction): ChatState` where actions are discriminated by `ChatEvent` type plus internal `SEND_USER`, `RESET_ERROR`, etc. Transitions: **send** — append user message `pending`, `isStreaming: true`; **message_started** — append assistant placeholder `streaming`; **token** — append to current assistant `content`; **tool_call_started** — push/update `toolCalls`; **tool_call_completed** — mark tool call complete; **message_completed** — assistant `complete`, `isStreaming: false`; **run_failed** — set `lastError`, `isStreaming: false`. Keep stable `id` generation (uuid or server ids when present).

4. **useConnection (`hooks/use-connection.ts`)**: `export function useConnection(url: string | undefined, token: string | undefined, options?)` — wraps `createChatSession` lifecycle in `useEffect`, exposes `{ connectionStatus, lastError, reconnectAttempt }` for advanced consumers; used internally by `useAgentChat`.

5. **useAgentChat (`hooks/use-agent-chat.ts`)**: `export function useAgentChat({ sessionId, token, websocketUrl? }: UseAgentChatArgs): UseAgentChatResult`. Inside: `useReducer(chatReducer, initialState)`; subscribe to client `onEvent` and dispatch; `send(content)` calls client `sendMessage`; `useEffect` cleanup calls `disconnect()` on unmount. Return `{ messages, send, isStreaming, connectionStatus, lastError }`.

6. **Package build**: `package.json` — `peerDependencies: { react: ^18 || ^19 }`, `exports` for ESM + CJS (`tsup` or `unbuild`), `types` entry, `sideEffects: false`. Ensure `ChatEvent` types re-exported from entry.

7. **Index (`index.ts`)**: Export `createChatSession`, `useAgentChat`, `useConnection`, all public types.

## Tests

1. **createChatSession** (mock WebSocket): Connect lifecycle transitions `connecting` → `connected`; inbound frames parsed to `ChatEvent`; `sendMessage` emits correct JSON string.
2. **Reconnection**: Simulate close → expect backoff delays (mock timers) → reconnect; queued messages sent after reconnect.
3. **chatReducer**: For each `ChatEvent` type, assert state transitions and message list shape; `run_failed` clears streaming flag; multiple tokens concatenate.
4. **useAgentChat** (React Testing Library): Render hook with mock client factory → `send('hi')` → dispatch events → assert `messages` and `isStreaming`; unmount calls disconnect (mock verify).
5. **Cleanup**: Unmount clears subscriptions without leaking timers.

## Acceptance Criteria

1. `createChatSession` works in non-React environments and exposes `sendMessage`, `onEvent`, `disconnect`, and accurate `connectionStatus`.
2. Incoming JSON is validated and surfaced as typed `ChatEvent`; malformed data does not crash the client (error surfaced).
3. `useAgentChat` returns `messages`, `send`, `isStreaming`, `connectionStatus`, and `lastError` consistent with reducer behavior and the vision doc DX example.
4. User and assistant messages show correct `status` transitions through streaming and completion (including tool call sidecars).
5. Connection drops trigger exponential-backoff reconnection with configurable max retries; messages sent while disconnected are queued and flushed after reconnect.
6. The package ships as ESM + CJS with React as a peer dependency and exports all public types for consumers.
