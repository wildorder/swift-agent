# Swift Agent — Vision Document

## What Is Swift Agent?

Swift Agent is a **hosted real-time agent runtime**. It lets developers embed a streaming, tool-calling, multi-model AI agent into any application without building WebSocket infrastructure, model adapters, tool orchestration, or session management.

Developers define agents and register tools using the Swift Agent SDK. Swift Agent's cloud infrastructure handles everything else: WebSocket transport, token streaming, the model loop, tool call routing, session persistence, and observability.

**One-liner:** Ship a production-ready AI agent in minutes — not weeks.

## The Problem

Standing up a working AI agent today requires stitching together:

- A model provider SDK (OpenAI, Anthropic, Google, etc.)
- A tool registry and execution protocol
- WebSocket or streaming infrastructure
- Token streaming plumbing
- Session and conversation state management
- Deployment infrastructure (ECS, Lambda, containers, etc.)

Each piece is a standalone engineering project. The result is that developers spend weeks on plumbing before writing a single line of business logic. This is especially punishing for solo developers and small teams building AI features into products for their clients.

No existing product provides the full stack. Current tools are fragmented — you get a model SDK here, an orchestration framework there, and nothing that owns the real-time transport-to-tool-execution pipeline end to end.

## The Solution

Swift Agent is a **managed runtime + developer SDK** that splits responsibilities cleanly:

### Swift Agent Owns (Hosted Infrastructure)

| Concern                    | What We Do                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **WebSocket Gateway**      | Connection auth, session multiplexing, reconnection handling, streaming events to clients                                    |
| **Agent Runtime**          | The core message → model → tool → model loop, with partial token streaming                                                   |
| **Model Abstraction**      | Unified interface across OpenAI, Anthropic, Google, and local models — developers specify a model string, we handle the rest |
| **Session Store**          | Threads, messages, tool calls, run metadata — persisted and queryable                                                        |
| **Traces & Observability** | Structured event logs for every turn: model calls, tool invocations, latencies, errors                                       |
| **Control Plane API**      | Session creation, token issuance, agent registration, metadata management                                                    |
| **Management API**         | User/workspace/API key lifecycle — consumed by the marketing site dashboard, CLI, and future Terraform provider. Auth via Cognito JWT. |

### The Customer Owns (Their Infrastructure)

| Concern                       | What They Do                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------ |
| **Tool Logic**                | Business logic behind each tool (database lookups, API calls, file operations) |
| **Internal System Access**    | Their databases, APIs, and private resources — secrets never leave their infra |
| **Auth to Private Resources** | Their auth tokens, service accounts, credentials                               |
| **Business Logic**            | Domain-specific rules, validation, workflows                                   |

### The Bridge: The SDK

The Swift Agent SDK runs on the customer's backend. It serves two purposes:

1. **Agent & tool registration** — Declaratively define agents, their system prompts, model preferences, and tools with typed schemas.
2. **Tool execution endpoint** — A lightweight runner process that receives tool call requests from the Swift Agent runtime and executes registered tool handlers locally. Secrets and internal APIs stay on the customer's side.

## Architecture

```
┌─────────────────────────────────────┐
│         Customer Frontend           │
│     (React / Next.js / any UI)      │
│                                     │
│  - Opens chat session               │
│  - Sends user messages              │
│  - Receives structured stream events│
└──────────────────┬──────────────────┘
                   │ WebSocket
                   ▼
┌─────────────────────────────────────┐
│     Swift Agent Realtime Gateway    │
│                                     │
│  - Connection auth (short-lived     │
│    client tokens)                   │
│  - Session multiplexing             │
│  - Structured event streaming       │
│  - Reconnection handling            │
└──────────────────┬──────────────────┘
                   │
                   ▼
┌─────────────────────────────────────┐
│       Swift Agent Runtime           │
│                                     │
│  - Message loop (model ↔ tool)      │
│  - Multi-model provider abstraction │
│  - Partial token streaming          │
│  - Context window management        │
└──────┬──────────────────┬───────────┘
       │                  │
       ▼                  ▼
┌──────────────┐   ┌─────────────────────────┐
│ Session DB   │   │ Customer Tool Runner    │
│ (Postgres)   │   │ (SDK on customer infra) │
│              │   │                         │
│ - Threads    │   │ - Registered tool       │
│ - Messages   │   │   handlers              │
│ - Runs       │   │ - Executes locally      │
│ - Tool calls │   │ - Returns results to    │
│ - Events     │   │   Swift Agent runtime   │
└──────────────┘   └─────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│       Model Provider Layer          │
│  OpenAI / Anthropic / Google /      │
│  local models                       │
└─────────────────────────────────────┘
```

## Core Runtime Loop

When a user sends a message, the Swift Agent runtime executes this loop:

1. Persist the user message to the session store.
2. Assemble the context window (system prompt + conversation history, applying the configured memory strategy).
3. Call the configured model provider with the message history and available tool schemas.
4. Stream partial tokens to the client via WebSocket as they arrive.
5. If the model emits a tool call:

