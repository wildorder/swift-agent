# Swift Agent — Program Plan (Phase 1 MVP)

## Program Overview

**Status:** Completed on 2026-07-15.

**Product:** Swift Agent — a hosted real-time agent runtime that lets developers embed streaming, tool-calling, multi-model AI agents into any application.

**One-liner:** Ship a production-ready AI agent in minutes — not weeks.

**Program scope:** Phase 1 MVP — deliver the minimum complete stack from SDK to streaming UI that a developer can use to stand up an agent in their app.

---

## Strategic Goals

1. **Zero-infrastructure agent deployment** — Developers define agents and tools; Swift Agent handles transport, streaming, model orchestration, session persistence, and observability.
2. **Sub-5-minute time-to-hello-world** — A developer with an API key should have a streaming agent chat working in under 5 minutes.
3. **Model portability** — Agents work across OpenAI, Anthropic, and Google models via a single `model` string.
4. **Security by architecture** — Customer secrets and internal APIs never leave their infrastructure. The SDK tool runner executes locally on customer infra.

---

## Architecture Summary

```
Customer Frontend (React / any UI)
        │ WebSocket
        ▼
Swift Agent Realtime Gateway
  - Connection auth (short-lived client tokens)
  - Session multiplexing
  - Structured event streaming
        │
        ▼
Swift Agent Runtime
  - Message loop (model ↔ tool)
  - Multi-model provider abstraction
  - Partial token streaming
  - Context window management
        │                    │
        ▼                    ▼
Session DB (Postgres)    Customer Tool Runner (SDK)
  - Threads                - Registered tool handlers
  - Messages               - Executes locally
  - Runs                   - Returns results to runtime
  - Tool calls
        │
        ▼
Model Provider Layer (OpenAI / Anthropic / Google)
```

---

## Monorepo Structure

```
swift-agent/
├── packages/
│   ├── shared/            # Shared types, event protocol, config, utils
│   ├── db/                # Postgres schema, migrations, repositories
│   ├── models/            # Model provider abstraction layer
│   ├── runtime/           # Agent runtime engine (core loop)
│   ├── gateway/           # WebSocket realtime gateway
│   ├── api/               # Control plane REST API
│   ├── sdk/               # @swiftagent/sdk (server-side)
│   ├── react/             # @swiftagent/react (client-side)
│   └── observability/     # Tracing and structured logging
├── apps/
│   └── server/            # Deployable service entry point (API + gateway + runtime)
├── infra/
│   └── env/               # Environment config templates (dev, staging, prod)
├── .github/
│   └── workflows/         # CI/CD pipelines (ci, deploy-dev, deploy-staging, deploy-prod, publish-sdks)
├── docs/
│   └── programs/
├── tasks/
│   └── product-x/
├── package.json           # Workspace root (pnpm workspaces)
├── tsconfig.base.json     # Shared TypeScript config
├── turbo.json             # Turborepo build orchestration
├── docker-compose.yml     # Local dev stack (Postgres, Redis, server)
└── vitest.workspace.ts    # Test configuration
```

---

## Technology Choices

| Layer             | Choice                          | Rationale                                           |
| ----------------- | ------------------------------- | --------------------------------------------------- |
| Language          | TypeScript (strict mode)        | Target audience is JS/TS developers                 |
| Monorepo          | pnpm workspaces + Turborepo    | Fast installs, efficient caching, parallel builds   |
| API framework     | Fastify                         | High performance, schema validation, WebSocket plugin|
| Database          | PostgreSQL                      | Relational integrity for sessions/messages/runs     |
| DB client         | Drizzle ORM                     | Type-safe, lightweight, migration support           |
| Transport         | WebSocket (ws library)          | Bidirectional real-time streaming                   |
| Cache / Pub-Sub   | Redis (ioredis)                 | Stream fanout, connection state, rate limiting      |
| Testing           | Vitest                          | Fast, native ESM, TypeScript-first                  |
| Model SDKs        | Official provider SDKs          | OpenAI, Anthropic, Google AI SDKs                   |
| Validation        | Zod                             | Runtime schema validation, TypeScript inference     |
| Logging           | pino                            | Structured JSON logging, fast                       |
| Cloud             | AWS (ECS Fargate, RDS, ElastiCache, ALB, ECR) | Mature, WebSocket-friendly, scalable   |
| IaC               | Terraform                       | Largest ecosystem, provider-agnostic, team-hirable  |
| CI/CD             | GitHub Actions                  | Native to repo, OIDC for AWS auth, no extra service |

---

## Workstreams

The MVP is broken into 16 workstreams. Each is sized to be completable in a single focused agentic session with no context degradation.

