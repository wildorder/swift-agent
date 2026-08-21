# WS-20: Management Route-Protection & Contract Tests

## Goal

Verify — with automated tests — that the `/v1/management/*` surface enforces the
intended protection semantics as a contract, at both layers where it is enforced:

- **Authentication (middleware layer).** The Cognito `onRequest` hook is
  registered **once for the whole management plugin** (`registerCognitoAuth` in
  `managementPlugin`), so it is route-independent. The authentication matrix —
  unauthenticated → `401`, valid Cognito **ID token** → `200`/`201`, Cognito
  **access token** → `401` (the token-type rejection from WS-19), wrong `aud` /
  expired / missing-`token_use` → `401` — is therefore asserted against a
  **representative** protected route (`GET /v1/management/me`); it holds for every
  route under the prefix because the same hook guards them all.
- **Authorization (per handler).** Cross-workspace access control is enforced in
  each route handler, so it is asserted **per protected resource**: user B with a
  valid ID token hitting user A's workspace-detail and every API-key resource
  (`GET :id`, `GET :id/keys`, `POST :id/keys`, `DELETE :id/keys/:keyId`) → `403`
  (not `401`).

The tests wire real Cognito JWT validation through `buildApp` (via the
`cognitoGetKey` → `createLocalJWKSet` override) so the matrix is asserted against
the real middleware, not a mock. No production code changes are expected unless a
test surfaces a genuine protection gap.

## Traceability

Satisfies, from `docs/programs/management-auth-hardening-program.md`:

- **SC-02** — A Cognito access token is rejected at `/v1/management/*` with `401`;
  a valid ID token is accepted with `200`/`201` — both asserted by tests.
- **SC-04** — The route-protection matrix (401 unauthenticated, 200 valid ID
  token, 401 access token, 403 cross-workspace) is covered by automated tests.
- **SC-06** — `pnpm typecheck` and the `@swiftagent/api` test suite pass with the
  new tests.

Builds on WS-19's SC-01/SC-03 (token-type assertion + legible taxonomy), which
this workstream exercises end-to-end.

## Dependencies

- **This program:** **WS-19** (Token-Type Validation Hardening) — WS-20 asserts,
  through the real auth middleware, that an access token is rejected. Land WS-19
  first; without it the access-token case would pass only incidentally (via the
  `email`/`aud` checks) rather than by the explicit `token_use` assertion this
  matrix is meant to prove.
- **Cross-repo (context only — do NOT implement here):** the same downstream
  consumer as WS-19 — `swift-agent-site → console-identity-readiness → WS-02`
  relies on the `401` (unauthenticated / wrong token type) vs `403`
  (authenticated-but-unauthorized) contract this workstream pins down. **Author
  nothing in the site repo.**

## Context Files (Agent MUST read before implementing)

- `CLAUDE.md` — agent directives + conventions.
- `docs/vision.md` — the auth / management sections (two auth layers).
- `packages/api/src/middleware/cognito-auth.ts` — the (WS-19-hardened) middleware
  under test.
- `packages/api/src/server.ts` — `buildApp` / `BuildAppOptions`, specifically the
  `cognitoIssuerUrl` / `cognitoClientId` / `cognitoGetKey` options and the
  conditional `managementPlugin` registration under `/v1/management`.
- `packages/api/src/routes/management/index.ts` — `managementPlugin` /
  `ManagementPluginOptions` (also carries a `getKey` override).
- `packages/api/src/routes/management/provision-user.ts` — the **401-vs-403
  rationale**: an authenticated principal is always valid, so a member-check
  failure is `403`, never `401`.
- `packages/api/src/routes/management/__tests__/management.test.ts` — the existing
  route suite that mocks Cognito auth by directly decorating `cognitoSub`/`email`
  and covers the `403` cross-workspace cases at the route level.
- `packages/api/src/__tests__/cognito-auth.test.ts` — the RSA-keypair + local
  JWKS harness and `mintToken` helper (extended in WS-19).
- `packages/api/src/types.ts` — `ManagementAuthenticatedRequest`.
- `packages/shared/src/types/errors.ts` — `SwiftAgentError` codes / status map.

Do **not** read other workstream specs or the program/manifest docs while
implementing — this spec is self-contained.

## Package

- `packages/api` — the only package in scope. `buildApp` already owns the
  `/v1/management` registration and the Cognito `onRequest` hook, so a
  `buildApp`-level test exercises the **real** middleware and is authoritative for
  the full matrix. There is **no `apps/server` change** in this workstream —
  composing the host app would only re-register the same plugin and add no
  coverage the `buildApp` test lacks.

## Files Touched

- `packages/api/src/routes/management/__tests__/management-protection.test.ts`
  **(NEW)** — the route-protection contract matrix, driving `buildApp` with the
  real Cognito middleware via a `createLocalJWKSet` `cognitoGetKey` override.
