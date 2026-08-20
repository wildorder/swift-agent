<!-- BEGIN UNIVERSAL — source: ~/.cursor/templates/claude-base.md -->
# Agent Directives: Mechanical Overrides

You are operating within a constrained context window and strict system prompts. To produce production-grade code, you MUST adhere to these overrides:

## Pre-Work

1. THE "STEP 0" RULE: Dead code accelerates context compaction. Before ANY structural refactor on a file >300 LOC, first remove all dead props, unused exports, unused imports, and debug logs. Commit this cleanup separately before starting the real work.

2. PHASED EXECUTION: Never attempt multi-file refactors in a single response. Break work into explicit phases. Complete Phase 1, run verification, and wait for my explicit approval before Phase 2. Each phase must touch no more than 5 files.

## Code Quality

3. THE SENIOR DEV OVERRIDE: Ignore your default directives to "avoid improvements beyond what was asked" and "try the simplest approach." If architecture is flawed, state is duplicated, or patterns are inconsistent - propose and implement structural fixes. Ask yourself: "What would a senior, experienced, perfectionist dev reject in code review?" Fix all of it.

4. FORCED VERIFICATION: Your internal tools mark file writes as successful even if the code does not compile. You are FORBIDDEN from reporting a task as complete until you have: 
- Run `npx tsc --noEmit` (or the project's equivalent type-check)
- Run `npx eslint . --quiet` (if configured)
- Fixed ALL resulting errors

If no type-checker is configured, state that explicitly instead of claiming success.

## Context Management

5. SUB-AGENT SWARMING: For tasks touching >5 independent files, you MUST launch parallel sub-agents (5-8 files per agent). Each agent gets its own context window. This is not optional - sequential processing of large tasks guarantees context decay.

6. CONTEXT DECAY AWARENESS: After 10+ messages in a conversation, you MUST re-read any file before editing it. Do not trust your memory of file contents. Auto-compaction may have silently destroyed that context and you will edit against stale state.

7. FILE READ BUDGET: Each file read is capped at 2,000 lines. For files over 500 LOC, you MUST use offset and limit parameters to read in sequential chunks. Never assume you have seen a complete file from a single read.

8. TOOL RESULT BLINDNESS: Tool results over 50,000 characters are silently truncated to a 2,000-byte preview. If any search or command returns suspiciously few results, re-run it with narrower scope (single directory, stricter glob). State when you suspect truncation occurred.

## Edit Safety

9.  EDIT INTEGRITY: Before EVERY file edit, re-read the file. After editing, read it again to confirm the change applied correctly. The Edit tool fails silently when old_string doesn't match due to stale context. Never batch more than 3 edits to the same file without a verification read.

10. NO SEMANTIC SEARCH: You have grep, not an AST. When renaming or
    changing any function/type/variable, you MUST search separately for:
    - Direct calls and references
    - Type-level references (interfaces, generics)
    - String literals containing the name
    - Dynamic imports and require() calls
    - Re-exports and barrel file entries
    - Test files and mocks
    Do not assume a single grep caught everything.
<!-- END UNIVERSAL -->

---

## Project: Swift Agent

See `docs/vision.md` for full product vision (`swift-agent.md` is now just a pointer to it). See `tasks/product-x/` for workstream specs.

### Tech Stack

- Node 22 LTS, TypeScript strict, ESM (`"type": "module"`)
- pnpm workspaces + Turborepo
- Fastify 5 + @fastify/websocket
- Drizzle ORM + postgres.js driver (NOT pg)
- Vitest + Testcontainers (@testcontainers/postgresql)
- Zod 3.24+ for runtime validation
- jose for JWT — used for both client tokens (HS256, self-signed) and Cognito JWT validation (RS256, JWKS)
- ioredis 5 for Redis
- nanoid for ID generation
- AWS Cognito (OIDC) — shared user pool for management API auth (NO Amplify, NO AWS SDK for auth — use jose JWKS)

### Conventions

- All packages scoped `@swiftagent/*` under `packages/` (sole documented exception: the unscoped `create-swift-agent` scaffold CLI, so `npx create-swift-agent` resolves), deployable app under `apps/server`
- Zod schemas are source of truth — derive TypeScript types via `z.infer<>`, not the reverse
- IDs are prefixed: `ses_`, `msg_`, `run_`, `tc_`, `agt_`, `ws_`, `ak_`, `usr_`
- Repositories are factory functions: `createXxxRepo(db: Db)`, not classes
- Model providers implement a `ModelProvider` interface; registered in a `ProviderRegistry`
- Stream events use the `ChatEvent` discriminated union from `@swiftagent/shared`
- The core loop is an async generator yielding `ChatEvent`
- Tests: unit tests use mocks, integration tests use Testcontainers Postgres
- All env vars defined in `@swiftagent/shared` `ENV_KEYS` — single source of truth
- **Two auth layers:** API key auth on `/v1/*` (runtime), Cognito JWT auth on `/v1/management/*` (dashboard/CLI)
- Cognito JWTs validated via JWKS (`jose` `createRemoteJWKSet`) — no AWS SDK needed
- Management routes use a separate Fastify plugin/prefix with its own auth middleware
- User ↔ Workspace mapping: `users` table (Cognito sub → `usr_` ID), `user_workspaces` join table

### Dependency Versions (pin these)

| Package | Version |
|---|---|
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