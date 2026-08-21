# WS-20: Provider Tool-Calling Completion

## Goal

Close the tool-calling loop between persisted agent tools, model providers, and the runtime. Today the core loop hardcodes `tools: undefined` at the model call site, so no provider ever receives tool definitions and no model-driven tool call can be validated. This workstream sources the persisted `AgentRecord.tools` (WS-19), translates them into the provider-neutral `ToolSchema[]` the model layer already understands, passes them on every applicable model turn, enforces a registered-tool allowlist and JSON-schema argument validation before any execution, separates the provider-native call identifier from Swift Agent's own `tc_` identifier, fixes model-round iteration accounting, and emits `tool_call_started` only when a call becomes actionable. Provider adapters already translate `ToolSchema` and normalize streamed tool calls; this workstream verifies and contract-tests that translation and wires the runtime side.

## Traceability

- **SC-03** — OpenAI, Anthropic, and Google provider requests receive the registered tool definitions on every applicable model turn.
- **SC-04** — A model-emitted tool call is rejected before execution when its name is not registered or its input does not satisfy the persisted schema.
- **SC-05** — Provider-native call identifiers round-trip correctly while every persisted tool call uses a Swift Agent `tc_` identifier.

## Dependencies

- **WS-19** — `AgentRecord.tools` (`ToolDefinition[]` with `inputSchema`) is persisted and readable.
- **product-x WS-04b** — provider implementations (`createOpenAIProvider`, `createAnthropicProvider`, `createGoogleProvider`) and their `ToolSchema` translation + stream tool-call parsing.
- **product-x WS-05b** — the core loop (`runAgentLoop`) and `AgentEngine`.

## Context Files (Agent MUST read before implementing)

- `c:\dev\swift-agent\CLAUDE.md` — conventions.
- `c:\dev\swift-agent\packages\models\src\types.ts` — `ToolSchema`, `ModelRequest`, `ModelMessage`, `ToolCallMessage`, chunk union.
- `c:\dev\swift-agent\packages\models\src\provider.ts` — `ModelProvider` interface + chunk-ordering contract.
- `c:\dev\swift-agent\packages\models\src\providers\openai.ts` — tools mapping + stream tool-call parsing (provider `id`).
- `c:\dev\swift-agent\packages\models\src\providers\anthropic.ts` — tools mapping + `content_block.id` parsing.
- `c:\dev\swift-agent\packages\models\src\providers\google.ts` — `functionDeclarations` mapping + synthesized `callId`.
- `c:\dev\swift-agent\packages\runtime\src\loop.ts` — the model call site (`tools: undefined`) and tool-execution block.
- `c:\dev\swift-agent\packages\runtime\src\context-builder.ts` — how assistant/tool messages round-trip tool calls.
- `c:\dev\swift-agent\packages\runtime\src\types.ts` — `RunContext`, `AgentEngineOptions`, iteration defaults.
- `c:\dev\swift-agent\packages\shared\src\types\agent.ts` — `ToolDefinition` (WS-19).

## Package

`packages/models`, `packages/runtime`

## Files Touched

- `packages/runtime/src/tool-mapping.ts` **(NEW)** — map `ToolDefinition[]` → `ToolSchema[]`; build the allowlist/validator map.
- `packages/runtime/src/tool-validation.ts` **(NEW)** — allowlist + JSON-schema argument validation (Ajv), returning structured accept/reject results.
- `packages/runtime/src/loop.ts` **(MODIFY)** — pass tools to the model, validate calls, separate `tc_` vs provider call id, carry `toolName` for result correlation, fix iteration accounting, gate `tool_call_started`.
- `packages/runtime/src/context-builder.ts` **(MODIFY)** — round-trip the provider-native call id AND the tool name so tool results map back correctly across providers.
- `packages/runtime/src/index.ts` **(MODIFY)** — export new tool-mapping/validation helpers.
- `packages/runtime/package.json` **(MODIFY)** — add `ajv` (and `ajv-formats`) dependency.
- `packages/models/src/types.ts` **(MODIFY)** — add optional `toolName` to the tool-role `ModelMessage` so name-correlating providers (Google) can populate `functionResponse.name`.
- `packages/models/src/providers/google.ts` **(MODIFY)** — set `functionResponse.name` from the tool message's `toolName` (not the call id).
- `packages/models/src/providers/openai.ts` **(MODIFY, if needed)** — ensure the terminal `finish` chunk is always emitted and tool-call chunks carry the provider `id`.
- `packages/models/src/providers/__tests__/tools-contract.test.ts` **(NEW)** — cross-provider tool-translation + result-correlation contract tests.
- `packages/runtime/src/__tests__/tool-calling.test.ts` **(NEW)** — loop tool-passing, allowlist, validation, and id-separation tests.