- `packages/api/src/routes/management/__tests__/management-helpers.ts`
  **(NEW)** — a shared test-helper module. It exports **(a)** the key-storing mock
  `ApiKeyRepo` currently defined *file-local* in `management.test.ts` as
  `createManagementMockApiKeyRepo` — which is why the new test cannot import it
  today — moved here verbatim and `export`ed; and **(b)** the `createLocalJWKSet`
  keypair + `mintToken` helpers (below) so both test files share one source.
- `packages/api/src/routes/management/__tests__/management.test.ts`
  **(MODIFY)** — replace its local `createManagementMockApiKeyRepo` definition
  with an `import { createManagementMockApiKeyRepo } from './management-helpers'`.
  This is an **import-only refactor**: the mock's behavior, the test's assertions,
  and its pass/fail state are unchanged. (This resolves the "file-local, not
  importable" gap and removes the earlier ambiguity about whether this file may be
  touched — it is a deliberate, minimal dedupe, nothing more.)

No production code change is expected. If the matrix reveals a real gap (e.g. a
route that returns `401` where `403` is correct, or vice versa), fix it in the
relevant `routes/management/*` handler and note it in the summary — but do **not**
change any `SwiftAgentError` code or HTTP status contract.

## Existing Interfaces to Consume

### `buildApp` options (current — `packages/api/src/server.ts`)

```ts
export interface BuildAppOptions {
  runExecutionService: RunExecutionService;
  repos: {
    apiKeyRepo: ApiKeyRepo; agentRepo: AgentRepo; sessionRepo: SessionRepo;
    messageRepo: MessageRepo; runRepo: RunRepo; toolCallRepo: ToolCallRepo;
    traceRepo: TraceRepo; userRepo: UserRepo; userWorkspaceRepo: UserWorkspaceRepo;
    workspaceRepo: WorkspaceRepo;
  };
  jwtSecret: string;
  publicWebsocketUrl?: string;
  cognitoIssuerUrl?: string;
  cognitoClientId?: string;
  /** Optional override for JWT key resolution — use `createLocalJWKSet` in tests. */
  cognitoGetKey?: JWTVerifyGetKey;
  logger?: boolean | object;
  registerRootHealth?: boolean;
}

// Management plugin is registered ONLY when both Cognito options are present:
if (opts.cognitoIssuerUrl && opts.cognitoClientId) {
  await app.register(managementPlugin, {
    prefix: '/v1/management',
    issuerUrl: opts.cognitoIssuerUrl,
    audience: opts.cognitoClientId,
    getKey: opts.cognitoGetKey,
    userRepo, userWorkspaceRepo, workspaceRepo, apiKeyRepo,
  });
}
```

**Implication:** to exercise the management routes through the real middleware,
the test MUST pass `cognitoIssuerUrl`, `cognitoClientId`, and `cognitoGetKey`.
Omitting them silently drops the entire `/v1/management` subtree (routes 404).

### `managementPlugin` / `ManagementPluginOptions` (current — `routes/management/index.ts`)

```ts
export interface ManagementPluginOptions {
  issuerUrl: string;
  audience: string;
  getKey?: JWTVerifyGetKey;   // ← createLocalJWKSet override for tests
  userRepo: UserRepo; userWorkspaceRepo: UserWorkspaceRepo;
  workspaceRepo: WorkspaceRepo; apiKeyRepo: ApiKeyRepo;
}
// registerCognitoAuth(app, { issuerUrl, audience, getKey }) then me/workspaces/keys routes.
```

### `createLocalJWKSet` test-key pattern (jose) — lives in `management-helpers.ts`

`getKey`/`cognitoGetKey` is a `JWTVerifyGetKey`. In tests, mint against a local
keypair and resolve with `createLocalJWKSet` (no HTTP server needed — simpler
than the `cognito-auth.test.ts` remote-JWKS harness). Put this in the shared
`management-helpers.ts` so it is importable:

```ts
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT, type JWTVerifyGetKey } from 'jose';

const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = await exportJWK(publicKey);
jwk.alg = 'RS256'; jwk.use = 'sig'; jwk.kid = 'test-kid-1';
const getKey: JWTVerifyGetKey = createLocalJWKSet({ keys: [jwk] });

const ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TESTPOOL';
const AUDIENCE = 'test-client-id';

async function mintToken(o: {
  token_use?: string; sub?: string; email?: string; aud?: string;
  iss?: string; exp?: number; includeEmail?: boolean; includeAud?: boolean;
} = {}): Promise<string> {
  const claims: Record<string, unknown> = { token_use: o.token_use ?? 'id' };
  if (o.includeEmail !== false) claims.email = o.email ?? 'user@example.com';
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-kid-1' })
    .setIssuedAt()
    .setIssuer(o.iss ?? ISSUER)
    .setSubject(o.sub ?? 'cognito-sub-123')
    .setExpirationTime(o.exp ?? '5m');
  // Only set `aud` when requested. A real Cognito ACCESS token has NO `aud`, so
  // the access-token case must mint with `includeAud: false` to be realistic —
  // and WS-19 now checks `token_use` before audience, so it is still rejected.
  if (o.includeAud !== false) jwt.setAudience(o.aud ?? AUDIENCE);
  return jwt.sign(privateKey);
}
// buildApp({ ..., cognitoIssuerUrl: ISSUER, cognitoClientId: AUDIENCE, cognitoGetKey: getKey })
```

