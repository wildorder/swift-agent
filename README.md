# Swift Agent

Swift Agent is a **hosted real-time agent runtime**. It lets developers embed a
streaming, tool-calling, multi-model AI agent into any application without
building WebSocket infrastructure, model adapters, tool orchestration, or session
management. You define agents and register tools with the SDK; Swift Agent's
cloud handles WebSocket transport, token streaming, the model loop, tool-call
routing, session persistence, and observability.

See [`swift-agent.md`](./swift-agent.md) for the full product vision and
[`docs/`](./docs) for the architecture and as-built docs.

## Packages

| Package | What it is |
| --- | --- |
| [`@swiftagent/sdk`](./packages/sdk) | Server SDK — define agents and Zod-schema tools, mint sessions, host the tool runner. |
| [`@swiftagent/react`](./packages/react) | React hooks (`useAgentChat`) + a vanilla-JS client for streaming chat UIs. |
| [`@swiftagent/shared`](./packages/shared) | Shared source of truth — Zod schemas, the `ChatEvent` union, `ENV_KEYS`, ID prefixes, runner protocol constants. Installed transitively with the SDKs. |

Deployable control plane lives under [`apps/server`](./apps/server).

## Quickstart

Read the narrative walk-through in [`docs/quickstart.md`](./docs/quickstart.md),
which wires an agent end to end using the canonical, CI-maintained example in
[`examples/quickstart/`](./examples/quickstart). Run instructions live in
[`examples/quickstart/README.md`](./examples/quickstart/README.md).

`@swiftagent/*` packages publish to GitHub Packages (the `@swiftagent` scope's
private registry); configure `@swiftagent:registry=https://npm.pkg.github.com`
with a `read:packages` token, then `pnpm add @swiftagent/sdk @swiftagent/react`.

## Development

This is a pnpm + Turborepo monorepo (Node 22 LTS, TypeScript strict, ESM).

```
pnpm install      # install workspace dependencies
pnpm typecheck    # type-check every package
pnpm lint         # lint every package
pnpm test         # run unit tests
```