## Existing Interfaces to Consume

**Model tool + request types** (`packages/models/src/types.ts`):

```typescript
export const ToolSchemaSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  parameters: z.record(z.unknown()),
}).strict();
export type ToolSchema = z.infer<typeof ToolSchemaSchema>;

export const ModelRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(ModelMessageSchema).min(1),
  tools: z.array(ToolSchemaSchema).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
}).strict();
export type ModelRequest = z.infer<typeof ModelRequestSchema> & { signal?: AbortSignal };

// Stream chunk union
export const ToolCallChunkSchema = z.object({
  type: z.literal('tool_call'),
  toolName: z.string().min(1),
  callId: z.string().min(1),   // provider-native id (OpenAI/Anthropic) or synthesized (Google)
  arguments: z.unknown(),
}).strict();
// plus TokenChunkSchema and FinishChunkSchema; finish always comes last
```

**Provider translation already exists** — each adapter only passes `tools` when `request.tools && request.tools.length > 0`:
- OpenAI `toOpenAITools(t)` → `{ type:'function', function:{ name, description, parameters } }`; stream accumulates deltas and yields `tool_call` chunks with the provider `id`.
- Anthropic `mapTool(t)` → `{ name, description, input_schema:{ type:'object', ...parameters } }`; yields `tool_call` with `content_block.id`.
- Google `toGoogleTools(t)` → `{ name, description, parameters }`; **synthesizes** `callId = \`tc_${nanoid()}\`` (provider returns none).

**Core loop model call site today** (`packages/runtime/src/loop.ts`):

```typescript
const stream = provider.generate({
  model: modelId,
  messages: context,
  tools: undefined, // Tool schemas would come from agent config — passed externally
  temperature: ctx.agentConfig.modelConfig.temperature,
  maxTokens: ctx.agentConfig.modelConfig.maxTokens,
  signal: ctx.abortSignal,
});
```

**Loop tool-execution block today** (`packages/runtime/src/loop.ts`) persists the assistant message as JSON `{ text, toolCalls:[{ callId, toolName, arguments }] }`, then for each tool: yields `tool_call_started`, creates the `ToolCall` record with `callId: tc.callId`, executes via `deps.toolExecutor`, updates the record, yields `tool_call_completed`, and persists a tool message `{ toolCallId: tc.callId, result }`. `ctx.iterationCount++` runs **once per executed tool call**.

**`RunContext`** (`packages/runtime/src/types.ts`): `{ sessionId; runId; agentConfig: AgentRecord; abortSignal: AbortSignal; iterationCount: number }`.

## Design Notes: `tc_` vs provider call id, and cross-provider result correlation (SC-05)

Providers correlate a tool result back to its request **differently**, and this MUST be handled correctly:

- **OpenAI / Anthropic** correlate by a provider-native **call id** (`tool_call_id` / `tool_use.id`). The result message must echo that id.
- **Google** correlates by **function name** (`functionResponse.name`), **not** an id — the current code at `packages/models/src/providers/google.ts` incorrectly sets `functionResponse.name` from `msg.toolCallId`, which is a bug this workstream fixes. Google's request stream also *synthesizes* a `tc_`-prefixed id purely because the wire format lacks one; that synthesized value is NOT a real correlation id.

Therefore, persist BOTH identifiers plus the tool name for every tool call, and let each provider adapter use whichever it needs:

- Generate a Swift Agent id `swiftCallId = generateToolCallId()` (`tc_…`) for **every** assembled tool call (accepted OR rejected — see step 4/5 ordering). This is the `ToolCall.callId` persisted in the DB and used in `tool_call_started` / `tool_call_completed` events.
- Retain the provider-native id (`chunk.callId`) as `providerCallId` and the `toolName` alongside each call in the assistant-message JSON and the tool-result message.
- On the next model turn, `ContextBuilder` produces a tool-role `ModelMessage` carrying both `toolCallId: providerCallId` and the new optional `toolName`. Id-correlating providers (OpenAI/Anthropic) use `toolCallId`; name-correlating providers (Google) use `toolName`.
- Never send a Swift Agent `tc_…` id to any provider as the correlation value.

To support name correlation, add an optional `toolName` field to the tool-role branch of `ModelMessageSchema` in `packages/models/src/types.ts` and update the Google adapter to read it.

## Implementation Steps