### `ManagementAuthenticatedRequest` (current — `packages/api/src/types.ts`)

```ts
export interface ManagementAuthenticatedRequest extends FastifyRequest {
  cognitoSub: string;
  email: string;
}
```

### 401-vs-403 rationale (current — `routes/management/provision-user.ts`)

`resolveOrCreateUser` provisions the local user JIT from the verified Cognito
principal. Because an authenticated caller is **always** a valid principal, a
route that finds the caller is not a member of the target workspace returns
`403` (forbidden), **not** `401` — `401` is reserved for authentication failures
(no/invalid/wrong-type/expired token). This is the exact distinction the matrix
must pin down.

## Implementation Steps

1. **Re-read** `server.ts` (`buildApp`), `routes/management/index.ts`, and
   `management.test.ts` before writing (CLAUDE.md directive 6/9).

2. **Extract the shared helper first.** Create `management-helpers.ts`: move
   `createManagementMockApiKeyRepo` out of `management.test.ts` verbatim and
   `export` it, and add the `createLocalJWKSet` keypair + `mintToken` helpers
   (above). Update `management.test.ts` to `import { createManagementMockApiKeyRepo }`
   from `./management-helpers` (import-only refactor — no behavioral change). Run
   `management.test.ts` once to confirm it still passes before moving on.

3. **Build the test harness.** In the new `management-protection.test.ts`, import
   `getKey`, `mintToken`, `ISSUER`, `AUDIENCE`, and `createManagementMockApiKeyRepo`
   from `./management-helpers`. Construct the app via `buildApp` with the full
   `repos` set (reuse the mock repos from `packages/api/src/__tests__/helpers.js`
   plus the imported key-storing mock `ApiKeyRepo`), passing
   `cognitoIssuerUrl: ISSUER`, `cognitoClientId: AUDIENCE`,
   `cognitoGetKey: getKey`. Provide a stub `runExecutionService` and `jwtSecret`
   as the existing `buildApp` tests do (mirror an existing `buildApp`-level test
   for the exact stub shape). Routes are then reachable under the real
   `/v1/management` prefix with real Cognito verification.

4. **Two distinct principals for the 403 case.** Mint an ID token for user A
   (`sub: 'sub-A'`, `email: 'a@example.com'`) and, separately, for user B
   (`sub: 'sub-B'`). Have A create a workspace (`POST /v1/management/workspaces`);
   then assert B is rejected `403` on **every** protected resource of A's
   workspace — `GET /v1/management/workspaces/:id`, `GET …/:id/keys`,
   `POST …/:id/keys`, and `DELETE …/:id/keys/:keyId`. (Authorization is per
   handler, so each resource is asserted individually — see the Goal.) The mock
   repos JIT-provision both users from their verified tokens.

5. **Assert the authentication matrix** against the representative route
   `GET /v1/management/me`. This is sufficient for the *auth* cases because the
   Cognito `onRequest` hook is registered once at the plugin level and guards
   every route under `/v1/management` identically:
   - **Unauthenticated → 401:** no `Authorization` header →
     `GET /v1/management/me` returns `401`, `error.code === 'UNAUTHORIZED'`.
   - **Valid ID token → 200:** `mintToken({ token_use: 'id' })` →
     `GET /v1/management/me` returns `200` and echoes the caller's `email`/`sub`
     (`usr_`-prefixed `userId`); `POST /v1/management/workspaces` returns `201`.
   - **Access token → 401 (realistic shape):**
     `mintToken({ token_use: 'access', includeAud: false, includeEmail: false })`
     (real Cognito access token: no `aud`, no `email`) → `GET /v1/management/me`
     returns `401`, `error.code === 'UNAUTHORIZED'`, and the message references
     the token type (proves WS-19's `token_use` assertion fires end-to-end,
     *before* the audience/email checks, not incidentally).

6. **Cover the remaining reject shapes end-to-end** (thin, to prove they route to
   `401` through `buildApp`, not just in the unit): wrong `aud`, expired token,
   and missing-`token_use` each → `401` on `GET /v1/management/me`.

