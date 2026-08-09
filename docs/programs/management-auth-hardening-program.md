# Swift Agent — Program Plan (Management Auth Hardening)

## Program Overview

**Status:** Completed on 2026-07-21.

**Product:** Swift Agent — the hosted real-time agent runtime. See [swift-agent.md](../../swift-agent.md) for full vision; see [as-built.md](../as-built.md) for the current system.

**Program scope:** The server-side half of the cross-repo **Console & Identity Readiness** effort. It hardens Cognito token validation on `/v1/management/*` so the token contract the marketing site relies on is explicit and enforced, and it verifies route-protection semantics (401 vs 403) with contract-level tests. This is a small, bounded companion to the primary program `console-identity-readiness` in the `swift-agent-site` repo.

**Cross-repo note:** This program owns *only* the server-side validation contract. The site-facing work (route protection UI, token naming/lifecycle, onboarding, tests) lives in `swift-agent-site` under `console-identity-readiness`. `WS-19` here is an upstream prerequisite for that program's `WS-02`.

## Strategic Goals

- **Explicit token-type validation** — the Management API accepts a Cognito **ID token** and explicitly rejects an **access token**, rather than rejecting it incidentally via missing `email`/`aud`.
- **Legible auth failures** — auth errors distinguish "missing/malformed header," "invalid/expired token," and "wrong token type," each with a clear `SwiftAgentError` code.
- **Verified route protection** — every `/v1/management/*` route enforces the intended 401 (unauthenticated) vs 403 (authenticated but unauthorized) semantics, backed by tests.
- **A documented contract** — the accepted-token contract is written down so the site stays in sync.

## Architecture Changes

No new packages, endpoints, or data-model changes. Work extends existing files in `@swiftagent/api`:

- **`packages/api/src/middleware/cognito-auth.ts`** — today it verifies `issuer` + `audience` and requires `sub` and `email`, but does **not** inspect `token_use`. A Cognito ID token carries `token_use: "id"` and an `aud` claim; an access token carries `token_use: "access"` and `client_id` (no `aud`, no `email`). The current code therefore rejects access tokens only as a side effect of the `aud`/`email` checks. Add an explicit `token_use === "id"` assertion with a distinct error. **Ordering matters:** `jose`'s `jwtVerify` enforces `aud` *during* verification, but a real access token has no `aud`, so an `audience`-enforcing `jwtVerify` rejects it generically before `token_use` can be read. The fix verifies signature + issuer + expiry (audience **not** passed to jose), asserts `token_use === "id"`, then enforces `audience` **manually** — so access tokens get an accurate token-type error.
- **Error taxonomy** — split the current catch-all `UNAUTHORIZED` into distinguishable cases (missing header, missing token, wrong token type, invalid/expired) while keeping the `SwiftAgentError('UNAUTHORIZED', …)` surface shape.
- **Route-protection tests** — extend the management test suite to assert the full matrix (unauthenticated → 401, valid ID token → 200, access token → 401, cross-workspace access → 403), reusing the `resolveOrCreateUser` 401-vs-403 rationale already documented in [provision-user.ts](../../packages/api/src/routes/management/provision-user.ts).

## Technology Choices

No new technology — uses the existing stack (`jose` JWKS validation, Fastify 5, Vitest). Test JWTs use `jose` `createLocalJWKSet` via the existing `getKey` override on `CognitoAuthOptions`.

## Workstreams

| ID | Workstream | Dependencies | Effort |
|----|-----------|--------------|--------|
| WS-19 | Token-Type Validation Hardening | — | S |
| WS-20 | Management Route-Protection & Contract Tests | WS-19 | S |

**Size key:** S = single agentic session (~100–200 turns). Both workstreams touch only `packages/api` — WS-20's contract test runs at the `buildApp` level (which already owns the `/v1/management` registration and the Cognito auth hook), so no `apps/server` composition change is needed.

## Dependency Graph

```
WS-19 (Token-Type Validation Hardening)
  └──→ WS-20 (Route-Protection & Contract Tests)
            │
            ▼
   [ consumed by swift-agent-site: console-identity-readiness:WS-02 ]
```

## Critical Path

**WS-19 → WS-20.** WS-19 is the gating item for the site program's WS-02; it should land (or at least have its contract confirmed) before the site finalizes its token handling.

## Scope (In)

- Explicit `token_use === "id"` validation in `cognito-auth.ts`, rejecting access tokens with a clear, distinct error.
- A distinguishable auth error taxonomy (missing header / missing token / wrong token type / invalid or expired) preserving the existing `SwiftAgentError` surface.
- Unit tests with mocked JWTs: ID token accepted; access token rejected; missing `token_use` rejected; wrong `aud` rejected; missing `email`/`sub` rejected; expired token rejected.
- Integration/E2E tests asserting the `/v1/management/*` protection matrix (401 unauthenticated, 200 valid ID token, 401 access token, 403 cross-workspace).
- A short written statement of the accepted-token contract (code comment and/or the management routes README) for the site to reference.

## Scope (Out)

- Any change to the marketing site (route protection UI, token naming, onboarding) — owned by `console-identity-readiness`.
- New Management API endpoints, workspace/key lifecycle changes, or data-model changes.
- Rate limiting, API-key rotation, audit logging (already out of scope from `management-api`).
- Cognito User Pool / Terraform changes (the pool and app client already exist from `management-api` WS-14).
- Switching the accepted token type to access tokens, or supporting both — the contract is ID-token-only.

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Tightening `token_use` breaks an existing caller that sent an access token | Medium — 401s in the console | The site already sends the ID token ([site auth.ts](../../../swift-agent-site/src/lib/auth.ts)); confirm before merge and coordinate with `console-identity-readiness:WS-02` |
| Real Cognito ID tokens include `aud` but access tokens use `client_id` (no `aud`) | Medium — naive placement misses access tokens | Verify signature + issuer + expiry via `jose` **without** `audience`; assert `token_use` first; enforce `audience` manually after. Cover the realistic access-token shape (no `aud`, no `email`) in tests |
| Error-code changes ripple into existing tests/clients | Low | Keep the `SwiftAgentError('UNAUTHORIZED', …)` code stable; vary only the message/detail so HTTP status is unchanged |

## Success Criteria

- **SC-01** — `cognito-auth.ts` explicitly asserts `token_use === "id"` and rejects any other value with a distinct, accurate error.
- **SC-02** — A Cognito access token is rejected at `/v1/management/*` with 401; a valid ID token is accepted with 200 — both asserted by tests.
- **SC-03** — Auth failures are distinguishable (missing header / missing token / wrong token type / invalid or expired) while preserving the existing HTTP status contract.
- **SC-04** — The route-protection matrix (401 unauthenticated, 200 valid, 401 access token, 403 cross-workspace) is covered by automated tests.
- **SC-05** — The accepted-token contract is documented in code/README for the site to reference.
- **SC-06** — `pnpm typecheck` and the `@swiftagent/api` test suite pass with the new tests (excluding the pre-existing unrelated failures noted in project memory).