1. **Tool mapping (`packages/runtime/src/tool-mapping.ts`)**: Export `toModelToolSchemas(tools: ToolDefinition[]): ToolSchema[]` mapping each `{ name, description, inputSchema }` → `{ name, description, parameters: inputSchema }`. Export `buildToolIndex(tools: ToolDefinition[]): Map<string, { def: ToolDefinition; validate: ValidateFunction }>` keyed by tool name for O(1) allowlist checks, compiling each tool's `inputSchema` with a shared Ajv instance so validation (step 2) is O(1) at call time. Handle schema-compilation errors gracefully (store a sentinel that always reports `INVALID_ARGUMENTS`).

2. **Tool validation (`packages/runtime/src/tool-validation.ts`)**: Export `validateToolCall(index: Map<string, { def: ToolDefinition; validate: ValidateFunction }>, toolName: string, args: unknown): { ok: true } | { ok: false; code: 'UNKNOWN_TOOL' | 'INVALID_ARGUMENTS'; message: string }`. If `toolName` is absent from `index` → `UNKNOWN_TOOL`. Otherwise validate `args` against the tool's persisted JSON `inputSchema` using **Ajv** (add `ajv` and `ajv-formats` to `packages/runtime/package.json`). The persisted schema is produced by `zod-to-json-schema` with `target: 'openApi3'` (see `packages/sdk/src/tool.ts`), so it can contain nested objects, arrays, enums, and formats — a hand-rolled subset validator is insufficient for SC-04. Compile each tool's schema once (memoize `ValidateFunction` per tool in `buildToolIndex`, step 1) and reuse it. Configure Ajv with `{ strict: false, allErrors: true }` and register `ajv-formats` so OpenAPI-style schemas compile without throwing. On validation failure → `INVALID_ARGUMENTS` with an actionable message assembled from `ajv.errors`. If a schema fails to compile, treat calls to that tool as `INVALID_ARGUMENTS` with a schema-compilation message rather than crashing the run.

3. **Loop — pass tools (`packages/runtime/src/loop.ts`)**: Before the iteration loop, compute `const toolSchemas = toModelToolSchemas(ctx.agentConfig.tools)` and `const toolIndex = buildToolIndex(ctx.agentConfig.tools)`. At the model call site replace `tools: undefined` with `tools: toolSchemas.length > 0 ? toolSchemas : undefined`. This ensures every model turn for a tool-bearing agent receives the tools (SC-03) while tool-less agents keep sending `undefined`.

4. **Loop — id generation then validate (SC-04, SC-05)**: For **every** assembled `tool_call` chunk (before deciding accept/reject), generate `const swiftCallId = generateToolCallId()` so both accepted and rejected calls have a stable `tc_` identity. Then run `validateToolCall(toolIndex, tc.toolName, tc.arguments)`. On reject: persist a failed `ToolCall` under `swiftCallId` (so the failure is observable), emit `tool_call_started` then `tool_call_completed` with `status: 'failed'` using `swiftCallId`, append a tool-result message describing the rejection (carrying `providerCallId` + `toolName`) so the model can recover, and do NOT call the tool executor. On accept: proceed to execution using `swiftCallId`. (Use whichever executor reference the current loop holds — `deps.toolExecutor` today; WS-21 independently changes this to `ctx.toolExecutor`. Do not couple to WS-21.)

5. **Loop — id + name persistence (SC-05)**: Use `swiftCallId` for the `ToolCall` DB record `callId`, `tool_call_started.callId`, and `tool_call_completed.callId`. Keep `tc.callId` as `providerCallId` and `tc.toolName` as `toolName`. Persist the assistant-message JSON entries as `{ swiftCallId, providerCallId, toolName, arguments }` and each tool-result message as `{ swiftCallId, providerCallId, toolName, result }`.

6. **Loop — gate `tool_call_started`**: Emit `tool_call_started` only for calls that are actionable (passed validation OR are being recorded as rejected) — i.e. after a `tool_call` chunk is fully assembled from the stream, never on partial/`token` chunks. (The stream contract already delivers fully-assembled tool-call chunks, so the gate is: emit per assembled chunk, not per delta.)

7. **Loop — iteration accounting**: Change the counter so it reflects **model rounds**, not individual tool executions. Increment `ctx.iterationCount` once per model turn that produced tool calls (i.e. once per outer-loop pass that hits the tool branch), regardless of how many tools ran in that turn. Keep the `maxToolIterations` guard (default `DEFAULT_MAX_TOOL_ITERATIONS = 10`). Preserve the existing `MAX_ITERATIONS` `run_failed` behavior when the cap is hit. Document the semantic change in a comment.

