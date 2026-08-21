# Swift Agent — Vision Document

> **Revision (2026-08-18):** repositioned from hosted-SaaS to open-source,
> self-hostable runtime. See *Distribution & Deployment* for the rationale and
> *Scope: Phase 2* for the deprioritized durable-execution roadmap.

## What Is Swift Agent?

Swift Agent is an **open-source real-time agent runtime**. It is the transport
and tool-execution layer for streaming, tool-calling AI agents — the part of an
agent stack that is tedious to build, easy to build badly, and rarely the reason
anyone started the project.

You define agents and register tools with the Swift Agent SDK. Swift Agent owns
the WebSocket gateway, the model↔tool loop, tool-call routing across a network
boundary, session persistence, and run-level tracing. **You run it** — locally in
one command, on your own cloud, or on a hosted instance.

**One-liner:** The realtime and tool-execution layer for AI agents. Self-host it
in one command; your tools run in your codebase, your data stays in your Postgres.

## The Problem

Standing up a streaming, tool-calling agent means stitching together a model
provider SDK, a tool registry and execution protocol, WebSocket infrastructure,
token streaming, session state, and deployment plumbing.

But those pieces are not equally hard, and being honest about which is which is
the basis for this project.

**Commodity — a competent team ships this in an afternoon:**

- The message → model → tool → model loop
- Provider abstraction across OpenAI / Anthropic / Google
- Persisting threads and messages

**Genuinely annoying — where teams lose weeks, or ship something subtly broken:**

- WebSocket transport: connection auth, session multiplexing, reconnection,
  backpressure, and fan-out across more than one server process
- **Executing tool calls across a network boundary** — scoped, short-lived
  credentials; timeouts and deadlines; idempotency; SSRF protection; a versioned
  wire protocol that can be upgraded without breaking deployed runners
- Run-level tracing that survives a reconnect, and server-driven runs with no
  browser attached

Swift Agent leads with the second list. The first list is table stakes it happens
to include.

The alternative to Swift Agent is not "no tooling" — it is that every team writes
its own version of the second list, in a hurry, and finds the sharp edges in
production.

## The Solution

Swift Agent is a **self-hostable runtime + developer SDK** that splits
responsibilities cleanly:

### Swift Agent Owns (The Runtime — Your Deployment)


| Concern                    | What The Runtime Does                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **WebSocket Gateway**      | Connection auth, session multiplexing, reconnection handling, streaming events to clients                                            |
| **Agent Runtime**          | The core message → model → tool → model loop, with partial token streaming                                                           |
| **Tool-Call Boundary**     | Routing calls to your runner over a versioned protocol with scoped short-lived credentials, deadlines, idempotency keys, SSRF guards |
| **Model Abstraction**      | Unified interface across OpenAI, Anthropic, Google, and local models — specify a model string, the runtime handles the rest          |
| **Session Store**          | Threads, messages, tool calls, run metadata — persisted to **your** Postgres and queryable                                           |
| **Traces & Observability** | Structured event logs for every turn: model calls, tool invocations, latencies, errors                                               |
| **Control Plane API**      | Session creation, token issuance, agent registration, metadata management                                                            |
| **Management API**         | User/workspace/API key lifecycle — consumed by the dashboard, CLI, and future Terraform provider. Auth via Cognito JWT.              |


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

This boundary holds regardless of who operates the runtime. Even against a hosted
instance, tool handlers execute in the customer's process, against the customer's
credentials.

## Distribution & Deployment

Swift Agent is open source. Adopters climb only as far up this ladder as they
need — and **agent code is identical at every rung**. The same `defineAgent`, the
same `tool()`, the same `useAgentChat`. Only the server URL moves.


