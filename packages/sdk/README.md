# @swiftagent/sdk

The TypeScript SDK for building, defining, and running Swift Agent agents. It exposes the agent-definition helpers, the streaming chat loop, and the tool/model primitives used to embed Swift Agent into your own services.

## Install

`@swiftagent/*` packages are published to the org's private GitHub Packages registry, not public npm. Add the scope mapping to your `.npmrc` (already committed at the repo root here) and authenticate with a token that has `read:packages`:

```ini
@swiftagent:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PKG_TOKEN}
```

```sh
pnpm add @swiftagent/sdk
```

`@swiftagent/shared` is pulled in transitively — you do not add it yourself.

## Usage

Define a tool (its `inputSchema` is a **Zod** schema, not a raw JSON-Schema
object), attach it to an agent, register the agent, and start the tool runner.
This snippet is derived from
[`examples/quickstart/backend/src/server.ts`](../../examples/quickstart/backend/src/server.ts):

```ts
import { z } from 'zod';
import { createAgentApp, defineAgent, tool } from '@swiftagent/sdk';

const echoTool = tool({
  name: 'echo',
  description: 'Echo a message back, optionally shouting it.',
  inputSchema: z.object({
    message: z.string().min(1),
    shout: z.boolean().optional(),
  }),
  execute: async ({ message, shout }, ctx) => {
    const text = shout ? message.toUpperCase() : message;
    return { echoed: text, sessionId: ctx.sessionId };
  },
});

const app = createAgentApp({
  apiKey: process.env.SWIFT_AGENT_API_KEY ?? '',
});

app.agent(
  defineAgent({
    name: 'support-assistant',
    model: 'anthropic/claude-sonnet',
    system: 'You are a friendly support assistant.',
    tools: [echoTool],
  }),
);

// Mint a browser session (client token + canonical websocketUrl).
const session = await app.sessions.create({
  agentName: 'support-assistant',
  userId: 'demo-user',
});

// Start the tool runner and register the agents.
await app.listen();
```

> **`app.listen()` is not zero-config.** It starts the tool runner and requires
> runner-token verification config: `RUNNER_TOKEN_PUBLIC_KEY` (PEM or JWK) and
> `RUNNER_WORKSPACE_ID` — supplied via env vars or
> `createAgentApp({ runnerPublicKey, runnerWorkspaceId })`. `RUNNER_AUDIENCE`
> (falling back to `TOOL_RUNNER_PUBLIC_URL`) is optional. Without a resolvable
> public key and workspace id, `listen()` throws.

The `inputSchema` is a Zod schema at author time; the SDK converts it to the
JSON-Schema **wire** form (what the API registration payload carries) via
`toolToJsonSchema()` — available from the `@swiftagent/sdk/internal` subpath.

## API surface

`createAgentApp(config)` returns an `AgentApp` with the full fluent surface:

| Symbol | Purpose |
| --- | --- |
| `createAgentApp(config)` | Create an `AgentApp`. Requires `apiKey`; throws `apiKey is required` if missing. |
| `defineAgent(config)` | Declare an agent: name, model, system prompt, tools, memory strategy. |
| `tool(config)` | Define a tool with a **Zod** `inputSchema` and an `execute` handler. |
| `app.agent(definition)` | Register an agent definition (returns `app` for chaining). |
| `app.sessions.create(opts)` | Create a session. Returns `{ sessionId, clientToken, websocketUrl }`. Takes `{ agentName, userId?, metadata? }`. |
| `app.sessions.get(id)` | Retrieve a `SessionRecord` (metadata + status). |
| `app.sessions.messages.list(id, opts?)` | List a session's messages (`{ limit?, cursor? }` → `{ data, hasMore }`). |
| `app.runs.create(opts)` | Trigger a server-driven run. Returns an **accepted** run (202) — poll `runs.get` for terminal status. |
| `app.runs.get(runId)` | Retrieve a `RunRecord` (poll for terminal status). |
| `app.runs.cancel(runId)` | Cancel a run. Idempotent; returns the accepted-run shape. |
| `app.listen(port?)` | Start the tool runner + register agents. Requires runner-token config (see above). |
| `app.close()` | Stop the tool runner server. |

The package barrel also exports the type-only surface (`AgentApp`,
`ToolContext`, `ToolDefinition`, `SdkAgentConfig`, `AgentDefinition`,
`CreateAgentAppConfig`, `CreateSessionOptions`/`Result`, `ListMessagesOptions`/`Result`,
`CreateRunOptions`, `AcceptedRun`, and the `AgentRecord`/`SessionRecord`/`MessageRecord`/`RunRecord`
records). Raw control-plane / tool-runner escape hatches live behind the
declared `@swiftagent/sdk/internal` subpath.

## Learn more

- Quickstart walk-through: [`docs/quickstart.md`](../../docs/quickstart.md)
- Runnable example: [`examples/quickstart/`](../../examples/quickstart)
