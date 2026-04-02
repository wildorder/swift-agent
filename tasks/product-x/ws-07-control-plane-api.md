# WS-07: Control Plane REST API

## Goal

Implement the HTTP REST API that handles agent registration, session management, short-lived client token issuance for WebSocket auth, run triggering, and data retrieval. The API is workspace-scoped via API keys, uses Fastify with schema validation, structured errors, and integrates Drizzle repositories from `@swiftagent/db` for persistence.

## Dependencies

- WS-02
- WS-03

## Package

`packages/api`

## Files Touched

- `packages/api/src/server.ts`
- `packages/api/src/routes/agents.ts`
- `packages/api/src/routes/sessions.ts`
- `packages/api/src/routes/runs.ts`
- `packages/api/src/routes/messages.ts`
- `packages/api/src/routes/health.ts`
- `packages/api/src/middleware/auth.ts`
- `packages/api/src/middleware/error-handler.ts`
- `packages/api/src/middleware/request-id.ts`
- `packages/api/src/services/agent-service.ts`
- `packages/api/src/services/session-service.ts`
- `packages/api/src/services/token-service.ts`
- `packages/api/src/types.ts`
- `packages/api/src/index.ts`

## Implementation Steps

1. **Types (`types.ts`)**: Request/response DTOs (Zod schemas co-located or in `schemas/` if preferred), `AuthenticatedRequest` extending Fastify request with `workspaceId`, `apiKeyId`. Error body shape: `{ error: { code: string; message: string; details?: unknown } }`.

2. **Server (`server.ts`)**: Register `@fastify/cors`, `@fastify/sensible` (optional), `pino` child logger with redaction for secrets. Global `contentTypeParser` for JSON. Set `validatorCompiler` / `serializerCompiler` for Zod–Fastify integration (e.g. `fastify-type-provider-zod` pattern or manual). Register middlewares in order: request-id → auth (skip `/health`) → routes. Prefix `/v1` if versioning desired (document choice).

3. **Request ID (`middleware/request-id.ts`)**: Generate UUID v4 per request; set header `X-Request-Id` on response; attach to `req.requestId` and `req.log` bindings.

4. **Auth (`middleware/auth.ts`)**: Read `Authorization: Bearer <apiKey>`. Hash the provided API key (SHA-256), look up via `ApiKeyRepo.getByKeyHash(hash)` from WS-03. If found and not revoked, attach `workspaceId` to request. If not found or revoked: `401` with code `UNAUTHORIZED`. On missing header: `401` with code `UNAUTHORIZED`.

5. **Error handler (`middleware/error-handler.ts`)**: `setErrorHandler` mapping Zod errors to `400`, domain `NotFoundError` to `404`, validation to `422` if applicable; log unexpected errors with `req.log.error`; never leak stack in production.

6. **TokenService (`services/token-service.ts`)**: Use `jose` to sign/verify JWTs for **client** WebSocket auth. Methods: `signClientToken(payload: { sessionId: string; agentId: string; permissions: string[]; exp: number }): Promise<string>` using workspace or global secret from env `CLIENT_JWT_SECRET`. `verifyClientToken` for tests. TTL short (e.g. 15–60 minutes, configurable).

7. **AgentService (`services/agent-service.ts`)**: `registerOrUpdateAgent(workspaceId, input: { name, modelConfig, systemPrompt, memoryConfig })` — upsert by `(workspaceId, name)` returning `Agent`. `getById`, `getByName`. Validate with Zod; map DB errors to domain errors.

8. **SessionService (`services/session-service.ts`)**: `createSession({ workspaceId, agentName, userId, metadata })` — resolve agent by name, insert `Session`, return entity. `getSession`, `updateSession` (e.g. status `closed`). `listMessages(sessionId, pagination)` ordered by `createdAt` asc/desc per spec. Delegate run creation to runtime service (injected) for `POST .../runs`.

9. **Routes — agents (`routes/agents.ts`)**: `POST /agents` → body may include optional `toolRunnerUrl`; AgentService upsert stores this URL so the runtime knows where to send tool call HTTP requests; `GET /agents/:agentId` → 404 if wrong workspace; `GET /agents?name=` query → agent by name.

10. **Tool runner URL registration**: The SDK calls `POST /agents` with `toolRunnerUrl` set to the tool runner's public URL after `app.listen()` starts. This is how the runtime discovers where to send tool calls. The field is nullable — when not set, the runtime uses `LocalToolExecutor` for in-process tool execution.

11. **Routes — sessions (`routes/sessions.ts`)**: `POST /sessions` body `{ agentName, userId, metadata }` → create session; call `TokenService.signClientToken` with `sessionId`, `agentId`, permissions; return `{ sessionId, clientToken, websocketUrl }` where `websocketUrl` from env `PUBLIC_WEBSOCKET_URL` + token query or documented pattern. `GET /sessions/:sessionId` metadata + status. `PATCH /sessions/:sessionId` partial updates.

12. **Routes — messages (`routes/messages.ts`)**: `GET /sessions/:sessionId/messages` — cursor/limit pagination (`limit`, `cursor` or `before`/`after`), validate session belongs to workspace.

13. **Routes — runs (`routes/runs.ts`)**: `POST /sessions/:sessionId/runs` — body with user message content; create `Run` row, enqueue or invoke `@swiftagent/runtime` (per WS-05 integration point). `GET /runs/:runId`, `GET /runs/:runId/tool-calls` — join `ToolCall` table.

14. **Routes — health (`routes/health.ts`)**: `GET /health` — `{ status: "ok", timestamp }` without auth; optional DB ping behind query flag.

15. **Index (`index.ts`)**: Export `buildApp()`, `startServer(port)` for tests and production.

## Tests

1. **Auth middleware**: Request with valid API key attaches `workspaceId`; missing header → 401; invalid key → 401.
2. **TokenService**: Signed token verifies; expired fails; wrong secret fails; payload contains `sessionId`, `agentId`, `permissions`, `exp`.
3. **Agents route**: Mock AgentService — POST returns 201/200 with body; GET by id 404 when absent.
4. **Sessions route**: POST returns `{ sessionId, clientToken, websocketUrl }`; JWT decodable; shape matches contract.
5. **Messages route**: Pagination returns ordered list; invalid cursor → 400.
6. **Runs route**: Create run returns `runId`; GET returns status; tool-calls list matches mock data.
7. **Error handler**: Thrown domain errors map to correct status and JSON body; unknown errors become 500 with generic message.
8. **Integration** (with test DB or mocked repos): Create agent → create session → list messages (empty) succeeds end-to-end.

## Acceptance Criteria

1. All listed routes exist under the chosen base path, with correct HTTP verbs and status codes for success and common failures.
2. Every route except `GET /health` requires a valid workspace API key.
3. Request IDs appear on responses and in logs for correlation.
4. JSON request bodies are validated; invalid input returns `400`/`422` with structured errors.
5. `POST /sessions` returns `sessionId`, a short-lived JWT `clientToken`, and a `websocketUrl` suitable for the gateway.
6. Client JWTs use `jose` and carry `sessionId`, `agentId`, and `permissions` for gateway validation.
7. Agent upsert by name within a workspace works; retrieval by id and by name works.
8. Message listing supports pagination and stable ordering by `createdAt`.
9. Run and tool-call retrieval expose persisted data consistent with the schema (Agent, Session, Message, Run, ToolCall).
