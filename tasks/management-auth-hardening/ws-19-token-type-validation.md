# WS-19: Token-Type Validation Hardening

## Goal

Harden the Cognito JWT auth middleware on `/v1/management/*` so it **explicitly**
asserts `token_use === "id"` and rejects any other token type (notably a Cognito
**access token**, which carries `token_use: "access"`, no `aud`, and no `email`)
with a distinct, accurate failure — instead of rejecting it only as a side
effect of the existing `aud`/`email` checks. Alongside the type assertion, split
the current catch-all `UNAUTHORIZED` failures into distinguishable cases (missing
header / missing token / wrong token type / invalid-or-expired) so auth failures
are legible, while keeping the `SwiftAgentError('UNAUTHORIZED', …)` **code**
stable so the HTTP status stays `401` — only the message/detail varies. Finally,
document the accepted-token contract in a code comment so the marketing site
(`swift-agent-site`) has an authoritative reference to stay in sync with.

## Traceability

Satisfies, from `docs/programs/management-auth-hardening-program.md`:

- **SC-01** — `cognito-auth.ts` explicitly asserts `token_use === "id"` and
  rejects any other value with a distinct, accurate error.
- **SC-03** — Auth failures are distinguishable (missing header / missing token /
  wrong token type / invalid or expired) while preserving the existing HTTP
  status contract (`401` via the stable `UNAUTHORIZED` code).
- **SC-05** — The accepted-token contract is documented in code for the site to
  reference.
- Contributes the token-type half of **SC-02** (access token rejected with
  `401`); the end-to-end route assertion of SC-02/SC-04 lands in WS-20.
- **SC-06** — `pnpm typecheck` and the `@swiftagent/api` test suite pass with the
  new tests.

## Dependencies

- **This program:** none. WS-19 is the root of the dependency graph.
- **Downstream in this program:** WS-20 (Management Route-Protection & Contract
  Tests) depends on WS-19 — it asserts the protection matrix end-to-end,
  including that an access token is rejected at `/v1/management/*`.
- **Cross-repo (context only — do NOT implement here):** the site program
  `swift-agent-site → console-identity-readiness → WS-02` consumes this token
  contract (its session now uses `session.idToken`, formerly
  `session.accessToken`). WS-19 is the upstream prerequisite that makes the
  ID-token-only contract explicit and enforced. **Author nothing in the site
  repo.** The only cross-repo obligation of this workstream is to make the
  accepted-token contract explicit and documented in code so the site can align.

## Context Files (Agent MUST read before implementing)

- `CLAUDE.md` — agent directives + project conventions (this project uses
  `CLAUDE.md`, not `AGENTS.md`).
- `docs/vision.md` — the auth / management sections (two auth layers: API-key on
  `/v1/*`, Cognito JWT on `/v1/management/*`).
- `packages/api/src/middleware/cognito-auth.ts` — **the file this workstream
  hardens.**
- `packages/api/src/middleware/auth.ts` — the API-key auth hook, for the
  `SwiftAgentError('UNAUTHORIZED', …)` message/style precedent.
- `packages/api/src/types.ts` — `ManagementAuthenticatedRequest`.
- `packages/api/src/__tests__/cognito-auth.test.ts` — the **existing** unit test
  suite you will extend (RSA keypair + local JWKS HTTP server + `SignJWT`
  `mintToken` helper).
- `packages/api/src/routes/management/provision-user.ts` — documents the
  401-vs-403 rationale (an authenticated principal is always valid; missing
  membership is `403`, not `401`).
- `packages/shared/src/types/errors.ts` — `SwiftAgentError` constructor + the
  `SwiftAgentErrorCode` set and code→status map.

Do **not** read other workstream specs or the program/manifest docs while
implementing — this spec is self-contained.

## Package

- `packages/api`

## Files Touched

- `packages/api/src/middleware/cognito-auth.ts` **(MODIFY)** — add the explicit
  `token_use === "id"` assertion, split the catch-all into distinguishable
  `UNAUTHORIZED` cases, and add the accepted-token contract comment.
- `packages/api/src/__tests__/cognito-auth.test.ts` **(MODIFY)** — extend the
  existing suite with the token-type cases (ID accepted; `access` rejected;
  missing `token_use` rejected) and confirm the existing reject paths still hold.

No new files, no new packages, no new env keys, no data-model change.

## Existing Interfaces to Consume

### `registerCognitoAuth` / `CognitoAuthOptions` (current — `packages/api/src/middleware/cognito-auth.ts`)

