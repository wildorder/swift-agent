# WS-08: Server SDK (@swiftagent/sdk)

## Goal

Implement the developer-facing server SDK that provides a fluent API for defining agents and tools, registering them with the control plane, creating sessions and runs, and running a local tool-executor HTTP server that the Swift Agent runtime invokes when executing tools. The SDK aligns with the vision doc: `createAgentApp`, `defineAgent`, `tool`, `app.agent`, session/run helpers, and `app.listen()`.

## Dependencies

- WS-05a
- WS-07

## Package

`packages/sdk`

## Files Touched

- `packages/sdk/src/app.ts`
- `packages/sdk/src/agent.ts`
- `packages/sdk/src/tool.ts`
- `packages/sdk/src/tool-runner.ts`
- `packages/sdk/src/client.ts`
- `packages/sdk/src/types.ts`
- `packages/sdk/src/index.ts`

## Implementation Steps

1. **Types (`types.ts`)**: Define `AgentConfig` — `{ name: string; model: string; system?: string; tools?: ToolDefinition[]; temperature?: number; maxTokens?: number; memory?: { strategy: string; maxMessages: number } }`. `ToolDefinition<TInput, TResult>` — `{ name; description; inputSchema: ZodType<TInput>; execute: (input: TInput, ctx: ToolContext) => Promise<TResult> }`. `ToolContext` — `{ sessionId: string; userId?: string; metadata?: Record<string, unknown> }`. `CreateAgentAppConfig` — `{ apiKey: string; baseUrl?: string }`. Export serializable `AgentDefinition` (JSON-schema-friendly tool schemas via Zod `.toJSONSchema()` or stored as OpenAPI fragment). Export HTTP types for tool runner requests: `POST /tools/:toolName` body `{ input: unknown; context: ToolContext }`.

2. **defineAgent (`agent.ts`)**: `export function defineAgent(config: AgentConfig): AgentDefinition` — validate `config` with Zod; ensure `name` and `model` required; collect tools; return frozen object suitable for `POST /agents` (map `memory`, `model` → `modelConfig` per API contract).

3. **tool (`tool.ts`)**: `export function tool<TInput, TResult>(config: ToolDefinition<TInput, TResult>): ToolDefinition<TInput, TResult>` — validate `name`, `description`, `inputSchema` is Zod; return config unchanged after shallow freeze; helper to export JSON Schema for registration payload.

4. **API client (`client.ts`)**: Class `ControlPlaneClient` with `baseUrl`, `apiKey` header `Authorization: Bearer`. Methods: `registerAgent(body)`, `createSession(body)`, `getSession(id)`, `listMessages(sessionId, params?)`, `createRun(sessionId, body)`, `registerToolRunnerUrl(url)` if API supports it — otherwise document env-based registration for MVP. Use `fetch` or `undici`; all responses parsed with Zod; throw `SdkHttpError` with status + body.

5. **Tool runner (`tool-runner.ts`)**: Fastify server with auth middleware: every `POST /tools/:toolName` request must include `Authorization: Bearer {apiKey}` header matching the API key provided to `createAgentApp`. The middleware reads the header, compares to the stored `apiKey` (constant-time comparison to prevent timing attacks), and returns `401` with `{ error: { code: "UNAUTHORIZED", message: "Invalid or missing authorization" } }` on mismatch. This ensures only the Swift Agent runtime (which sends the workspace API key per WS-05a `RemoteToolExecutor`) can invoke tools — not arbitrary HTTP clients. After auth: parse body, lookup handler in `Map<string, ToolDefinition>` from `AgentApp` registry (tool name global per app MVP). Validate `input` with tool's `inputSchema.safeParse`. `execute` with timeout (configurable, default e.g. 30s) via `AbortSignal` or `p-timeout`. Return `{ result: TResult }` or `{ error: { message, code } }` with appropriate HTTP status on handler failure. `GET /health` for k8s (no auth required). Export `startToolRunner(port: number, registry: ToolRegistry, apiKey: string): Promise<FastifyInstance>` and `stop`.

6. **AgentApp (`app.ts`)**: `createAgentApp(config: CreateAgentAppConfig): AgentApp` — instantiate `ControlPlaneClient`. `AgentApp` holds `agents: AgentDefinition[]`, `toolsByName: Map<string, ToolDefinition>` built from all registered agent tools. Methods: `agent(definition: AgentDefinition): this` — push definition, merge tools into map (duplicate name throws). `sessions = { create(opts), get(id), messages: { list(id) } }` delegating to client. `runs = { create(opts) }` delegating to client. `listen(port?: number): Promise<void>` — start tool runner on `port ?? process.env.PORT`; compute public URL (`TOOL_RUNNER_PUBLIC_URL` or `http://127.0.0.1:${port}`); call API or set env so runtime can reach tool runner (per WS-05 contract: callback URL registration). Block until server listening; log pino-compatible message.

7. **Registration flow**: On `listen()`, after tool runner is up, for each `defineAgent` registration call `registerAgent` with serialized config + tool metadata (names, descriptions, JSON schemas). Idempotent upsert behavior should match API.

8. **Index (`index.ts`)**: Export `createAgentApp`, `defineAgent`, `tool`, types, and `AgentApp` class type.

## Tests

1. **defineAgent**: Valid config passes; missing `name`/`model` fails Zod; invalid `memory` shape fails.
2. **tool**: Produces object with correct `name` and schema serialization; duplicate registration in same agent caught if validated at `defineAgent` time.
3. **AgentApp.agent**: Mock `fetch` — `listen()` issues `POST /agents` with expected JSON body including tool schemas.
4. **Tool runner**: Inject mock tool — `POST /tools/weather` with valid `Authorization: Bearer` header and valid input returns 200 and result; missing auth header returns 401; wrong API key returns 401; Zod validation failure returns 400; handler throw returns 500 with structured error; timeout returns 504 or documented code; `GET /health` returns 200 without auth.
5. **Sessions / runs**: Mock client — `sessions.create` and `runs.create` send correct paths and bodies.
6. **Lifecycle integration test**: Mock control plane + supertest against tool runner — define agent with one tool → register → simulate runtime POST to tool runner → assert response.

## Acceptance Criteria

1. `createAgentApp({ apiKey, baseUrl })` returns an object with `agent`, `sessions`, `runs`, and `listen` as specified.
2. `defineAgent` validates configuration with Zod and returns a serializable agent definition compatible with `POST /agents`.
3. `tool` defines executable tools with Zod `inputSchema` and `execute(input, ctx)`; schemas can be sent to the control plane for runtime use.
4. `app.agent(definition)` registers the agent with the platform (HTTP) on `listen()` (or documented explicit registration step that still results in platform registration before use).
5. `app.sessions.create`, `get`, `messages.list`, and `app.runs.create` map to the REST API and parse responses with correct TypeScript types.
6. `app.listen(port?)` starts the Fastify tool runner; runtime can `POST /tools/:toolName` with valid `Authorization: Bearer` header and receive outputs or structured errors. Requests without valid auth are rejected with 401.
7. Tool runner registers or advertises its public URL so the Swift Agent runtime knows where to send tool calls (env and/or API call per WS-05a/WS-07 contract).
8. A developer can follow the vision doc DX examples using this SDK without hand-rolling HTTP or WebSocket code for tools and registration.