7. **Do not change the behavior of the existing suite.** `management.test.ts`
   keeps its mocked-auth route tests and handler-level `403` coverage; the only
   change is importing the storing mock from `management-helpers.ts` (step 2). The
   new file adds the real-auth dimension on top.

8. **Ripple search** (CLAUDE.md directive 10): confirm no other test already
   asserts the management matrix (avoid duplicate/contradicting coverage); that
   `buildApp`'s `cognitoGetKey` is threaded to `managementPlugin`'s `getKey` (it
   is, per `server.ts`) so the override actually reaches `registerCognitoAuth`;
   and that no other importer of `createManagementMockApiKeyRepo` exists that the
   extraction would break.

## Tests

New file `packages/api/src/routes/management/__tests__/management-protection.test.ts`:

1. **Unauthenticated → 401** — no header, `GET /v1/management/me` → `401`,
   `error.code === 'UNAUTHORIZED'`.
2. **Valid ID token → 200** — `GET /v1/management/me` → `200`; response carries
   `email`, `cognitoSub`, `usr_`-prefixed `userId`.
3. **Valid ID token → 201 on create** — `POST /v1/management/workspaces` with a
   name → `201`, `ws_`-prefixed `workspaceId`.
4. **Access token → 401 (realistic shape)** —
   `mintToken({ token_use: 'access', includeAud: false, includeEmail: false })`
   (no `aud`, no `email`) → `GET /v1/management/me` → `401`,
   `error.code === 'UNAUTHORIZED'`, message matches `/token_use/i`.
5. **Missing `token_use` → 401** — token minted without `token_use` →
   `GET /v1/management/me` → `401`, `error.code === 'UNAUTHORIZED'`.
6. **Wrong `aud` → 401** — `mintToken({ aud: 'wrong' })` → `401`.
7. **Expired token → 401** — `mintToken({ exp: <past> })` → `401`.
8. **Cross-workspace → 403 (every protected resource)** — user A creates a
   workspace; user B (valid ID token) is rejected `403` with
   `error.code === 'FORBIDDEN'` on each of: `GET /v1/management/workspaces/:id`,
   `GET …/:id/keys`, `POST …/:id/keys`, and `DELETE …/:id/keys/:keyId`. Covers
   both read and write paths across the workspace-detail and key resources.

All auth-failure cases assert `res.statusCode === 401` and
`res.json().error.code === 'UNAUTHORIZED'`; the cross-workspace cases assert
`403` and `'FORBIDDEN'`.

## Acceptance Criteria

1. A single contract test file drives the real Cognito middleware through
   `buildApp` (via `cognitoGetKey`/`createLocalJWKSet`) and asserts the full
   matrix. The **authentication** cases (unauthenticated → `401`, valid ID token →
   `200`/`201`, access token → `401`, wrong-`aud`/expired/missing-`token_use` →
   `401`) are asserted via the representative route `GET /v1/management/me` —
   valid because the Cognito hook is registered once for the whole plugin. The
   **authorization** case (cross-workspace → `403`) is asserted per protected
   resource: workspace-detail (`GET :id`) and every key route
   (`GET/POST :id/keys`, `DELETE :id/keys/:keyId`). (SC-02, SC-04)
2. The access-token case is minted in its realistic shape (`token_use: 'access'`,
   no `aud`, no `email`) and fails through WS-19's `token_use` assertion (message
   references the token type), proving the hardening works end-to-end and not
   incidentally via an audience/email failure. (SC-02)
3. The `403` cross-workspace cases assert `error.code === 'FORBIDDEN'` (status
   `403`), distinct from the `401` auth failures — matching the
   `resolveOrCreateUser` 401-vs-403 rationale. (SC-04)
4. The existing `management.test.ts` behavior is unchanged — the only edit is an
   import-only refactor to consume `createManagementMockApiKeyRepo` from the
   shared `management-helpers.ts`; its mocked-auth route tests and handler-level
   `403` coverage still pass. The new matrix is additive.
5. No `SwiftAgentError` code or HTTP-status contract is changed. If the matrix
   surfaced a genuine protection gap, the fix is confined to a
   `routes/management/*` handler and is called out in the summary.
6. **Baseline-verified test pass (objective).** Capture the baseline before
   implementing: `pnpm --filter @swiftagent/api test 2>&1 | tee api-baseline.txt`.
   The known pre-existing failures (unrelated to this change) are exactly:
   `auth.test.ts > Auth middleware > skips auth for /health`,
   `integration.test.ts > health endpoint has X-Request-Id header`, and
   `management.test.ts > GET /workspaces > lists workspaces for current user`.
   After implementing, re-run: `pnpm typecheck` passes, every new test passes, and
   the failing-test set is a **subset** of those three — **zero new failing test
   names**. (SC-06)
