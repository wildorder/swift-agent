# WS-16: Cognito JWT Auth Plugin

## Goal

Deliver a **scoped** Fastify plugin that validates Cognito **ID tokens** (`Authorization: Bearer <jwt>`) using `jose` (`createRemoteJWKSet`, `jwtVerify`) with issuer and audience checks, extracts `sub` and `email`, and decorates the request with `cognitoSub` and `email`. Failures throw `SwiftAgentError('UNAUTHORIZED', ...)`.

This plugin is **not** a global `onRequest` hook like API key auth. It is registered only on the **`/v1/management`** Fastify subtree. Existing **`/v1/*` API key** behavior for runtime routes must remain unchanged.

## Dependencies

- **product-x WS-02** (Shared Types) — `SwiftAgentError`, strict TS, config patterns.
- **product-x WS-07** (Control Plane API) — Fastify app structure, plugin registration, `/v1` prefix.

## Context Files (Agent MUST read before implementing)

- `packages/api/src/middleware/auth.ts`
- `packages/api/src/types.ts`
- `packages/api/src/server.ts`
- `packages/shared/src/config.ts` (`ENV_KEYS`)
- `packages/shared/src/types/errors.ts` (`SwiftAgentError`)

## Package

- `packages/shared/`
- `packages/api/`

## Files Touched

- `packages/shared/src/config.ts` **(MODIFY)** — add `COGNITO_USER_POOL_ID`, `COGNITO_ISSUER_URL`, `COGNITO_CLIENT_ID` to `ENV_KEYS`. Map **`COGNITO_CLIENT_ID`** → JWT **`aud`** when calling `jwtVerify`.
- `packages/api/src/types.ts` **(MODIFY)** — add `ManagementAuthenticatedRequest extends FastifyRequest` with `cognitoSub: string` and `email: string`.
- `packages/api/src/middleware/cognito-auth.ts` **(NEW)** — export `registerCognitoAuth(app, { issuerUrl, audience })`.
- `packages/api/src/server.ts` **(MODIFY)** — register a child Fastify scope with `prefix: '/v1/management'` and call `registerCognitoAuth` **only** inside that scope (no Cognito hook on `/v1/agents`, `/v1/sessions`, etc.).
- Unit test file under `packages/api` (e.g. `packages/api/src/middleware/cognito-auth.test.ts`) **(NEW)**.

## Existing Interfaces to Consume

- **`registerAuth`** — Leave as-is; do not fold Cognito into `auth.ts`.
- **`AuthenticatedRequest`** — Unchanged; management handlers use `ManagementAuthenticatedRequest`.
- **`SwiftAgentError`** — All auth failures (missing/invalid `Authorization`, bad signature, wrong `iss`/`aud`, expired token).
- **`jose`** — `createRemoteJWKSet`, `jwtVerify` only; **no** AWS SDK.

## Implementation Steps

1. **ENV_KEYS** — Add `COGNITO_USER_POOL_ID`, `COGNITO_ISSUER_URL`, `COGNITO_CLIENT_ID`. Runtime issuer must match Cognito’s JWT **`iss`**:  
   `https://cognito-idp.{region}.amazonaws.com/{user_pool_id}` — same value as **`COGNITO_ISSUER_URL`** passed as `issuerUrl` to the plugin.

2. **JWKS URL** — Normalize `issuerUrl` to end with `/`, then `new URL('.well-known/jwks.json', issuerUrl)` so the fetch URL is **`${issuerUrl}/.well-known/jwks.json`** (no duplicate slashes).

3. **`registerCognitoAuth(app: FastifyInstance, opts: { issuerUrl: string; audience: string }): void`**  
   - `const JWKS = createRemoteJWKSet(jwksUri)`.  
   - `app.addHook('onRequest', ...)`: require `Authorization: Bearer <token>`; `jwtVerify(token, JWKS, { issuer: opts.issuerUrl, audience: opts.audience })`.  
   - From payload: `sub` (string), `email` (string). If `email` is absent, reject with `UNAUTHORIZED` (do not pass `undefined` through the typed request).  
   - Assign `(req as ManagementAuthenticatedRequest).cognitoSub` and `.email`.  
   - On any failure, `throw new SwiftAgentError('UNAUTHORIZED', '...')`.

4. **Server wiring** — Nest `app.register(async (management) => { registerCognitoAuth(management, { issuerUrl: fromEnv, audience: COGNITO_CLIENT_ID }); /* routes land in WS-17 */ }, { prefix: '/v1/management' })` so hooks apply only under that prefix.

5. **Coordination with WS-17** — WS-17 extends API key `SKIP_AUTH_PATHS` for `/v1/management/*`. Until then, unauthenticated callers may still fail API key checks before Cognito; that is expected for phased delivery.

## Tests

- Generate an **RSA** key pair (`node:crypto` or `jose`).
- Use **`SignJWT`** to mint test tokens with `iss`, `aud`, `sub`, `email`, `exp`, `iat` matching plugin options.
- **`createRemoteJWKSet` requires HTTP** — spin a minimal local server (or test Fastify) serving `GET /.well-known/jwks.json` with the **public** JWK set; set `issuerUrl` to `http://127.0.0.1:<port>` so `${issuerUrl}/.well-known/jwks.json` resolves.
- **Cases**: valid token → `cognitoSub` / `email` set; reject wrong `aud`, wrong `iss`, expired `exp`, bad signature, missing header, malformed JWT.
- Prefer a **standalone** `Fastify()` instance calling `registerCognitoAuth` to avoid coupling to full `buildApp` unless a thin integration test is justified.

## Acceptance Criteria

1. `ENV_KEYS` includes `COGNITO_USER_POOL_ID`, `COGNITO_ISSUER_URL`, and `COGNITO_CLIENT_ID`.
2. `ManagementAuthenticatedRequest` declares `cognitoSub` and `email`.
3. `registerCognitoAuth` uses `createRemoteJWKSet` against `${issuerUrl}/.well-known/jwks.json` and `jwtVerify` with issuer + audience; decorates request; throws `SwiftAgentError('UNAUTHORIZED', ...)` on failure.
4. Cognito verification runs **only** under the `/v1/management` registered scope; non-management `/v1` routes keep existing API key behavior.
5. Unit tests use jose **`SignJWT`**, a local RSA key pair, a local JWKS HTTP endpoint, and cover accept + reject paths.
6. `pnpm exec tsc --noEmit` and `pnpm exec eslint . --quiet` pass for touched packages (or monorepo-standard equivalents).