- Emit a `tool_call_started` event to the client.
- Route the call to the customer's SDK tool runner.
- Receive the result.
- Emit a `tool_call_completed` event to the client.
- Append the tool result to the conversation and return to step 3.

6. When the model produces a final response (no tool call), persist the assistant message, emit `message_completed`, and end the run.

## Stream Event Protocol

The WebSocket delivers structured events — not raw text. This gives frontends full control over UX (loading states, tool call visualization, error handling).

```typescript
type ChatEvent =
  | { type: 'message_started'; messageId: string }
  | { type: 'token'; messageId: string; text: string }
  | { type: 'tool_call_started'; toolName: string; callId: string }
  | { type: 'tool_call_completed'; toolName: string; callId: string; resultPreview?: string }
  | { type: 'message_completed'; messageId: string }
  | { type: 'run_failed'; error: string };
```

## Developer Experience

### Backend: Define an Agent with Tools

```typescript
import { createAgentApp, defineAgent, tool } from '@swiftagent/sdk';

const app = createAgentApp({
  apiKey: process.env.SWIFT_AGENT_API_KEY!,
});

app.agent(
  defineAgent({
    name: 'support-assistant',
    model: 'anthropic/claude-sonnet',
    system: 'You are a customer support assistant. Use tools when needed.',
    tools: [
      tool({
        name: 'lookupOrder',
        description: 'Look up an order by ID',
        inputSchema: {
          type: 'object',
          properties: { orderId: { type: 'string' } },
          required: ['orderId'],
        },
        execute: async ({ orderId }) => {
          return await db.orders.findById(orderId);
        },
      }),
    ],
  }),
);

app.listen();
```

### Backend: Create a Session

```typescript
const session = await agentClient.sessions.create({
  agent: 'support-assistant',
  userId: 'user_123',
  metadata: { orgId: 'org_456' },
});
// Returns: { sessionId, clientToken, websocketUrl }
```

### Frontend: React Hook

Pass the `websocketUrl` returned by `POST /v1/sessions` directly into the
client — it is the canonical, ready-to-connect `wss://<host>/v1/stream?token=<jwt>`
URL. The gateway reads only the `token` query param and derives the session
from its JWT claims, so no other connection wiring is required.

```typescript
import { useAgentChat } from "@swiftagent/react";

function ChatPanel({ sessionId, token, websocketUrl }) {
  const { messages, send, isStreaming, connectionStatus } = useAgentChat({
    sessionId,
    token,
    websocketUrl,
  });

  return (
    <div>
      {messages.map((m) => (
        <div key={m.id}>{m.content}</div>
      ))}
      <input onSubmit={(text) => send(text)} />
    </div>
  );
}
```

## API Surface

### Server-Side SDK (`@swiftagent/sdk`)

| Function                         | Purpose                                                                                                                           |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `createAgentApp(config)`         | Initialize the SDK with API key. Starts the tool runner process that listens for tool call requests from the Swift Agent runtime. |
| `defineAgent(config)`            | Declare an agent: name, model, system prompt, tools, memory strategy.                                                             |
| `tool(config)`                   | Define a tool with name, description, typed input schema, and an `execute` handler.                                               |
| `app.agent(agent)`               | Register an agent definition with the Swift Agent platform.                                                                       |
| `app.sessions.create(opts)`      | Create a new chat session. Returns `sessionId`, `clientToken`, and `websocketUrl`.                                                |
| `app.sessions.get(id)`           | Retrieve session metadata and status.                                                                                             |
| `app.sessions.messages.list(id)` | Retrieve full message history for a session.                                                                                      |
| `app.runs.create(opts)`          | Trigger a server-driven run (no browser connection required).                                                                     |

### Client-Side SDK (`@swiftagent/react`)

| Function                                  | Purpose                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| `useAgentChat({ sessionId, token, websocketUrl })`      | React hook. `websocketUrl` is the canonical URL from `POST /v1/sessions`. Returns `messages`, `send()`, `isStreaming`, `connectionStatus`, `lastError`. |
| `createChatSession({ sessionId, token, websocketUrl })` | Vanilla JS client. Connects to the API-provided `websocketUrl` verbatim. Returns `sendMessage()`, `onEvent()`, `disconnect()`.                  |

### Key Types

```typescript
type AgentConfig = {
  name: string;
  model: string;
  system?: string;
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  memory?: {
    strategy: 'last_n' | 'summary';
    maxMessages?: number;
  };
};

type ToolDefinition<TInput = any, TResult = any> = {
  name: string;
  description: string;
  inputSchema: object;
  execute: (input: TInput, ctx: ToolContext) => Promise<TResult>;
};

type ToolContext = {
  sessionId: string;
  userId?: string;
  metadata?: Record<string, unknown>;
};
```

## Data Model

