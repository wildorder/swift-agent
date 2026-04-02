# WS-04a: Model Types, Interface & Registry

## Goal

Define the `ModelProvider` interface, all model-layer types (`ModelRequest`, `ModelStreamChunk`, `ModelMessage`, `TokenUsage`, `ToolSchema`, `ProviderConfig`, `ModelError`), the model string parser, and the provider registry in `packages/models` — establishing the contract that all provider implementations (WS-04b) will conform to and that the runtime engine (WS-05b) will consume.

## Dependencies

- WS-01
- WS-02

## Package

`packages/models`

## Files Touched

- `packages/models/src/types.ts`
- `packages/models/src/provider.ts`
- `packages/models/src/parser.ts`
- `packages/models/src/registry.ts`
- `packages/models/src/providers/index.ts`
- `packages/models/src/index.ts`

## Implementation Steps

1. **Core types (`types.ts`)**: Define `ToolSchema` — a subset of JSON Schema compatible with all three provider SDKs (object with `name`, `description`, `parameters`). Define `ToolCallMessage` for assistant messages with parallel tool calls: `{ callId: string; toolName: string; arguments: unknown }`. Define `ModelMessage`: `{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string; toolCallId?: string; toolCalls?: ToolCallMessage[] }`. Define `ModelRequest`: `{ model: string; messages: ModelMessage[]; tools?: ToolSchema[]; temperature?: number; maxTokens?: number; signal?: AbortSignal }`. Define `TokenUsage`: `{ inputTokens?: number; outputTokens?: number; totalTokens?: number }` aligned with WS-02. Define discriminated union `ModelStreamChunk`: `{ type: 'token'; text: string } | { type: 'tool_call'; toolName: string; callId: string; arguments: unknown } | { type: 'finish'; finishReason: string; usage: TokenUsage }`.

2. **Provider config**: Define `ProviderConfig`: `{ apiKey: string; baseUrl?: string; defaultModel?: string; timeout?: number }`. Each provider factory (WS-04b) will accept `ProviderConfig`. Document the layered resolution: (a) explicit config passed at registration/factory time (tests), (b) environment variables via `loadConfig()` from `@swiftagent/shared` using `ENV_KEYS`.

3. **ModelError**: Define `class ModelError extends Error` with `provider: string`, `statusCode?: number`, `retryable: boolean`. Export `normalizeError(e: unknown, provider: string): ModelError` — a shared helper that provider implementations use to wrap SDK-specific errors into a unified type.

4. **Interface (`provider.ts`)**: `export interface ModelProvider { generate(request: ModelRequest): AsyncGenerator<ModelStreamChunk, void, undefined> }`. Document the chunk ordering contract: many `token` chunks, zero or more `tool_call` chunks (each with fully assembled `arguments`), exactly one terminal `finish` per model round.

5. **Parser (`parser.ts`)**: `parseModelString(model: string): { provider: 'openai' | 'anthropic' | 'google'; model: string }` — split on first `/`, validate non-empty segments, throw `ModelError` for malformed strings. Export inverse `formatModelString(provider, model): string` for logs. Support common aliases documented in comments.

6. **Registry (`registry.ts`)**: `class ProviderRegistry`. Methods: `register(providerId: string, factory: (config: ProviderConfig) => ModelProvider): void` — stores factory; `getProvider(providerId: string): ModelProvider` — instantiates via factory with resolved config (explicit or env-based); `resolveForModel(modelString: string): { provider: ModelProvider; modelId: string }` — parses model string, gets provider, returns provider-local model name. Provider API keys resolved from `ENV_KEYS` (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`). Missing key for a requested provider throws `ModelError` naming the expected env var.

7. **Timeout/cancellation helpers**: Export `mergeSignals(userSignal?: AbortSignal, timeoutMs?: number): AbortSignal` — combines user `AbortSignal` with `AbortSignal.timeout()` via `AbortSignal.any()`. Used by provider implementations.

8. **Providers barrel (`providers/index.ts`)**: Stub file that will re-export provider factories after WS-04b. For now, export nothing or a placeholder comment.

9. **Package exports (`index.ts`)**: Export all types, `ModelProvider` interface, `ProviderRegistry`, `parseModelString`, `formatModelString`, `ModelError`, `normalizeError`, `mergeSignals`, and `ProviderConfig`.

## Tests

1. **Parser**: `openai/gpt-4o` → `{ provider: 'openai', model: 'gpt-4o' }`; `anthropic/claude-3-5-sonnet` → correct parse; `google/gemini-1.5-pro` → correct parse; empty string throws; missing `/` throws; `unknown/model` is parseable (registry decides if provider exists).
2. **Registry**: Register a mock factory → `getProvider` returns a `ModelProvider`; `resolveForModel("openai/gpt-4o")` returns correct `modelId`; unregistered provider throws; missing API key throws with env var name in message.
3. **ModelError**: `normalizeError` wraps a generic error with provider name and `retryable: false`; wraps a known retryable error (e.g., status 429) with `retryable: true`.
4. **mergeSignals**: User abort triggers combined signal; timeout triggers combined signal; both undefined returns no-abort signal.
5. **Types compile**: All exported types are usable in downstream packages (compile check).

## Acceptance Criteria

1. `ModelProvider` interface and all model types are importable from `@swiftagent/models` with full IntelliSense.
2. `ModelStreamChunk` is a discriminated union narrowable via `switch (chunk.type)`.
3. Model string parser resolves provider and model correctly for all three vendors.
4. `ProviderRegistry` resolves API keys from env vars via shared config; missing keys produce errors naming the expected env var.
5. `ModelError` normalizes provider-specific failures into a stable error type with `provider`, `statusCode`, and `retryable`.
6. The package builds and type-checks without any concrete provider implementations — the interface is the contract, not the implementations.