```ts
export interface CognitoAuthOptions {
  issuerUrl: string;
  audience: string;
  /** Optional override for JWT key resolution — use `createLocalJWKSet` in tests. */
  getKey?: JWTVerifyGetKey;
}

export function registerCognitoAuth(
  app: FastifyInstance,
  opts: CognitoAuthOptions,
): void {
  let JWKS: JWTVerifyGetKey;
  if (opts.getKey) {
    JWKS = opts.getKey;
  } else {
    const normalizedIssuer = opts.issuerUrl.endsWith('/')
      ? opts.issuerUrl
      : `${opts.issuerUrl}/`;
    const jwksUri = new URL('.well-known/jwks.json', normalizedIssuer);
    JWKS = createRemoteJWKSet(jwksUri);
  }

  app.addHook('onRequest', async (req, _reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new SwiftAgentError('UNAUTHORIZED', 'Missing or invalid Authorization header');
    }
    const token = authHeader.slice(7);
    if (!token) {
      throw new SwiftAgentError('UNAUTHORIZED', 'Missing token');
    }
    try {
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: opts.issuerUrl,
        audience: opts.audience,
      });
      const sub = payload.sub;
      const email = payload.email as string | undefined;
      if (!sub) {
        throw new SwiftAgentError('UNAUTHORIZED', 'Token missing sub claim');
      }
      if (!email) {
        throw new SwiftAgentError('UNAUTHORIZED', 'Token missing email claim');
      }
      (req as ManagementAuthenticatedRequest).cognitoSub = sub;
      (req as ManagementAuthenticatedRequest).email = email;
    } catch (err) {
      if (err instanceof SwiftAgentError) throw err;
      throw new SwiftAgentError('UNAUTHORIZED', 'Invalid or expired token', {
        cause: err,
      });
    }
  });
}
```

### `SwiftAgentError` (current — `packages/shared/src/types/errors.ts`)

```ts
export const SwiftAgentErrorCode = {
  VALIDATION: 'VALIDATION',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMIT: 'RATE_LIMIT',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',   // → 401
  FORBIDDEN: 'FORBIDDEN',         // → 403
  INTERNAL: 'INTERNAL',
  TIMEOUT: 'TIMEOUT',
  CONNECTION_ERROR: 'CONNECTION_ERROR',
  INCOMPATIBLE_VERSION: 'INCOMPATIBLE_VERSION',
} as const;

export class SwiftAgentError extends Error {
  readonly code: SwiftAgentErrorCode;
  readonly statusCode: number;
  override readonly cause?: unknown;
  constructor(
    code: SwiftAgentErrorCode,
    message: string,
    options?: { cause?: unknown; statusCode?: number },
  ) { /* statusCode defaults from a code→status map: UNAUTHORIZED → 401 */ }
}
```

**Contract constraint:** every auth failure in this file MUST keep the code
`'UNAUTHORIZED'` (→ `401`). Vary only the human-readable `message` (and, where
useful, a `cause`) to distinguish cases. Do **not** introduce a new error code
and do **not** change the HTTP status.

### `ManagementAuthenticatedRequest` (current — `packages/api/src/types.ts`)

```ts
export interface ManagementAuthenticatedRequest extends FastifyRequest {
  cognitoSub: string;
  email: string;
}
```

### Test override pattern (current — `packages/api/src/__tests__/cognito-auth.test.ts`)

The existing unit suite does NOT use `getKey`/`createLocalJWKSet`; it stands up a
real RSA keypair, serves the public JWK set over a local HTTP server, and points
`issuerUrl` at that server so `createRemoteJWKSet` resolves. Extend this same
harness — reuse the `mintToken` helper and add a `token_use` override to it.

```ts
const { privateKey: priv, publicKey: pub } = await generateKeyPair('RS256');
const publicJwk = await exportJWK(pub);
publicJwk.alg = 'RS256'; publicJwk.use = 'sig'; publicJwk.kid = 'test-kid-1';
// local http.Server serves GET /.well-known/jwks.json → { keys: [publicJwk] }
// issuerUrl = `http://127.0.0.1:${port}`

