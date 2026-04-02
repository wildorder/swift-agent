# WS-04b: Provider Implementations (OpenAI, Anthropic, Google)

## Goal

Implement the three concrete `ModelProvider` adapters — OpenAI, Anthropic, and Google (Gemini) — that conform to the interface and types defined in WS-04a. Each provider normalizes its SDK's streaming API into the unified `ModelStreamChunk` sequence with correct token streaming, tool call argument assembly, finish reason mapping, usage extraction, error normalization, and cancellation support.

## Dependencies

- WS-04a

## Package

`packages/models`

## Files Touched

- `packages/models/src/providers/openai.ts`
- `packages/models/src/providers/anthropic.ts`
- `packages/models/src/providers/google.ts`
- `packages/models/src/providers/index.ts` (update barrel)

## Implementation Steps

1. **OpenAI provider (`providers/openai.ts`)**: Export `createOpenAIProvider(config: ProviderConfig): ModelProvider`. Use the official `openai` SDK. Implement `generate` as an async generator:
   - Call `client.chat.completions.create({ model, messages, tools, stream: true, stream_options: { include_usage: true } })` with mapped messages and tool schemas.
   - Map `ModelMessage` → OpenAI message format (role, content, tool_calls, tool_call_id).
   - Map `ToolSchema` → OpenAI function tool format.
   - For each streamed chunk: if `delta.content` exists, yield `{ type: 'token', text }`. If `delta.tool_calls` exists, accumulate by `index` — merge `id`, `function.name`, append `function.arguments` strings until the tool call is complete.
   - On tool call completion (stream ends or next tool_call index): `JSON.parse` the assembled arguments, yield `{ type: 'tool_call', toolName, callId, arguments }`.
   - On stream end: extract `finish_reason` and `usage` from final chunk, yield `{ type: 'finish', finishReason, usage: { inputTokens, outputTokens, totalTokens } }`.
   - Pass `signal` via `mergeSignals()` to the SDK's `signal` option. On abort, let the generator terminate cleanly.
   - Wrap SDK errors via `normalizeError(e, 'openai')`. Map status 429 → `retryable: true`.

2. **Anthropic provider (`providers/anthropic.ts`)**: Export `createAnthropicProvider(config: ProviderConfig): ModelProvider`. Use `@anthropic-ai/sdk`. Implement `generate`:
   - Call `client.messages.stream({ model, messages, tools, max_tokens, system })` with mapped inputs.
   - Map `ModelMessage` → Anthropic format. System message extracted separately (Anthropic uses a `system` parameter, not a system role message).
   - Map `ToolSchema` → Anthropic tool format (`name`, `description`, `input_schema`).
   - For each streaming event: `content_block_delta` with `type: 'text_delta'` → yield `{ type: 'token', text: delta.text }`. `content_block_start` with `type: 'tool_use'` → begin buffering tool call (capture `id` as `callId`, `name` as `toolName`). `content_block_delta` with `type: 'input_json_delta'` → append to input buffer. `content_block_stop` for tool_use block → parse assembled JSON, yield `{ type: 'tool_call', toolName, callId, arguments }`.
   - On `message_delta`: extract `stop_reason` and `usage`. Yield `{ type: 'finish', finishReason: stop_reason, usage: { inputTokens, outputTokens } }`.
   - Pass `signal` to the SDK. Wrap errors via `normalizeError(e, 'anthropic')`. Map status 429 and 529 → `retryable: true`.

3. **Google provider (`providers/google.ts`)**: Export `createGoogleProvider(config: ProviderConfig): ModelProvider`. Use `@google/generative-ai`. Implement `generate`:
   - Create `GenerativeModel` with model name. Call `generateContentStream({ contents, tools })` with mapped inputs.
   - Map `ModelMessage` → Google `Content` format (role: 'user'/'model', parts).
   - Map `ToolSchema` → Google `FunctionDeclaration` format.
   - For each streamed chunk: if text part exists, yield `{ type: 'token', text }`. If `functionCall` part exists, yield `{ type: 'tool_call', toolName: functionCall.name, callId: generated_id, arguments: functionCall.args }` (Google delivers function calls as complete objects, not streamed deltas — no assembly needed).
   - On stream end: extract `finishReason` from candidate, extract `usageMetadata` for token counts. Yield `{ type: 'finish', finishReason, usage }`.
   - Cancellation via `AbortSignal` if supported by the SDK; otherwise manual stream termination.
   - Wrap errors via `normalizeError(e, 'google')`.

4. **Providers barrel (`providers/index.ts`)**: Export `createOpenAIProvider`, `createAnthropicProvider`, `createGoogleProvider`. Re-export from package index.

## Tests

1. **OpenAI mock**: Mock the `openai` SDK streaming iterator. Emit text deltas split across multiple chunks, then a tool_call with arguments split across chunks, then finish with usage. Assert yielded sequence: `token`* → `tool_call` (with fully assembled arguments object) → `finish` with correct usage.
2. **OpenAI — text only**: Mock stream with only text deltas and finish. Assert: `token`* → `finish`, no `tool_call`.
3. **OpenAI — multiple tool calls**: Two tool calls in one response. Assert both are yielded with correct `callId` and `toolName`.
4. **Anthropic mock**: Mock message streaming events. Emit `content_block_delta` text events, then `content_block_start` tool_use, `input_json_delta` chunks, `content_block_stop`, then `message_delta` with usage. Assert: `token`* → `tool_call` → `finish`.
5. **Google mock**: Mock `generateContentStream`. Emit text chunk then function call chunk. Assert: `token`* → `tool_call` (arguments already complete) → `finish`.
6. **Equivalence**: For a scripted "user says hello, model responds with text" fixture, all three providers produce `token`* → `finish` with concatenated text matching expected output.
7. **Errors**: Inject SDK-specific errors for each provider; assert all produce `ModelError` with correct `provider` field and `retryable` flag.
8. **Timeout**: Mock slow stream; assert `AbortSignal` triggers and generator completes without hanging.
9. **Cancellation**: User abort mid-stream; assert no further chunks yielded after abort.

## Acceptance Criteria

1. All three providers implement `ModelProvider` and yield identical `ModelStreamChunk` discriminant shapes for equivalent logical inputs.
2. Tool calls are fully assembled before yielding — no partial JSON arguments in `tool_call` chunks.
3. Token usage is captured on the `finish` chunk whenever the upstream API exposes it.
4. Provider-specific failures are normalized to `ModelError` with stable codes.
5. `AbortSignal` (user + timeout) reliably cancels in-flight requests without resource leaks.
6. Each provider is independently testable with mocked SDK — no live API calls in unit tests.
