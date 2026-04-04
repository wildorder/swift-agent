# WS-17: Management API Routes

## Goal

Implement a Fastify plugin that registers **seven** Cognito-authenticated REST endpoints under **`/v1/management`** for the management-api program: current-user profile (JIT provisioning), workspace create/list/detail, and API key create/list/revoke. Runtime **`/v1/*`** continues to use **API key** auth; management routes use **`registerCognitoAuth`** (WS-16) only inside the management subtree. Define **Zod** request/response schemas for all JSON bodies and export inferred types from `@swiftagent/api` (`types/management.ts` or extended `types.ts`).

## Dependencies

- **WS-15** — `UserRepo`, `UserWorkspaceRepo`, `UserRecord`, `UserWorkspaceRecord`, `generateUserId()`.
- **WS-16** — `registerCognitoAuth`, `ManagementAuthenticatedRequest` (`cognitoSub`, `email`).
- **product-x WS-03** — `WorkspaceRepo`, `ApiKeyRepo`, `WorkspaceRecord`, `ApiKeyRecord`.

## Context Files (Agent MUST read before implementing)

- `c:\dev\swift-agent\packages\api\src\server.ts`
- `c:\dev\swift-agent\packages\api\src\middleware\auth.ts`
- `c:\dev\swift-agent\packages\api\src\middleware\cognito-auth.ts` (WS-16)
- `c:\dev\swift-agent\packages\api\src\types.ts`
- `c:\dev\swift-agent\packages\api\src\index.ts`
- `c:\dev\swift-agent\packages\shared\src\utils\id.ts` — `generateWorkspaceId`, `generateApiKeyId`, `generateUserId`

## Context

Existing `buildApp` registers API key auth globally for `/v1/*` (except health). Management needs **Cognito JWT** instead, so:

1. **Skip API key auth** for `/v1/management/*` by extending **`SKIP_AUTH_PATHS`** (or equivalent) in `middleware/auth.ts` so those paths bypass API key `onRequest`.
2. **Register management** as a **nested** plugin under the `/v1` prefix at **`/management`** (full path **`/v1/management/*`**) **or** register a sibling at `/v1/management` **before** the generic `/v1` plugin—either way, Cognito runs only on that scope. Cleanest: skip in `SKIP_AUTH_PATHS`, then `app.register(managementPlugin, { prefix: '/v1/management' })` **inside** the same `/v1` registration, with **`registerCognitoAuth`** on the management child instance first, then routes.

Reference pattern (`packages/api/src/server.ts`): `registerAuth` → `await app.register(v1Routes, { prefix: '/v1' })`; management must not execute API key validation.

## Package