| Rung                     | Effort                      | Who it is for                               | Status |
| ------------------------ | --------------------------- | ------------------------------------------- | ------ |
| **Hosted playground**    | Zero — open a link          | Evaluators deciding whether to keep reading | Application built (`apps/playground`, mediator-guarded); the public URL goes live with the owner's first deploy of `deploy/playground/` |
| **`create-swift-agent`** | ~60s — scaffold and run     | Developers trying it for real               | Built and e2e-verified (`packages/create-swift-agent`) |
| **`docker compose up`**  | ~5 min — whole stack, local | Developers building against it              | Built — self-provisioning local stack (`docker-compose.yml`) |
| **One-click deploy template** | ~15 min — their own Fly.io | Developers hosting a real instance     | Template built (`deploy/`): pinned single instance, managed Postgres/Redis, forward-only migrate step |
| **`terraform apply`**    | ~20 min — their own AWS     | Teams taking it to production               | Built (`infra/` — dev / staging / prod) |


### Why Open Source Rather Than Hosted-Only

The teams with the sharpest need for this layer are also the ones most able to
build it themselves, and the most reluctant to route conversation traffic through
a third party. A hosted-only product argues with both facts. Self-hosting
resolves them:

- **Data residency is structural, not promised.** Conversations live in the
  adopter's Postgres. There is no vendor retention policy to audit, no DPA to
  negotiate, and no SOC 2 gate standing between evaluation and adoption.
- **"Would we just build this ourselves?" stops being the deciding question.**
  Reading a working implementation is cheaper than writing one. The project
  competes by being the finished version of what they were about to build.
- **The hard parts stay visible.** The tool-call boundary and the gateway are
  readable, testable, and forkable — which is precisely the argument for
  adopting them instead of reimplementing them.

**"No devops" survives, honestly scoped:** no devops to *try* it, and one command
to *run* it. A hosted tier remains possible later — the runtime is already
multi-tenant (workspaces, API keys, scoped runner credentials) — but it is a
convenience for people who do not want to operate Postgres, not the pitch.

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

> **New here?** Follow the [Quickstart](quickstart.md), which wires an agent end
> to end using the runnable [`examples/quickstart/`](../examples/quickstart)
> example. The snippets below mirror it.

### Backend: Define an Agent with Tools

A tool's `inputSchema` is a **Zod** schema (the SDK's `tool()` rejects anything
without a `.safeParse` method). On registration the SDK serializes it to the
JSON-Schema **wire** form via `toolToJsonSchema()`.

```typescript
import { z } from 'zod';
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
        inputSchema: z.object({ orderId: z.string() }),
        execute: async ({ orderId }) => {
          return await db.orders.findById(orderId);
        },
      }),
    ],
  }),
);

// `app.listen()` starts the tool runner and is NOT zero-config: it requires
// runner-token verification config — `RUNNER_TOKEN_PUBLIC_KEY` (PEM or JWK) and
// `RUNNER_WORKSPACE_ID` — via env vars or
// `createAgentApp({ runnerPublicKey, runnerWorkspaceId })`. It throws otherwise.
await app.listen();
```

### Backend: Create a Session