8. **ContextBuilder + ModelMessage (`packages/runtime/src/context-builder.ts`, `packages/models/src/types.ts`)**: Add an optional `toolName: z.string().optional()` field to `ModelMessageSchema` (it already has `role`, `content`, `toolCallId?`, `toolCalls?`). Update `mapAssistantMessage` and `mapToolMessage` to read the new JSON shape (`swiftCallId` + `providerCallId` + `toolName`). Construct `ModelMessage.toolCalls[].callId` and the tool `ModelMessage.toolCallId` from `providerCallId`, and set `ModelMessage.toolName` from the persisted `toolName`. Maintain backward tolerance: if only a legacy single `callId` field is present, use it for `toolCallId` and derive `toolName` from the matching assistant tool call when available. This lets id-correlating providers use `toolCallId` and name-correlating providers use `toolName` (SC-05).

9. **Google adapter fix (`packages/models/src/providers/google.ts`)**: In the `tool`-role message mapping, set `functionResponse.name` from `msg.toolName ?? msg.toolCallId` (currently it uses `msg.toolCallId ?? ''`, which sends a synthesized id where Google expects the function name). This is required for Google tool-result round-tripping (SC-05).

10. **Provider verification (`packages/models/src/providers/*.ts`)**: Confirm each adapter always yields a terminal `finish` chunk (even when only tool calls occur) so `lastUsage`/round completion is well-defined. If OpenAI can end a tool-call stream without a `finish_reason` chunk, ensure a `finish` chunk is still emitted after the stream drains. Make minimal edits only where the contract is violated.

11. **Barrel (`packages/runtime/src/index.ts`)**: Export `toModelToolSchemas`, `buildToolIndex`, and `validateToolCall`.

## Tests

1. **Mapping**: `toModelToolSchemas([{ name, description, inputSchema:{type:'object'} }])` → `[{ name, description, parameters:{type:'object'} }]`.
2. **Provider contract — OpenAI/Anthropic/Google** (`tools-contract.test.ts`): given one `ToolSchema`, each adapter's request-builder includes the tool in provider-native shape; assert names/descriptions/parameters map correctly (mock provider clients).
3. **Loop passes tools (SC-03)**: fake provider records the `request.tools` it receives; run an agent with two persisted tools → provider sees both tools on the turn.
4. **Loop omits tools for tool-less agent**: agent with `tools: []` → provider receives `tools: undefined`.
5. **Allowlist reject (SC-04)**: model emits a `tool_call` for an unregistered name → executor is never called; a failed `ToolCall` is persisted; `tool_call_completed` has `status:'failed'`.
6. **Argument reject (SC-04)**: model emits a registered tool with args missing a `required` field → rejected before execution; failure recorded; executor not called.
7. **Valid call executes**: registered tool with valid args → executor invoked once; `ToolCall` persisted with a `tc_` `callId`.
8. **Id separation (SC-05)**: provider emits `tool_call` with provider id `call_abc`; assert persisted `ToolCall.callId` starts with `tc_`, events use the `tc_` id, and the next model turn's tool-result message carries `providerCallId: 'call_abc'` and `toolName`.
8b. **Rejected call has tc_ id**: an unknown/invalid tool call is persisted with a `tc_` `callId` and its events use that id (id is generated before validation).
8c. **Google name correlation (SC-05)**: with the Google adapter, a tool-result `ModelMessage` produces `functionResponse.name === toolName` (not the synthesized id); with OpenAI/Anthropic, the result echoes `toolCallId === providerCallId`.
9. **Iteration accounting**: a turn with three tool calls increments `iterationCount` by 1, not 3; a run that alternates model→tools 10 times hits `MAX_ITERATIONS`.
10. **Finish chunk always present**: tool-only model response still yields a terminal `finish` chunk (per provider).

## Acceptance Criteria

1. The core loop sources tools from `ctx.agentConfig.tools`, maps them to `ToolSchema[]`, and passes them to the provider on every model turn for tool-bearing agents (SC-03).
2. Tool-less agents continue to send `tools: undefined`.
3. Every model-emitted tool call is checked against the registered allowlist and its persisted JSON input schema before execution; unknown or invalid calls are rejected, recorded as failed, and surfaced to the model without invoking the executor (SC-04).
4. Every persisted tool call and every emitted `tool_call_*` event uses a Swift Agent `tc_` identifier; the provider-native identifier is retained and echoed back on subsequent model turns (SC-05).
5. `ContextBuilder` reconstructs provider-facing tool-result correlation ids from the persisted provider-native id.
6. `iterationCount` counts model rounds (not individual tool executions) and the `maxToolIterations` guard still terminates runaway loops with a `MAX_ITERATIONS` `run_failed`.
7. Provider adapters always emit a terminal `finish` chunk per model round.
8. `pnpm exec tsc --noEmit` and `pnpm exec eslint . --quiet` pass; new contract and loop tests pass.
