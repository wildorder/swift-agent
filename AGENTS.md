<!-- BEGIN UNIVERSAL — source: @wildorder/program-pipeline packaged default -->
# Agent Directives: Universal

These directives apply to every agent working in this repository, regardless
of provider or harness.

## Scope and depth

1. SPEC-FIRST: When a workstream spec exists under `tasks/`, read it before
   implementing. Do not invent architecture that contradicts the spec or
   `docs/vision.md`. If the spec is ambiguous, ask — do not guess.

2. ROOT CAUSE OVER SYMPTOM: Prefer the smallest diff that fully solves the
   root cause, not the smallest diff that makes symptoms disappear. When the
   proper fix is out of scope, say so explicitly and propose it as a
   follow-up instead of silently shipping a band-aid.

3. STRUCTURAL FIXES STAY IN SCOPE: If architecture is flawed, state is
   duplicated, or patterns are inconsistent inside the files the task already
   touches, fix it. Do not expand into unrelated modules without asking. On
   question-only or review-only tasks, answer — do not rewrite code unless
   asked.

## Verification

4. VERIFY BEFORE CLAIMING COMPLETION: A successful file write proves nothing
   about correctness. Before reporting a task complete, run the project's
   configured build, type-check, test, and lint commands and fix every
   resulting error. If one of those commands is not configured, state that
   explicitly instead of claiming it passed.

## Edit safety

5. READ BEFORE EDITING: Read a file before modifying it, and re-read any file
   you have not seen recently in a long session before editing it again.

6. EXHAUSTIVE RENAMES: When renaming any function, type, or variable, search
   for direct references, type-level references, string literals, dynamic
   imports, re-exports, and test files. Do not assume one search pass caught
   everything.

## Large tasks

7. WORK IN VERIFIABLE PHASES: Break multi-file work into phases that each
   pass verification on their own. In interactive sessions, pause between
   phases for review; in automated pipeline runs, complete and verify each
   phase before starting the next.

8. PARALLELIZE INDEPENDENT WORK: When the harness supports sub-agents and the
   task spans many independent files, split the work rather than degrading a
   single context; keep tightly coupled changes together.
<!-- END UNIVERSAL -->

---

## Project: swift-agent

See `docs/vision.md` for the full product vision.
See `docs/programs/` for program plans and manifests.
See `tasks/{program-id}/` for workstream specs.

### Tech Stack

Node 22 LTS, TypeScript strict, ESM-only (`"type": "module"`). pnpm workspaces
(`pnpm@9.15.4`) + Turborepo. Fastify 5 + `@fastify/websocket` for HTTP and
WebSocket transport. Drizzle ORM over the `postgres.js` driver (NOT `pg`).
Zod for runtime validation. `jose` for JWT. `ioredis` for Redis. `nanoid` for
IDs. Vitest + Testcontainers for tests. AWS Cognito (OIDC) for management-API
auth — no Amplify, no AWS SDK for auth.

### Product

Open-source real-time agent runtime — the self-hostable transport and tool-execution layer beneath streaming, tool-calling, multi-model AI agents. Adopters run it themselves; their tools execute in their own codebase and their data stays in their own Postgres.

### Conventions

**Layout.** Library packages live under `packages/` scoped `@swiftagent/*`
(`shared`, `db`, `models`, `runtime`, `gateway`, `api`, `observability`, `sdk`,
`react`); the deployable app is `apps/server`. Runnable examples live under
`examples/`. Cross-package suites live in the root `test/` tree
(`integration/`, `acceptance/`, `smoke/`, `support/`).

**Types and validation.** Zod schemas are the source of truth — derive
TypeScript types with `z.infer<>`, never hand-write the type and validate
against it separately. Every env var is declared in `@swiftagent/shared`
`ENV_KEYS`, the single source of truth.

**Naming.** IDs are prefixed: `ses_`, `msg_`, `run_`, `tc_`, `agt_`, `ws_`,
`ak_`, `usr_`. Repositories are factory functions — `createXxxRepo(db: Db)` —
not classes. Model providers implement the `ModelProvider` interface and
register in a `ProviderRegistry`.

**Core contracts.** Stream events use the `ChatEvent` discriminated union from
`@swiftagent/shared`. The core loop is an async generator yielding `ChatEvent`.

**Auth.** Two layers: API-key auth on `/v1/*` (runtime), Cognito JWT auth on
`/v1/management/*` (dashboard/CLI). Cognito JWTs are validated via JWKS
(`jose` `createRemoteJWKSet`). Management routes are a separate Fastify plugin
and prefix with their own auth middleware. User ↔ workspace mapping lives in
the `users` table (Cognito `sub` → `usr_` ID) and the `user_workspaces` join
table.

**Dependencies.** Any `@swiftagent/*` package you import must also be declared
in that package's `package.json`. An undeclared import still passes CI via
tsconfig path mapping but crashes in the production Docker image (built with
`--prod` prune) as `ERR_MODULE_NOT_FOUND`.

**Style.** Prettier: single quotes, semicolons, trailing commas, 100-column
width, 2-space indent. ESLint uses `typescript-eslint` **strict** with
`consistent-type-imports` required and unused vars errored unless prefixed `_`.

**Testing.** Unit tests use mocks and live beside the package they cover.
Integration tests use Testcontainers Postgres (`pnpm test:integration`, needs
Docker) and acceptance tests use `pnpm test:acceptance`. Note that the root
`test/` tree is excluded from `pnpm typecheck` and `pnpm lint` — changes there
are only validated by actually running those suites.

**Delivery.** `@swiftagent/sdk`, `@swiftagent/react`, and `@swiftagent/shared`
publish to public npm (`registry.npmjs.org`, Apache-2.0); every other package
is `private`. Releases go through Changesets (`pnpm changeset`).

### Dependency Versions (pin these)

| Package | Version |
|---------|---------|
| drizzle-orm | ^0.36 |
| drizzle-kit | ^0.30 |
| fastify | ^5 |
| @fastify/websocket | ^11 |
| jose | ^6 |
| zod | ^3.24 |
| ioredis | ^5 |
| vitest | ^3 |
| nanoid | ^5 |
| postgres | ^3.4 |
| typescript | ^5.5 |
| turbo | ^2 |
