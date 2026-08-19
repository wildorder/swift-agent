# Swift Agent

Swift Agent is an **open-source real-time agent runtime** — the transport and
tool-execution layer for streaming, tool-calling AI agents. It owns the WebSocket
gateway, the model↔tool loop, tool-call routing across a network boundary,
session persistence, and run-level tracing.

**You run it.** Your tool handlers execute in your own codebase against your own
credentials; sessions and messages persist to your own Postgres. Locally that is
one command; in production it is your cloud.

See [`docs/vision.md`](./docs/vision.md) for the full product vision and
[`docs/`](./docs) for the architecture and as-built docs.

## What it solves

The commodity parts of an agent stack — the model loop, provider abstraction,
persisting messages — take an afternoon. These do not, and are where Swift Agent
puts its weight:

- **WebSocket transport** with connection auth, session multiplexing,
  reconnection, and multi-process fan-out over Redis.
- **A hardened tool-call boundary** — scoped short-lived runner credentials,
  deadlines, idempotency keys, SSRF guards, and a versioned wire protocol that
  upgrades without breaking deployed runners.
- **Run-level tracing** that survives a reconnect, plus server-driven runs that
  need no browser attached.

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

> **Distribution is mid-migration.** `@swiftagent/*` currently publishes to
> GitHub Packages (the `@swiftagent` scope's private registry): configure
> `@swiftagent:registry=https://npm.pkg.github.com` with a `read:packages`
> token, then `pnpm add @swiftagent/sdk @swiftagent/react`. Public npm publishing
> is planned as part of the open-source release; until it lands, the private
> registry is the only install path.

## Self-hosting

The runtime is designed to be run by the people using it. Agent code is identical
at every rung of the ladder — same `defineAgent`, same `tool()`, same
`useAgentChat`; only the server URL moves.

| Rung | Effort | Status |
| --- | --- | --- |
| Hosted playground | Zero — open a link | Planned |
| `create-swift-agent` scaffold | ~60s | Planned |
| `docker compose up` | ~5 min, local | [`docker-compose.yml`](./docker-compose.yml) covers dependencies |
| `terraform apply` | ~20 min, your AWS | [`infra/`](./infra) — dev / staging / prod |

## Development

This is a pnpm + Turborepo monorepo (Node 22 LTS, TypeScript strict, ESM).

```
pnpm install      # install workspace dependencies
pnpm typecheck    # type-check every package
pnpm lint         # lint every package
pnpm test         # run unit tests
```
