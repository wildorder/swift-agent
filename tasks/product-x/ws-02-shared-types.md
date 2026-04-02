# WS-02: Shared Types & Protocol Definitions

## Goal

Centralize all domain types, the realtime stream event protocol (`message_started`, `token`, `tool_call_started`, `tool_call_completed`, `message_completed`, `run_failed`), canonical error codes, ID utilities, and Zod schemas in `packages/shared` so every other package (`db`, `runtime`, `gateway`, `api`, `sdk`, `react`) imports one source of truth with full compile-time and runtime validation.

## Dependencies

- WS-01

## Package

`packages/shared`

## Files Touched

- `packages/shared/src/index.ts`
- `packages/shared/src/types/agent.ts`
- `packages/shared/src/types/session.ts`
- `packages/shared/src/types/message.ts`
- `packages/shared/src/types/run.ts`
- `packages/shared/src/types/tool-call.ts`
- `packages/shared/src/types/events.ts`
- `packages/shared/src/types/errors.ts`
- `packages/shared/src/types/workspace.ts`
- `packages/shared/src/types/api-key.ts`
- `packages/shared/src/types/auth.ts`
- `packages/shared/src/config.ts` — `ENV_KEYS` env map and `loadConfig(env)` with Zod validation
- `packages/shared/src/utils/id.ts`
- `packages/shared/src/utils/time.ts`
- `packages/shared/src/constants.ts`

## Implementation Steps

1. **Agent types** (`types/agent.ts`): Define `ModelConfig`, `MemoryConfig` (structured JSON-serializable shapes), `AgentConfig` (creation/update payload), and `AgentRecord` with fields: `agentId: string`, `workspaceId: string`, `name: string`, `modelConfig: ModelConfig`, `systemPrompt: string`, `memoryConfig: MemoryConfig`, `toolRunnerUrl: string | null` (URL where the customer's SDK tool runner listens for tool call HTTP requests — set during agent registration via `POST /agents` from the SDK's `app.listen()`; `null` when tools run in-process via `LocalToolExecutor`), `createdAt: Date` (or ISO string—pick one convention and document), `updatedAt`. (Workspace linkage uses `workspaceId` consistent with `WorkspaceRecord` / WS-03.)
2. **Session types** (`types/session.ts`): Define `SessionStatus = 'active' | 'closed'`; `CreateSessionRequest` with `agentId`, optional `userId`, optional `metadata`; `SessionRecord` with `sessionId`, `agentId`, `userId` (nullable if allowed), `status`, `metadata: Record<string, unknown>` (or stricter), `createdAt`, `updatedAt`.
3. **Message types** (`types/message.ts`): Define `MessageRole = 'system' | 'user' | 'assistant' | 'tool'`; `MessageRecord` with `messageId`, `sessionId`, `runId: string | null`, `role`, `content: string`, `createdAt` (and `updatedAt` if messages are mutable—default immutable with single timestamp).
4. **Run types** (`types/run.ts`): Define `RunStatus = 'running' | 'completed' | 'failed'`; `TokenUsage` shape (input/output/total tokens as numbers); `RunRecord` with `runId`, `sessionId`, `status`, `model: string`, `tokenUsage: TokenUsage | null`, `createdAt`, `updatedAt`.
5. **Tool call types** (`types/tool-call.ts`): Define `ToolCallStatus = 'started' | 'completed' | 'failed'`; `ToolCallRecord` with `callId`, `runId`, `toolName: string`, `input: unknown` (JSON), `output: unknown | null`, `status`, `createdAt`, `updatedAt`.
6. **Stream events** (`types/events.ts`): Define discriminated union `ChatEvent` with `type` discriminator and these variants:
   - `{ type: 'message_started'; messageId: string; runId: string; sessionId: string }`
   - `{ type: 'token'; runId: string; sessionId: string; text: string }` (add `messageId` if streaming is per-message—align with runtime WS-05)
   - `{ type: 'tool_call_started'; callId: string; runId: string; sessionId: string; toolName: string }`
   - `{ type: 'tool_call_completed'; callId: string; runId: string; sessionId: string; toolName: string; status: ToolCallStatus }` (or split success/failure payloads)
   - `{ type: 'message_completed'; messageId: string; runId: string; sessionId: string }`
   - `{ type: 'run_failed'; runId: string; sessionId: string; code: string; message: string; cause?: unknown }`
   Ensure each variant is narrowable via `switch (event.type)`.
