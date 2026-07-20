# @swiftagent/react

React hooks and components for building Swift Agent chat UIs. It wraps the Swift Agent streaming protocol in idiomatic React state so you can render live agent conversations with minimal wiring. Requires React 18 or 19 (declared as a peer dependency).

## Install

`@swiftagent/*` packages are published to the org's private GitHub Packages registry, not public npm. Add the scope mapping to your `.npmrc` (already committed at the repo root here) and authenticate with a token that has `read:packages`:

```ini
@swiftagent:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PKG_TOKEN}
```

```sh
pnpm add @swiftagent/react
```

`@swiftagent/shared` is pulled in transitively — you do not add it yourself.

## Usage

Fetch a session from your backend (which calls `app.sessions.create(...)`), then
thread the returned `websocketUrl` into `useAgentChat`. This snippet is derived
from [`examples/quickstart/frontend/src/App.tsx`](../../examples/quickstart/frontend/src/App.tsx):

```tsx
import { useAgentChat } from '@swiftagent/react';

function Chat({ session }: { session: { sessionId: string; token: string; websocketUrl: string } }) {
  const { messages, send, isStreaming, connectionStatus, lastError } = useAgentChat({
    sessionId: session.sessionId,
    token: session.token,
    websocketUrl: session.websocketUrl,
  });

  return (
    <div>
      {lastError ? <p>Error: {lastError}</p> : null}
      <ul>
        {messages.map((m) => (
          <li key={m.id}><strong>{m.role}: </strong>{m.content}</li>
        ))}
      </ul>
      <button disabled={connectionStatus !== 'connected'} onClick={() => send('echo hello')}>
        Send{isStreaming ? ' …' : ''}
      </button>
    </div>
  );
}
```

### `websocketUrl` is the source of truth

`websocketUrl` is the canonical `wss://<host>/v1/stream?token=<jwt>` value
returned by `POST /v1/sessions` (surfaced by the SDK's
`app.sessions.create(...)` as `CreateSessionResult.websocketUrl`). Pass it
verbatim — the gateway reads only the `token` query param and derives the
session from its JWT claims.

There is **no hardcoded default**: a missing/empty `websocketUrl` throws at
runtime (`createChatSession requires a websocketUrl (the value returned by POST
/v1/sessions)`) rather than silently connecting to a wrong production-looking
URL. Always thread the API-provided value through.

## API surface

| Symbol | Purpose |
| --- | --- |
| `useAgentChat({ sessionId, token, websocketUrl, ... })` | React hook. Returns `{ messages, send, isStreaming, connectionStatus, lastError }`. |
| `createChatSession({ sessionId, token, websocketUrl, ... })` | Vanilla-JS client. Returns `{ sendMessage, onEvent, disconnect, connectionStatus }`. |

Public types: `UseAgentChatArgs`, `UseAgentChatResult`, `CreateChatSessionOptions`,
`ChatSessionClient`, `ConnectionStatus`, `ChatMessage`, `ToolCallInfo`,
`ReconnectOptions`, and the re-exported `ChatEvent`.

## Learn more

- Quickstart walk-through: [`docs/quickstart.md`](../../docs/quickstart.md)
- Runnable example: [`examples/quickstart/`](../../examples/quickstart)
