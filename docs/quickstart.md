# Quickstart

This is a narrative walk-through of the canonical, CI-maintained example under
[`examples/quickstart/`](../examples/quickstart). Every snippet below is derived
from that example — read it there to see the full, runnable code, and follow
[`examples/quickstart/README.md`](../examples/quickstart/README.md) to actually
run it.

The example has two halves: a **backend** that defines an agent and mints
browser sessions, and a **frontend** React app that renders the streaming chat.

## 1. Install

`@swiftagent/*` packages publish to **GitHub Packages** (the `@swiftagent`
scope's private registry). Point your `.npmrc` at
`@swiftagent:registry=https://npm.pkg.github.com` with a `read:packages` token,
then:

```
pnpm add @swiftagent/sdk @swiftagent/react
```

`@swiftagent/shared` comes in transitively with both SDKs.

## 2. Define an agent with a Zod-schema tool

A tool's `inputSchema` is a **Zod** schema — the SDK's `tool()` rejects anything
without a `.safeParse` method. From
[`examples/quickstart/backend/src/server.ts`](../examples/quickstart/backend/src/server.ts):

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

const supportAgent = defineAgent({
  name: 'support-assistant',
  model: 'anthropic/claude-sonnet',
  system: 'You are a friendly support assistant.',
  tools: [echoTool],
});
```

The Zod schema is the author-time form; on registration the SDK serializes it to
the JSON-Schema **wire** form via `toolToJsonSchema()`.

## 3. Create the app and start the runner

`createAgentApp` returns the fluent `AgentApp`. `app.listen()` starts the tool
runner and registers your agents — it is **not** zero-config:

```ts
const app = createAgentApp({
  apiKey: process.env.SWIFT_AGENT_API_KEY ?? '',
  baseUrl: process.env.SWIFT_AGENT_BASE_URL,
});

app.agent(supportAgent);

// Starts the tool runner and registers the agent with the control plane.
await app.listen();
```

> `app.listen()` requires runner-token verification config:
> `RUNNER_TOKEN_PUBLIC_KEY` (PEM or JWK) and `RUNNER_WORKSPACE_ID` — via env vars
> or `createAgentApp({ runnerPublicKey, runnerWorkspaceId })`. `RUNNER_AUDIENCE`
> (falling back to `TOOL_RUNNER_PUBLIC_URL`) is optional. Without a resolvable
> public key and workspace id, `listen()` throws.

## 4. Mint a session for the browser

The backend calls `app.sessions.create({ agentName })` and returns the client
token + canonical `websocketUrl` to the browser (the workspace API key never
leaves the server):

```ts
const session = await app.sessions.create({
  agentName: 'support-assistant',
  userId: 'demo-user',
});
// session: { sessionId, clientToken, websocketUrl }
```

`websocketUrl` is the canonical `wss://<host>/v1/stream?token=<jwt>` URL — the
gateway reads only the `token` query param and derives the session from its JWT
claims.

## 5. Wire the React hook

Thread the API-provided `websocketUrl` straight into `useAgentChat`. From
[`examples/quickstart/frontend/src/App.tsx`](../examples/quickstart/frontend/src/App.tsx):

```tsx
import { useAgentChat } from '@swiftagent/react';

function Chat({ session }: { session: { sessionId: string; token: string; websocketUrl: string } }) {
  const { messages, send, isStreaming, connectionStatus, lastError } = useAgentChat({
    sessionId: session.sessionId,
    token: session.token,
    websocketUrl: session.websocketUrl,
  });
  // ...render messages, call send(text)...
}
```

There is no hardcoded default for `websocketUrl`; a missing value throws. Always
pass the value returned by session creation.

## Run it →

Follow [`examples/quickstart/README.md`](../examples/quickstart/README.md) for
prerequisites, `.env` configuration, and the exact `pnpm --filter` commands to
start the backend and frontend.
