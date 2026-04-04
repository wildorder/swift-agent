# WS-18: Management Integration & E2E Tests

## Goal

Wire **management API** dependencies into **`apps/server`** service composition: add **`UserRepo`** and **`UserWorkspaceRepo`** to the **`Container`**, extend **`ServerConfig`** with Cognito settings (**issuer URL**, **audience** = client id), pass repos and Cognito options through **`buildApp`** from **`main.ts`**, and ensure **`registerManagementRoutes`** / Cognito plugin registration matches **`packages/api`** composition (**`server.ts`**). Add **Vitest integration tests** using **Testcontainers Postgres** and Fastify **`inject()`** that exercise the full management surface with **locally signed RS256 JWTs** via **`jose`** (no live Cognito). Verify runtime **`/v1/*`** routes still authenticate with **API key** (regression).

## Dependencies

- **WS-14** (Cognito infra) — live User Pool + SSM parameters for deployed envs; **tests do not** call AWS or live JWKS.
- **WS-15** (Management data layer) — `createUserRepo`, `createUserWorkspaceRepo`, `users` / `user_workspaces` tables.
- **WS-16** (Cognito auth plugin) — `registerCognitoAuth(app, { issuerUrl, audience })`, `ENV_KEYS`: `COGNITO_USER_POOL_ID`, `COGNITO_ISSUER_URL`, `COGNITO_CLIENT_ID`; JWKS path validated in WS-16 unit tests.
- **WS-17** (Management routes) — `registerManagementRoutes`, extended **`BuildAppOptions`**, management registration in **`server.ts`**.
- **product-x WS-11** (Service Composition) — patterns for **`buildContainer`**, **`buildApp`** options, and server startup.

## Context Files (Agent MUST read before implementing)

- `c:\dev\swift-agent\apps\server\src\container.ts` — `Container`, `buildContainer`.
- `c:\dev\swift-agent\apps\server\src\main.ts` — `startServer`, `buildApp` call site.
- `c:\dev\swift-agent\apps\server\src\config.ts` — `ServerConfig`, `loadServerConfig`.
- `c:\dev\swift-agent\packages\api\src\server.ts` — `buildApp`, management + auth registration order.
- `c:\dev\swift-agent\packages\api\src\middleware\cognito-auth.ts` — WS-16; identify or add **test-only JWKS override** (see Implementation Steps).
- `c:\dev\swift-agent\packages\shared\src\config.ts` — `ENV_KEYS`, `AppConfig` / Cognito keys.
- `c:\dev\swift-agent\test\setup-db.ts` and existing integration tests (e.g. `test/integration/db.integration.test.ts`) — Postgres container, `DATABASE_URL`, migrations.

## Package