| Entity        | Key Fields                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------- |
| **User**      | `userId`, `cognitoSub`, `email`, `createdAt`                                                       |
| **Workspace** | `workspaceId`, `name`, `createdAt`                                                                 |
| **UserWorkspace** | `userId`, `workspaceId`, `role` (owner / member), `createdAt`                                  |
| **ApiKey**    | `apiKeyId`, `workspaceId`, `keyHash`, `name`, `createdAt`, `revokedAt`                             |
| **Agent**     | `agentId`, `workspaceId`, `name`, `modelConfig`, `createdAt`                                       |
| **Session**   | `sessionId`, `agentId`, `userId`, `status` (active / closed), `metadata`, `createdAt`              |
| **Message**   | `messageId`, `sessionId`, `role` (system / user / assistant / tool), `content`, `createdAt`        |
| **Run**       | `runId`, `sessionId`, `status` (running / completed / failed), `model`, `startedAt`, `completedAt` |
| **ToolCall**  | `callId`, `runId`, `toolName`, `input`, `output`, `status` (started / completed / failed)          |

### Management API Endpoints

The Management API is a separate auth layer on the core service, protected by **Cognito JWT** (not API key). It is consumed by the marketing site dashboard, the CLI, and any future automation.

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/v1/management/me` | Get current user profile (auto-create on first call) |
| `POST` | `/v1/management/workspaces` | Create a workspace |
| `GET` | `/v1/management/workspaces` | List user's workspaces |
| `GET` | `/v1/management/workspaces/:id` | Get workspace details |
| `POST` | `/v1/management/workspaces/:id/keys` | Create an API key (returns raw key once) |
| `GET` | `/v1/management/workspaces/:id/keys` | List API keys (hashes only, never raw) |
| `DELETE` | `/v1/management/workspaces/:id/keys/:keyId` | Revoke an API key |

### Two Auth Layers

| Layer | Protects | Credential | Purpose |
|-------|----------|------------|---------|
| **Cognito JWT** | `/v1/management/*` | `Authorization: Bearer <cognito-id-token>` | User identity — "who is this person?" |
| **API Key** | `/v1/*` (runtime) | `Authorization: Bearer ak_...` | Machine identity — "which workspace?" |

## Target Users

**Primary persona:** Solo developers and indie hackers who want to stand up a working AI agent prototype in minutes, not days.

**Secondary persona:** Small engineering teams and contractors building custom AI-powered software for small businesses — connecting existing tools (CRMs, databases, APIs) behind a conversational interface.

Both personas share the same core need: skip the infrastructure grind and focus on business logic and tool definitions.

## Technology Stack (MVP)

| Layer           | Choice                                                     |
| --------------- | ---------------------------------------------------------- |
| API + Runtime   | Node.js / TypeScript                                       |
| Database        | PostgreSQL                                                 |
| Transport       | WebSocket                                                  |
| Background Jobs | Lightweight queue for tool invocation timeouts and retries |
| Cache / Pub-Sub | Redis (stream fanout, connection state)                    |

## Scope: Phase 1 (MVP)

**Build:**

- Agent definition and registration via SDK
- Tool registration and SDK-based tool runner on customer infra
- WebSocket realtime gateway with connection auth, multiplexing, reconnection
- Multi-provider model abstraction (OpenAI, Anthropic, Google)
- Core agent loop (message → model → tool → model → response) with token streaming
- Session creation, persistence, and history retrieval
- Structured stream event protocol
- Run-level traces and observability
- Backend SDK (`@swiftagent/sdk`)
- Frontend React SDK and vanilla JS client (`@swiftagent/react`)
- Simple memory strategies (last-N messages, summary)
- **Management API** (`/v1/management/*`) — workspace CRUD, API key lifecycle, user mapping
- **Users table** linking Cognito `sub` → user → workspaces
- **Cognito JWT auth** on management endpoints (separate from API key auth on runtime endpoints)
- **Shared Cognito User Pool** provisioned in infra (Terraform)

**Do not build in Phase 1:**

- Durable long-running job execution
- Multi-agent orchestration / planner
- Hosted secrets management
- Complex workflow builder
- Vector database / RAG infrastructure
- Browser automation tools
- Prompt versioning / management
- Model fallback rules
- Usage metering / billing
- Team/organization management (multi-user workspaces)

## Scope: Phase 2 (Durable Execution Layer)

Phase 2 evolves Swift Agent from a real-time chat runtime into a full agent infrastructure stack by adding a **durable execution engine** for long-running, async agent workflows.

**Capabilities to add:**

- Long-running agent workflows that survive process restarts
- Durable state checkpointing and recovery
- Async job queuing and scheduling
- Enhanced observability: step-level tracing, cost tracking, latency breakdowns
- Retry policies with backoff and dead-letter handling
- Workflow composition (sequential and parallel tool chains)

Phase 2 is explicitly **part of this product's roadmap** — not a separate product. The Phase 1 runtime is designed to be the synchronous foundation that Phase 2 extends with durability and async capabilities.

## Positioning

**What Swift Agent is:**
Real-time agent infrastructure — the hosted backend that powers streaming, tool-calling AI agents in any application.

**What Swift Agent is not:**
An agent framework, an orchestration UI, or a model provider. It is the infrastructure layer between your application and the models.

**Analogy:** Stripe gave developers payments without building payment infrastructure. Swift Agent gives developers AI agents without building agent infrastructure.