```typescript
const session = await app.sessions.create({
  agentName: 'support-assistant',
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
| `app.sessions.messages.list(id, opts?)` | Retrieve message history for a session (`{ limit?, cursor? }` → `{ data, hasMore }`).                                       |
| `app.runs.create(opts)`          | Trigger a server-driven run (no browser connection required). Returns an **accepted** run (202) — poll `app.runs.get`.            |
| `app.runs.get(runId)`            | Retrieve a run's record; poll for terminal status.                                                                                |
| `app.runs.cancel(runId)`         | Cancel a run. Idempotent; returns the accepted-run shape.                                                                         |
| `app.listen(port?)`              | Start the tool runner and register agents. Requires runner-token config (see above); not zero-config.                            |
| `app.close()`                    | Stop the tool runner server.                                                                                                      |

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
  inputSchema: ZodType<TInput>; // Zod schema, not a raw JSON-Schema object
  execute: (input: TInput, ctx: ToolContext) => Promise<TResult>;
};

type ToolContext = {
  sessionId: string;
  agentId: string; // resolved agent id (matches signed token claim)
  runId: string; // invocation scope
  callId: string; // tc_ call id — invocation identity + idempotency key
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

**Primary persona:** Developers and small teams embedding streaming, tool-calling
chat into an application they already own, who want the transport and tool
boundary solved without adding a vendor to their data path. They have the skill
to build it themselves; they would rather adopt a good implementation and spend
the time on tools and product.

**Secondary persona:** Agencies and contractors shipping AI features for clients.
They bill per project and cannot maintain bespoke agent infrastructure per
client, so they adopt a runtime rather than write one — and self-hosting lets
them deploy into the client's own account, which is frequently a contractual
requirement.

Both personas share the same need: own the tools and the data, not the plumbing.

**Explicitly not the target:** teams wanting a no-code agent builder, a
prompt-management UI, a RAG platform, or a durable workflow engine. Those are
different products — see Positioning.

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

## Scope: Phase 2 — Deprioritized (Durable Execution)

Earlier revisions of this document committed Phase 1 to a Phase 2 **durable
execution layer**: long-running workflows surviving restarts, checkpointing, job
queues, retry policies with dead-letter handling, and workflow composition.

**That roadmap is deprioritized, and is not the next program.** The reasoning:

- Durable execution is the entire product of well-funded incumbents (Trigger.dev,
  Inngest, Temporal). Entering that fight as a secondary feature is a losing
  position, and it dilutes the one thing Swift Agent does distinctively.
- No target persona has asked for it. The async need that *does* exist —
  triggering a run with no browser attached — is already served by server-driven
  runs (`app.runs.create`, `202` + poll).
- Under an open-source model, breadth is a liability. A small, excellent,
  readable runtime is more adoptable than a broad one, and adoption is the goal.

**Instead, the async story is completed narrowly:** server-driven runs plus a
completion webhook, so an adopter can trigger an agent from a cron job or a queue
they already run and be notified when it finishes. No workflow engine.

Should durable execution ever be revisited, the Phase 1 runtime remains a sound
synchronous foundation for it. It is a possible future, not a committed roadmap.

### Candidate Future Work (Not Committed)

- **A `bedrock/*` model provider.** The runtime calls OpenAI, Anthropic, and
  Google directly with provider keys; there is no AWS Bedrock path today.
  Enterprise adopters can frequently only reach models through an existing AWS
  agreement, and Bedrock would slot into the existing `ProviderRegistry`
  alongside the current providers. Not scheduled, and deliberately excluded from
  the `oss-direction` program, which is distribution work. Note that Bedrock is
  *not* a better answer for spend control — AWS Budgets alert rather than hard
  stop, whereas provider account limits actually refuse requests.


## Positioning

**What Swift Agent is:**
Open-source realtime agent infrastructure — the self-hostable transport and
tool-execution layer beneath streaming, tool-calling agents. You own the
deployment, the tools, and the data.

**What Swift Agent is not:**
An agent framework, an orchestration UI, a prompt-management tool, a RAG
platform, a durable workflow engine, or a model provider. It is the layer between
your application and the models, and it stays that size on purpose.

### Adjacent Projects, Honestly

- **LiveKit Agents** — open source plus a cloud tier, occupying adjacent ground.
  Voice-first and substantially heavier to adopt. Swift Agent is text- and
  tool-first, and optimized for time-to-first-token-in-your-app.
- **Trigger.dev / Inngest / Temporal** — durable execution. Deliberately *not*
  competed with; see Scope: Phase 2.
- **Vercel AI SDK / Mastra / LangGraph** — client and orchestration libraries.
  They assume you bring the transport, the tool boundary, and the deployment.
  Swift Agent is that missing half, and composes rather than competes.
- **Hosted agent APIs from model vendors** — convenient, but they hold your
  conversation state and couple you to one provider. Swift Agent keeps state in
  your database and keeps the model string swappable.

### The Test This Positioning Must Pass

Every prospective feature is measured against one question: *does this make the
transport or the tool boundary better, or is it something the adopter's own
codebase should own?* If it is the latter, it does not ship — no matter how
reasonable it sounds in isolation.