- `c:\dev\swift-agent\apps\server\`
- `c:\dev\swift-agent\packages\api\` — only if threading **`BuildAppOptions`** / Cognito test hook needs completion after WS-17.
- `c:\dev\swift-agent\` (root) — new integration test file + Vitest config touch if required.

## Files Touched

- `apps/server/src/container.ts` **(MODIFY)** — import `createUserRepo`, `createUserWorkspaceRepo`; add **`userRepo`**, **`userWorkspaceRepo`** to **`Container.repos`** (same `db` as other repos).
- `apps/server/src/config.ts` **(MODIFY)** — extend **`ServerConfig`** / **`loadServerConfig`** with Cognito fields from **`ENV_KEYS`** (`COGNITO_ISSUER_URL`, **`COGNITO_CLIENT_ID`** as **audience**, `COGNITO_USER_POOL_ID` if required by shared typing or logging).
- `apps/server/src/main.ts` **(MODIFY)** — pass **`userRepo`**, **`userWorkspaceRepo`**, **`workspaceRepo`**, **`apiKeyRepo`**, and **`{ issuerUrl, audience }`** into **`buildApp`** per WS-17; no second DB client.
- `packages/api/src/middleware/cognito-auth.ts` **(MODIFY)** *if needed* — optional **`jwks` / `localJwkSet` / `getKey`** (or env-gated test path) so integration tests use **`createLocalJWKSet`** or injected public JWKs **without** HTTP fetch to AWS JWKS.
- `packages/api/src/server.ts` **(MODIFY)** *only if* WS-17 left gaps — fully wire management + Cognito opts from caller.
- `test/integration/management.integration.test.ts` **(NEW)** — E2E-style suite (see Tests).
- `vitest.config.*` or package test config **(MODIFY)** only if the new suite needs explicit project `include` / `setupFiles`.

## Existing Interfaces to Consume

- **`buildApp`** / **`BuildAppOptions`** — management repos + Cognito options from WS-17.
- **`registerCognitoAuth`**, **`registerManagementRoutes`** (or equivalent exports) — correct **order** on the Fastify instance (Cognito on management scope, then routes).
- **`UserRepo`**, **`UserWorkspaceRepo`**, **`WorkspaceRepo`**, **`ApiKeyRepo`** — WS-15 / product-x.
- **`createDbClient`**, repository factories from **`@swiftagent/db`**.
- **`jose`**: `SignJWT`, `generateKeyPair` (RSA), `exportJWK`, **`createLocalJWKSet`** — sign test tokens; supply public side to auth validation **without** network (per test strategy below).

## Implementation Steps

1. **Config** — Map **`COGNITO_ISSUER_URL`** → **`issuerUrl`**; **`COGNITO_CLIENT_ID`** → **`audience`** for **`registerCognitoAuth`**. Align validation with program manifest (required when management is enabled, or always once WS-14 is default).

2. **Container** — In **`buildContainer`**, add **`userRepo: createUserRepo(db)`**, **`userWorkspaceRepo: createUserWorkspaceRepo(db)`**; update **`Container`** TypeScript interface.

3. **Composition** — In **`main.ts`**, extend **`buildApp({ repos: { ... }, ... })`** with new repos and Cognito **`issuerUrl`** / **`audience`**. Confirm **`packages/api`** **`server.ts`** registers management plugin and Cognito so **`apps/server`** does not duplicate plugins.

4. **Integration test auth (no real Cognito)** — Prefer **injecting a local JWK set**: generate RSA key pair in test file; sign JWTs with private key; pass **`createLocalJWKSet([publicJwk])`** or equivalent **optional parameter** into **`registerCognitoAuth`** / **`buildApp`** test options. **Alternative**: mock **`fetch`** for JWKS URL only in tests — acceptable if isolated and documented. **Do not** rely on AWS JWKS in CI. Token **`iss`** / **`aud`** / **`sub`** must match config and route expectations.

5. **Regression** — One test: create/use a valid **API key** and call an existing **`/v1/*`** route that uses API key middleware (expect **200**, not **401**), proving management path changes did not break runtime auth.

## Tests

- **Stack**: Vitest + **`@testcontainers/postgresql`**; reuse **`test/setup-db.ts`** patterns (migrate schema, **`DATABASE_URL`**).
- **App**: Build Fastify app via **`buildApp`** (or minimal documented helper) with **same middleware order** as production; use **`inject()`** for HTTP assertions.
- **Tokens**: RSA key pair; **`jose`** `SignJWT` with **`alg: RS256`**; claims: **`iss`** = configured issuer, **`aud`** = client id, **`sub`** = synthetic Cognito subject, **`email`** as WS-17 handlers expect; test missing/expired/wrong signature.

**Scenarios**

- **`GET /v1/management/me`** — first request **JIT-creates** user; second returns **same** user.
- **`POST /v1/management/workspaces`** — creates workspace; creator is **owner**.
- **`GET /v1/management/workspaces`** — lists **only** the authenticated user’s workspaces.
- **`GET /v1/management/workspaces/:id`** — **200** for member; **403** for non-member (second user token / different **`sub`**).
- **`POST /v1/management/workspaces/:id/keys`** — response exposes **raw key once**; DB/list must not leak raw key afterward.
- **`GET /v1/management/workspaces/:id/keys`** — lists metadata **without** raw key (and **without** hash if that is the product rule).
- **`DELETE /v1/management/workspaces/:id/keys/:keyId`** — revokes; list reflects **`revokedAt`** or absence per API contract.
- **401** — missing **`Authorization`**, invalid JWT, wrong signature, **expired** `exp`.
- **403** — non-member access where applicable (e.g. workspace detail / keys).
- **Regression** — **`/v1/*`** with API key still **200** on a representative route.

## Acceptance Criteria

1. **`Container.repos`** includes **`userRepo`** and **`userWorkspaceRepo`** built from the shared **`db`** instance.
2. **`ServerConfig`** exposes Cognito **`issuerUrl`** and **`audience`** (client id) consistent with **`ENV_KEYS`**.
3. **`main.ts`** passes all management + Cognito dependencies into **`buildApp`**; management routes are reachable when server is composed.
4. **`test/integration/management.integration.test.ts`** covers all scenarios under Tests; **no** outbound call to real Cognito or AWS JWKS in default CI run.
5. API key regression test passes.
6. **`pnpm exec tsc --noEmit`** and **`pnpm exec eslint . --quiet`** pass; integration tests pass in the configured Vitest project.