async function mintToken(overrides: {
  iss?: string; aud?: string; sub?: string; email?: string; exp?: number;
  signingKey?: CryptoKey;
  // NEW overrides:
  token_use?: string;       // defaults to 'id' so existing cases keep passing
  includeEmail?: boolean;   // set false to omit the email claim
  includeAud?: boolean;     // set false to omit `aud` — the REAL access-token shape
} = {}): Promise<string> {
  // SignJWT with RS256; set claims from overrides. Call `.setAudience(...)` only
  // when includeAud !== false, so an access token can be minted with no `aud`.
}
```

> Note: `CognitoAuthOptions.getKey` (and `BuildAppOptions.cognitoGetKey`) exist
> so that WS-20's E2E tests can inject a `createLocalJWKSet` without an HTTP
> server. WS-19 keeps using the existing local-JWKS-server harness already in
> `cognito-auth.test.ts` — do not rewrite it.

## Implementation Steps

1. **Re-read `cognito-auth.ts` before editing** (per CLAUDE.md directive 9).

2. **Keep the header/token guards, but sharpen their messages.** Preserve the two
   pre-verify guards, keeping code `'UNAUTHORIZED'`:
   - No header or not `Bearer ` → `'Missing or invalid Authorization header'`.
   - Empty token after `Bearer ` → `'Missing bearer token'`.
   (These are the "missing header" and "missing token" taxonomy cases.)

3. **Verify signature, issuer, and expiry — but NOT audience — with `jwtVerify`.**
   This is a **required ordering change** and the crux of this workstream. `jose`
   enforces the `aud` claim *during* verification; but a real Cognito **access
   token has no `aud` claim**, so passing `audience` makes `jwtVerify` reject an
   access token generically ("invalid or expired token") **before** the code can
   ever inspect `token_use`. To give access tokens an accurate token-type error,
   drop `audience` from the `jwtVerify` options and enforce it manually in step 5:
   ```ts
   const { payload } = await jwtVerify(token, JWKS, {
     issuer: opts.issuerUrl,
     // audience intentionally validated manually below (AFTER token_use), so a
     // Cognito access token (which has no `aud`) fails the token-type check with
     // an accurate message instead of a generic audience/verify failure.
   });
   ```
   Signature, `iss`, and `exp`/`nbf` are still fully validated by `jwtVerify`.

4. **Assert `token_use === "id"` immediately after `jwtVerify` succeeds** — before
   the audience and `sub`/`email` checks. A Cognito ID token carries
   `token_use: "id"`; an access token carries `token_use: "access"` (and no
   `aud`, no `email`). Reject anything that is not exactly `"id"` with a
   **distinct** message:
   ```ts
   const tokenUse = payload.token_use as string | undefined;
   if (tokenUse !== 'id') {
     throw new SwiftAgentError(
       'UNAUTHORIZED',
       `Expected a Cognito ID token (token_use "id"), received ${
         tokenUse ? `token_use "${tokenUse}"` : 'a token with no token_use claim'
       }`,
     );
   }
   ```
   Because this runs **before** the audience and `email` checks, a real access
   token (no `aud`, no `email`) is now caught here by **type** with an accurate
   message — the exact gap the naive placement (after an `audience`-enforcing
   `jwtVerify`) could not reach.

5. **Enforce the audience manually**, after the token-type assertion — `jose` no
   longer checks it (step 3). Cognito `aud` is normally a string but may be an
   array; handle both, keeping code `'UNAUTHORIZED'`:
   ```ts
   const aud = payload.aud;
   const audienceOk = Array.isArray(aud)
     ? aud.includes(opts.audience)
     : aud === opts.audience;
   if (!audienceOk) {
     throw new SwiftAgentError('UNAUTHORIZED', 'Invalid token audience');
   }
   ```

6. **Keep the `sub` and `email` claim checks** as the "malformed ID token" cases,
   with their existing distinct messages (`'Token missing sub claim'`,
   `'Token missing email claim'`). Order them after the audience check.

7. **Preserve the catch-all** for `jwtVerify` failures (bad signature, wrong
   `iss`, expired) — `'Invalid or expired token'` with `{ cause: err }`, code
   `'UNAUTHORIZED'`. Keep the `if (err instanceof SwiftAgentError) throw err;`
   re-throw guard so the distinct in-`try` errors above are not flattened into
   the generic message.

8. **Document the accepted-token contract in a code comment** at the top of the
   `onRequest` hook (or the function). State plainly: the Management API accepts a
   **Cognito ID token only**; required claims are `token_use=id`, `aud=<app
   client id>`, `iss=<issuer>`, `sub`, `email`; a Cognito **access token**
   (`token_use=access`, `client_id`, no `aud`/`email`) is rejected with `401` by
   the `token_use` check. Note the intentional ordering (**token_use before
   audience**, because access tokens lack `aud`) and that the site consumes this
   via `session.idToken`. This comment is the SC-05 artifact the site references.

9. **Do NOT** add support for accepting both token types, and **do NOT** change
   any `SwiftAgentError` code or status. The contract is ID-token-only.

10. **Search for ripples** (per CLAUDE.md directive 10) before finishing: grep the
    `packages/api` tree for any test or caller asserting on the exact strings
    `'Missing token'` or `'Invalid or expired token'` (message-level assertions),
    and for any other importer of `registerCognitoAuth` / `CognitoAuthOptions`, so
    the message changes don't silently break an existing assertion. Existing tests
    assert on `res.json().error.code` (`'UNAUTHORIZED'`), which is preserved.

## Tests

Extend `packages/api/src/__tests__/cognito-auth.test.ts` (reuse the RSA keypair +
local JWKS server + `mintToken` harness). Add a `token_use` override to
`mintToken` (defaulting to `'id'` so existing cases keep passing), plus an
`includeEmail` toggle if not already expressible. New/confirmed cases:

1. **ID token accepted** — `mintToken({ token_use: 'id' })` → `200`, and
   `cognitoSub`/`email` decorated on the request. (Update the existing valid-token
   test to explicitly carry `token_use: 'id'` so the happy path is intentional.)
2. **Access token rejected (realistic shape)** —
   `mintToken({ token_use: 'access', includeAud: false, includeEmail: false })`
   (a real Cognito access token has `token_use: 'access'`, **no `aud`**, and no
   `email`) → `401`, `error.code === 'UNAUTHORIZED'`, and the message references
   the token type (matches `/token_use/i` and `/access/`). This is the case that
   proves the ordering fix: with `audience` no longer enforced by `jwtVerify`, a
   no-`aud` access token is caught by the **`token_use`** assertion rather than by
   a generic verify failure or the `email` check.
3. **Missing `token_use` rejected** — token minted with no `token_use` claim →
   `401`, `error.code === 'UNAUTHORIZED'`, message references the missing
   `token_use` claim (distinct from the "missing email" message).
4. **Wrong `aud` rejected** — `mintToken({ token_use: 'id', aud: 'wrong' })` →
   `401` via the **manual** audience check (message `'Invalid token audience'`),
   `error.code === 'UNAUTHORIZED'` (existing case; keep, now with explicit
   `token_use: 'id'` and asserted against the manual-audience path).
5. **Missing `email`/`sub` rejected** — an ID token (`token_use: 'id'`) minted
   without `email` → `401` with the `'Token missing email claim'` message; and one
   without `sub` → `401` with `'Token missing sub claim'`. Confirms these checks
   still run for a well-typed ID token.
6. **Expired token rejected** — `mintToken({ token_use: 'id', exp: <past> })` →
   `401` via the catch-all (existing case; keep).
7. **Missing header / malformed header / malformed JWT** — keep the existing
   `401` cases; assert `error.code === 'UNAUTHORIZED'`.

Assert on `res.statusCode` (all `401` except the accepted case) and
`res.json().error.code === 'UNAUTHORIZED'` universally; assert on the specific
message only for cases 2 and 3 where the distinct taxonomy is the point.

## Acceptance Criteria

1. `cognito-auth.ts` verifies signature + issuer + expiry via `jwtVerify` (with
   `audience` **intentionally not passed to jose**), then **explicitly** asserts
   `payload.token_use === 'id'` — rejecting `'access'` and a missing claim with a
   distinct, accurate `SwiftAgentError('UNAUTHORIZED', …)` message — and only then
   enforces `audience` manually. As a result a real Cognito access token (which
   has no `aud`) is rejected by the **token-type** check, not incidentally by
   audience/email. (SC-01)
2. Auth failures are distinguishable by message across: missing/invalid
   Authorization header, missing bearer token, wrong token type (missing or
   non-`id` `token_use`), missing `sub`/`email`, and invalid-or-expired token —
   while **every** failure keeps code `'UNAUTHORIZED'` and HTTP status `401`.
   (SC-03)
3. The access-token case fails on the `token_use` assertion (message references
   the token type), not incidentally on the `email`/`aud` checks — proven by test
   case 2. (contributes SC-02)
4. The accepted-token contract (ID-token-only; required claims `token_use=id`,
   `aud`, `iss`, `sub`, `email`; access token rejected) is documented in a code
   comment in `cognito-auth.ts`. (SC-05)
5. No new `SwiftAgentError` code, no HTTP-status change, no new env key, no
   data-model change, and no support added for access tokens or dual-token
   acceptance.
6. **Baseline-verified test pass (objective).** Before implementing, capture the
   baseline on the unmodified tree and record the failing test names:
   ```
   pnpm --filter @swiftagent/api test 2>&1 | tee api-baseline.txt
   ```
   The known baseline failures (unrelated to this change; verified previously via
   `git stash`) are exactly these three — treat them as expected, not regressions:
   - `auth.test.ts > Auth middleware > skips auth for /health` — expects `200`,
     gets `404` (bare `/health` is registered by `apps/server`, not the API
     package's `buildApp`).
   - `integration.test.ts > health endpoint has X-Request-Id header` — same
     `/health` `404` cause.
   - `management.test.ts > GET /workspaces > lists workspaces for current user` —
     `Array.isArray(body)` is `false`.

   After implementing, re-run the same command. Acceptance requires: `pnpm
   typecheck` passes; every new/updated test in this workstream passes; and the
   set of failing tests is a **subset** of the three recorded above — i.e. **zero
   new failing test names**. (SC-06)