| ID     | Workstream                                   | Dependencies                  | Estimated Effort |
| ------ | -------------------------------------------- | ----------------------------- | ---------------- |
| WS-01  | Project Foundation & Monorepo                | None                          | S                |
| WS-02  | Shared Types & Protocol Definitions          | WS-01                         | S                |
| WS-03  | Database & Data Access Layer                 | WS-01, WS-02                 | M                |
| WS-04a | Model Types, Interface & Registry            | WS-01, WS-02                 | S                |
| WS-04b | Provider Implementations (OpenAI/Anthropic/Google) | WS-04a                  | M                |
| WS-05a | Tool Executor (Interface + Local + Remote)   | WS-01, WS-02                 | S                |
| WS-05b | Core Loop, Engine & Memory                   | WS-03, WS-04a, WS-05a        | M                |
| WS-06  | Realtime WebSocket Gateway                   | WS-02, WS-03, WS-05b         | M                |
| WS-07  | Control Plane REST API                       | WS-02, WS-03                 | M                |
| WS-08  | Server SDK (`@swiftagent/sdk`)               | WS-05b, WS-07                | M                |
| WS-09  | Client SDKs (`@swiftagent/react`)            | WS-02, WS-06                 | M                |
| WS-10  | Observability & Tracing                      | WS-03, WS-05b, WS-07         | M                |
| WS-11  | Service Composition                          | WS-01 through WS-10          | M                |
| WS-12  | CI Pipeline, Docker & Branch Strategy        | WS-01                         | S                |
| WS-13a | Terraform Foundation & Data Infrastructure   | WS-12                         | M                |
| WS-13b | ECS, Load Balancer, DNS & Deploy Workflows   | WS-11, WS-12, WS-13a         | M                |

**Size key:** S = 1-2 days, M = 3-5 days

---

## Dependency Graph

```
WS-01 (Foundation)
  ├── WS-12 (CI + Docker) ← starts immediately
  └── WS-02 (Shared Types + Config)
       ├── WS-04a (Model Types/Interface/Registry) → WS-04b (Provider Impls)
       ├── WS-05a (Tool Executor Interface + Impls)
       └── WS-03 (Database)
            ├── WS-07 (API)
            │    └── WS-08 (SDK) ← WS-05b + WS-07
            └── WS-05b (Core Loop/Engine) ← WS-03 + WS-04a + WS-05a
                 ├── WS-06 (Gateway) ← WS-02 + WS-03 + WS-05b
                 │    └── WS-09 (Client SDKs) ← WS-02 + WS-06
                 ├── WS-10 (Observability) ← WS-03 + WS-05b + WS-07
                 └── WS-08 (SDK) ← WS-05b + WS-07

WS-11 (Service Composition) ← all of WS-01 through WS-10
WS-13a (Terraform Foundation) ← WS-12
WS-13b (ECS + Deploy) ← WS-11 + WS-12 + WS-13a
```

---

## Critical Path

The longest dependency chain determines the minimum timeline:

**WS-01 → WS-02 → WS-03 + WS-04a + WS-05a (parallel) → WS-05b → WS-06 → WS-11 → WS-13b**

This chain flows: Foundation → Types → Data + Model Interface + Tool Executor (parallel) → Core Loop → Gateway → Composition → Deploy

Parallelizable work (up to 6 workstreams can run concurrently after WS-02):
- WS-03, WS-04a, and WS-05a are fully independent of each other
- WS-04b can start as soon as WS-04a is done (parallel with WS-03, WS-05a)
- WS-07 can start once WS-02 + WS-03 are done
- WS-12 starts immediately after WS-01 (CI on every PR from day one)
- WS-13a starts after WS-12 (Terraform modules, no application code needed)
- WS-08, WS-10 can proceed once WS-05b + WS-07 are done
- WS-09 proceeds once WS-06 is done

---

## Phase 1 Scope (In)

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

## Phase 1 Scope (Out)

- Durable long-running job execution
- Multi-agent orchestration / planner
- Hosted secrets management
- Complex workflow builder
- Vector database / RAG infrastructure
- Browser automation tools
- Prompt versioning / management
- Model fallback rules

---

## Risk Register

| Risk                                        | Impact | Mitigation                                                       |
| ------------------------------------------- | ------ | ---------------------------------------------------------------- |
| Model provider API breaking changes         | High   | Adapter pattern isolates each provider; pin SDK versions         |
| WebSocket scaling under load                | High   | Redis pub-sub for horizontal scaling; load test early            |
| Tool runner latency / timeout               | Medium | Configurable timeouts, async result pattern, circuit breaker     |
| Context window overflow                     | Medium | Memory strategies (last-N, summary) with configurable limits    |
| SDK DX friction                             | High   | Dogfood with example app; iterate on API surface before release  |
| Schema migration complexity                 | Low    | Drizzle migrations; keep Phase 1 schema minimal and additive    |

---

## Success Criteria (Phase 1 Complete)

1. A developer can `npm install @swiftagent/sdk`, define an agent with tools, and have a streaming chat working end-to-end.
2. The runtime correctly executes the message → model → tool → model → response loop with partial token streaming.
3. Sessions persist across reconnections; message history is retrievable via API.
4. All three model providers (OpenAI, Anthropic, Google) work through a unified interface.
5. The React hook (`useAgentChat`) provides a working chat UI with connection status, streaming state, and error handling.
6. Run-level traces capture every model call, tool invocation, and latency measurement.
7. The service composition (`apps/server`) boots all packages as a single deployable process with health checks and graceful shutdown.
