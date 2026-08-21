# @swiftagent/shared

Shared types, Zod schemas, ID helpers, and the Redis client used across Swift Agent packages. It is the source of truth for the `ChatEvent` union, the prefixed-ID helpers, and the `ENV_KEYS` env-var contract, and is pulled in transitively by `@swiftagent/sdk` and `@swiftagent/react`. The Redis client is available from the `@swiftagent/shared/redis` subpath.

## Install

Install from public npm — no registry configuration or token needed:

```sh
pnpm add @swiftagent/shared
```

> **You rarely install this directly.** `@swiftagent/shared` is a transitive
> dependency of both `@swiftagent/sdk` and `@swiftagent/react` and is pulled in
> automatically when you add either SDK. Depend on it explicitly only if you are
> building against the raw schemas/records yourself.

## What it exports

- **`ChatEvent` union + schemas** — the discriminated `ChatEvent` type plus
  `ChatEventSchema` and the per-event schemas (`MessageStartedEventSchema`,
  `TokenEventSchema`, `ToolCallStartedEventSchema`, `ToolCallCompletedEventSchema`,
  `MessageCompletedEventSchema`, `RunFailedEventSchema`). This is the structured
  stream contract carried over the gateway WebSocket.
- **Config** — `ENV_KEYS` (the single source of truth for every environment
  variable name), `loadConfig`, and the `AppConfig` type.
- **ID prefixes & helpers** — the prefix constants (`PREFIX_SESSION` → `ses_`,
  `PREFIX_MESSAGE` → `msg_`, `PREFIX_RUN` → `run_`, `PREFIX_TOOL_CALL` → `tc_`,
  `PREFIX_AGENT` → `agt_`, `PREFIX_WORKSPACE` → `ws_`, `PREFIX_API_KEY` → `ak_`,
  `PREFIX_USER` → `usr_`, plus trace/span prefixes) with the matching
  `generate*Id` functions and `parsePrefix`.
- **Record types + Zod schemas** — `AgentRecord`, `SessionRecord`,
  `MessageRecord`, `RunRecord`, `WorkspaceRecord`, `ApiKeyRecord`, `UserRecord`,
  `UserWorkspaceRecord`, `ToolCallRecord` and their `*Schema` counterparts.
- **Runner protocol constants (WS-22)** — `RUNNER_PROTOCOL_VERSION`,
  `RUNNER_MAX_INPUT_BYTES` / `RUNNER_MAX_OUTPUT_BYTES` / `RUNNER_MAX_ERROR_BYTES`,
  and the `Runner*Schema` wire schemas for the remote tool-runner contract.
- **Protocol versioning (WS-37)** — `API_PROTOCOL_VERSION`,
  `SDK_MIN_SERVER_PROTOCOL`, `PROTOCOL_HEADER`, `PROTOCOL`, and
  `assertProtocolCompatible`.
- **Redis** — `createRedisClient` (also re-exported from the
  `@swiftagent/shared/redis` subpath).
- **Errors** — `SwiftAgentError`, `SwiftAgentErrorCode`, and `isSwiftAgentError`.

## Learn more

- Quickstart walk-through: [`docs/quickstart.md`](../../docs/quickstart.md)
- Runnable example: [`examples/quickstart/`](../../examples/quickstart)