7. **Errors** (`types/errors.ts`): Define `SwiftAgentError` class extending `Error` with `readonly code: SwiftAgentErrorCode`, `readonly statusCode?: number`, `cause?: unknown`; define `enum SwiftAgentErrorCode` or `const` map covering validation, not-found, conflict, rate-limit, provider, internal, etc.; export type guard `isSwiftAgentError`.
8. **Constants** (`constants.ts`): Export event type string literals, ID prefix constants (`PREFIX_SESSION = 'ses_'`, etc.), default limits if shared.
9. **ID utilities** (`utils/id.ts`): Use `nanoid` (or `nanoid/non-secure` in hot paths) with custom alphabet if required; export `generateSessionId()`, `generateMessageId()`, `generateRunId()`, `generateToolCallId()`, `generateAgentId()`, `generateWorkspaceId()` (prefix `ws_`), `generateApiKeyId()` (prefix `ak_`) returning prefixed strings: `ses_*`, `msg_*`, `run_*`, `tc_*`, `agt_*`, `ws_*`, `ak_*` (align with DB PKs); export `parsePrefix(id: string)` for debugging.
10. **Time utilities** (`utils/time.ts`): `now()` for testability, `toIso(date: Date)`, optional `clamp` helpers for TTLs.
11. **Zod schemas**: For every exported record/request type, export matching `SomethingSchema` using `z.object({...})` with `.strict()` where appropriate; export `z.infer<typeof SomethingSchema>` aligned with TypeScript types (single definition: either `z.infer` as source of truth or shared `satisfies` pattern—prefer one approach to avoid drift).
12. **Workspace types** (`types/workspace.ts`): Define `WorkspaceRecord` with `workspaceId: string`, `name: string`, `createdAt: Date` (same date convention as other records); export `WorkspaceRecordSchema` (Zod).
13. **ApiKey types** (`types/api-key.ts`): Define `ApiKeyRecord` with `apiKeyId: string`, `workspaceId: string`, `keyHash: string`, `name: string`, `createdAt: Date`, `revokedAt: Date | null`; export `ApiKeyRecordSchema` (Zod).
14. **Client token claims** (`types/auth.ts`): Define `ClientTokenClaims` with fields: `sessionId: string`, `agentId: string`, `permissions: string[]`, `exp: number` (Unix epoch seconds), `iss?: string` (issuer, e.g. `'swiftagent'`), `aud?: string` (audience). Export `ClientTokenClaimsSchema` (Zod). This is the shared contract between `TokenService` in `@swiftagent/api` (WS-07, the issuer) and `validateClientToken` in `@swiftagent/gateway` (WS-06, the verifier) — both import from here to prevent claim shape drift.
15. **Shared config** (`config.ts`): Export `const ENV_KEYS` mapping all environment variable names used across the system: `DATABASE_URL`, `REDIS_URL`, `CLIENT_JWT_SECRET`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `PUBLIC_WEBSOCKET_URL`, `TOOL_RUNNER_PUBLIC_URL`, `API_PORT`, `GATEWAY_PORT`. Export `loadConfig(env: NodeJS.ProcessEnv)` that validates required env vars are present using Zod (document which keys are required vs optional per deployment).
16. **Barrel** (`index.ts`): Re-export all public types, schemas, utilities, constants, config helpers, and error class; avoid deep internal paths in consumer imports.

## Tests

1. TypeScript compilation of `packages/shared` with `strict` passes with no `any` leaks in public APIs.
2. Zod: valid payloads for `AgentRecord`, `SessionRecord`, `MessageRecord`, `RunRecord`, `ToolCallRecord` parse successfully.
3. Zod: invalid payloads (wrong enum, missing required field, wrong prefix) fail with expected Zod issues.
4. ID generation: each generator returns non-empty string with correct prefix; collision probability acceptable (document nanoid length).
5. `ChatEvent` discriminated union: exhaustive switch test or runtime validation schema for each `type` value.
6. `SwiftAgentError`: `instanceof` and `JSON` serialization behavior if serialized for API responses.
7. Zod: valid and invalid payloads for `WorkspaceRecord` and `ApiKeyRecord` schemas (required fields, nullable `revokedAt`, etc.).
8. `loadConfig` / `ENV_KEYS`: required environment variables validate successfully when set; missing required vars fail with expected Zod issues; `ENV_KEYS` exposes a single source of truth for variable names.
9. `ClientTokenClaims`: valid claims parse successfully; missing `sessionId` or `agentId` fails; `permissions` must be string array; `exp` must be a number.
10. `AgentRecord` with `toolRunnerUrl: null` and with a valid URL string both parse successfully via Zod; missing field fails.

## Acceptance Criteria

1. All other packages can import domain types and stream events exclusively from `@swiftagent/shared` with full IntelliSense and strict typing.
2. Stream event union covers exactly: `message_started`, `token`, `tool_call_started`, `tool_call_completed`, `message_completed`, `run_failed` with stable field names for gateway/runtime consumers.
3. Zod schemas mirror the TypeScript types without contradictory definitions (single source of truth documented in code).
4. Error codes are enumerated and reusable by API, gateway, and runtime for consistent client handling.
5. ID utilities produce prefixed IDs suitable for primary keys and log correlation.
6. Workspace and ApiKey types are defined and available for WS-03 schema and WS-07 auth middleware.
7. Shared config env map provides a single source of truth for all environment variable names; `loadConfig` validates required vars at startup.
8. `ClientTokenClaims` is the single shared contract between WS-07 (token issuer) and WS-06 (token verifier); both packages import it from `@swiftagent/shared`.
9. `AgentRecord` includes `toolRunnerUrl: string | null` so WS-05a's `createToolExecutor` factory can type-check against it without local augmentation.