- `c:\dev\swift-agent\packages\api\`

## Files Touched

- `packages/api/src/middleware/auth.ts` **(MODIFY)** — skip `/v1/management` and `/v1/management/*` from API key middleware.
- `packages/api/src/routes/management/index.ts` **(NEW)** — plugin: `registerCognitoAuth` + register route modules.
- `packages/api/src/routes/management/me.ts` **(NEW)** — `GET /me`.
- `packages/api/src/routes/management/workspaces.ts` **(NEW)** — workspace routes.
- `packages/api/src/routes/management/keys.ts` **(NEW)** — API key routes.
- `packages/api/src/types/management.ts` **(NEW)** *or* `packages/api/src/types.ts` **(MODIFY)** — Zod DTOs.
- `packages/api/src/server.ts` **(MODIFY)** — wire repos + register management plugin.
- `packages/api/src/index.ts` **(MODIFY)** — export management types if public surface requires it.
- `packages/api/src/routes/management/*.test.ts` **(NEW)** — `inject()` tests with mocked repos/auth.

## Existing Interfaces to Consume

**Repos (WS-15 / WS-03)**

- **`UserRepo`**: `create({ userId, cognitoSub, email })`, `getByCognitoSub`, `getById`.
- **`UserWorkspaceRepo`**: `create({ userId, workspaceId, role })`, `listByUserId`, `getByUserAndWorkspace`, `isMember`.
- **`WorkspaceRepo`**: `create({ workspaceId, name })`, `getById`.
- **`ApiKeyRepo`**: `create({ apiKeyId, workspaceId, keyHash, name })`, `listByWorkspace`, `revoke`.

**Auth (WS-16)** — `registerCognitoAuth(app, { issuerUrl, audience })`; handlers use **`ManagementAuthenticatedRequest`** (`cognitoSub`, `email`).

**Types (`@swiftagent/shared`)**

- `WorkspaceRecord`, `ApiKeyRecord` (existing).
- `UserRecord`, `UserWorkspaceRecord` (WS-15).

**ID generation** — `import { generateWorkspaceId, generateApiKeyId, generateUserId } from '@swiftagent/shared'`.

**API key material**

```typescript
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
// rawKey = `ak_${nanoid(40)}`; keyHash = createHash('sha256').update(rawKey).digest('hex');
// Store hash only; return rawKey once in POST response.
```

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/v1/management/me` | Current user; JIT create if missing |
| POST | `/v1/management/workspaces` | Create workspace + owner membership |
| GET | `/v1/management/workspaces` | List current user’s workspaces |
| GET | `/v1/management/workspaces/:id` | Workspace detail (member only) |
| POST | `/v1/management/workspaces/:id/keys` | Create API key; return raw key **once** |
| GET | `/v1/management/workspaces/:id/keys` | List keys (metadata only) |
| DELETE | `/v1/management/workspaces/:id/keys/:keyId` | Revoke key |

## Implementation Steps

1. **Auth skip** — Extend `SKIP_AUTH_PATHS` (or equivalent) for `/v1/management` and nested paths; verify `/health` and non-management `/v1/*` unchanged.

2. **Management plugin** — `routes/management/index.ts`: on child scope, call `registerCognitoAuth`, then register `me`, `workspaces`, `keys` (prefix `/v1/management` via parent registration in `server.ts`).

3. **Zod** — All request bodies and JSON responses in `types/management.ts` (or `types.ts`); export `z.infer<>` types.

4. **`GET /me`** — `getByCognitoSub`; if absent, JIT `generateUserId()`, insert with JWT `cognitoSub` + `email`; **`ON CONFLICT DO NOTHING`** on unique `cognito_sub`, then re-read `getByCognitoSub`.

5. **`POST /workspaces`** — Body includes workspace `name`. `generateWorkspaceId()`, `workspaceRepo.create`, `userWorkspaceRepo.create` with **`role: 'owner'`** (resolve `userId` via same JIT helper as `/me`).

6. **`GET /workspaces`** — `listByUserId` → join/load `getById` per workspace; stable ordering (e.g. membership `createdAt`).

7. **`GET /workspaces/:id`** — `isMember` → **403** if not; `getById` → **404** if workspace missing.

8. **`POST .../keys`** — Membership; body `name`; raw `ak_${nanoid(40)}`, SHA-256 hash, `generateApiKeyId()`, `apiKeyRepo.create`; response: raw key **once** + `apiKeyId`, `name`, `createdAt`, etc.

9. **`GET .../keys`** — Membership; `listByWorkspace`; return **`apiKeyId`, `name`, `createdAt`, `revokedAt`** only — **no** raw key, **no** hash. No `keyPrefix` column required unless a later WS adds it.

10. **`DELETE .../keys/:keyId`** — Membership; ensure key belongs to workspace; `revoke`; **404** if wrong/missing key.

11. **`server.ts`** — Pass `userRepo`, `userWorkspaceRepo`, `workspaceRepo`, `apiKeyRepo` into management plugin; env for Cognito per WS-16.

## Tests

- Use Fastify **`inject()`** with **mocked repos** and **mocked Cognito** (decorate `cognitoSub` / `email` via test-only `preHandler` or equivalent—no real JWKS in route tests).
- Cover: `/me` first-hit creates user, second hit idempotent; workspace **403**/**404**; key create returns raw key once; list has no secrets; revoke behavior per repo return values.

## Acceptance Criteria

1. API key middleware **does not** run for `/v1/management/*`; other `/v1/*` behavior unchanged.
2. All **seven** routes exist at the paths above; Cognito auth applies only to the management plugin scope.
3. **`GET /me`** JIT + **`ON CONFLICT DO NOTHING`** + re-read.
4. Workspace create sets **owner**; list/detail enforce membership (**403** / **404**).
5. Key create stores **hash only**; response exposes raw key **once**; list returns metadata only.
6. Revoke checks membership and workspace/key association.
7. Zod schemas exported for management DTOs.
8. `pnpm exec tsc --noEmit` and `pnpm exec eslint . --quiet` pass; new tests pass.
