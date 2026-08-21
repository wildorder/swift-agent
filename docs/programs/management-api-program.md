# Swift Agent — Program Plan (Management API)

## Program Overview

**Status:** Completed on 2026-07-15.

**Product:** Swift Agent — a hosted real-time agent runtime that lets developers embed streaming, tool-calling, multi-model AI agents into any application.

**Program scope:** Add the Management API layer — Cognito User Pool infrastructure, user identity, workspace management, API key lifecycle, and Cognito JWT authentication. This is the programmatic surface consumed by the marketing site developer console, the CLI, and any future automation (Terraform provider).

---

## Strategic Goals

1. **Self-service onboarding** — A developer signs up via Cognito, hits the console, creates a workspace, and generates an API key — all without human intervention.
2. **Thin-frontend enablement** — The marketing site owns no data. Every workspace and key operation goes through `/v1/management/*`, making the console a pure API client.
3. **User ↔ Workspace mapping** — Introduce the `users` and `user_workspaces` tables so workspace ownership is tied to authenticated identities, not just anonymous API keys.
4. **Two clean auth layers** — Cognito JWT protects management endpoints (human identity); API keys protect runtime endpoints (machine identity). No overlap, no confusion.

---

## Architecture Changes

The product-x MVP program delivers the runtime stack: shared types, database layer, model providers, core loop, gateway, control plane API, SDKs, and service composition. This program layers on top of that foundation with four additions:

### 1. Cognito User Pool Infrastructure (`infra/modules/cognito`)

A Terraform module that provisions the shared AWS Cognito User Pool consumed by both the marketing site (next-auth OIDC sign-in) and the core service (JWT validation). Includes:

- User Pool with email-based sign-up, password policy, and email verification
- App client for the marketing site (authorization code flow with PKCE, callback/logout URLs)
- User Pool domain for Cognito's hosted OIDC endpoints
- Outputs: User Pool ID, Issuer URL, JWKS URI, App Client ID — wired into both services via env vars

### 2. User Identity Layer (`@swiftagent/db`)

New tables and repositories that map Cognito identity to Swift Agent workspaces:

```
users
  ├── userId        (usr_ prefixed, PK)
  ├── cognitoSub    (unique, from JWT sub claim)
  ├── email         (from JWT email claim)
  ├── createdAt
  └── updatedAt

user_workspaces
  ├── userId        (FK → users)
  ├── workspaceId   (FK → workspaces)
  ├── role          (owner | member)
  └── createdAt
```

### 3. Cognito JWT Auth Plugin (`@swiftagent/api`)

A Fastify plugin that:
- Fetches the JWKS from Cognito's well-known endpoint using `jose` `createRemoteJWKSet`
- Validates the `Authorization: Bearer <id-token>` header on every `/v1/management/*` request
- Extracts `sub` and `email` claims and decorates the Fastify request
- Rejects expired, malformed, or unsigned tokens with 401

### 4. Management Routes (`@swiftagent/api`)

Seven REST endpoints under a `/v1/management` Fastify plugin prefix:

| Method | Endpoint | Purpose | Notes |
|--------|----------|---------|-------|
| `GET` | `/v1/management/me` | Get current user profile | Auto-creates user record on first call (JIT provisioning) |
| `POST` | `/v1/management/workspaces` | Create a workspace | Creator gets `owner` role via `user_workspaces` |
| `GET` | `/v1/management/workspaces` | List user's workspaces | Scoped to workspaces where user has membership |
| `GET` | `/v1/management/workspaces/:id` | Get workspace details | Requires workspace membership |
| `POST` | `/v1/management/workspaces/:id/keys` | Create an API key | Returns raw `ak_` key once; stores hash only |
| `GET` | `/v1/management/workspaces/:id/keys` | List API keys | Returns metadata + prefix, never raw key |
| `DELETE` | `/v1/management/workspaces/:id/keys/:keyId` | Revoke an API key | Soft-revoke: sets `revokedAt` timestamp |

**Authorization model:** Every workspace-scoped route verifies the authenticated user is a member of the target workspace via `user_workspaces`. No membership = 403.

### How the Marketing Site Uses This

```
User clicks "Get Started"
  → Cognito sign-up / sign-in (OIDC via next-auth)
  → next-auth session created (server-side)
  → Redirect to /console
  → GET /v1/management/me (auto-creates user if first visit)
  → GET /v1/management/workspaces (show workspace list)
  → POST /v1/management/workspaces (create first workspace)
  → POST /v1/management/workspaces/:id/keys (generate API key)
  → User copies raw key → uses in @swiftagent/sdk
```

---

## Technology Choices

One new infrastructure component; all application-layer technology is already in the stack:

| Concern | Choice | Already in Stack |
|---------|--------|------------------|
| Identity provider | AWS Cognito User Pool (OIDC) | **New** — provisioned via Terraform |
| IaC | Terraform (AWS provider) | Yes (product-x WS-13a) |
| JWT validation | `jose` `createRemoteJWKSet` + `jwtVerify` | Yes (jose ^6) |
| ID generation | `nanoid` with `usr_` prefix | Yes (nanoid ^5) |
| Schema validation | Zod request/response schemas | Yes (zod ^3.24) |
| Database | Drizzle ORM + postgres.js | Yes |
| API framework | Fastify 5 plugin system | Yes |
| Password hashing (API keys) | Node.js `crypto.createHash('sha256')` | Built-in |

---

## Workstreams

| ID | Workstream | Dependencies | Estimated Effort |
|----|-----------|--------------|-----------------|
| WS-14 | Cognito User Pool Infrastructure | product-x WS-13a | S |
| WS-15 | Management Data Layer | product-x WS-02, WS-03 | S |
| WS-16 | Cognito JWT Auth Plugin | product-x WS-02, WS-07 | S |
| WS-17 | Management API Routes | WS-15, WS-16 | M |
| WS-18 | Management Integration & E2E Tests | WS-14, WS-17, product-x WS-11 | S |

**Size key:** S = 1-2 days, M = 3-5 days

### Workstream Details

**WS-14 — Cognito User Pool Infrastructure**
Terraform module that provisions the shared AWS Cognito User Pool. Configures email-based sign-up with verification, password policy, and account recovery. Creates an app client for the marketing site (authorization code flow with PKCE, configured callback/logout URLs). Sets up a User Pool domain for Cognito's hosted OIDC endpoints. Outputs User Pool ID, Issuer URL, JWKS URI, and App Client ID — wired into environment configs for both the core service and the marketing site. Touches `infra/modules/cognito` (NEW) and `infra/envs/dev`.

**WS-15 — Management Data Layer**
Adds `users` and `user_workspaces` tables to `@swiftagent/db`. Creates `createUserRepo` and `createUserWorkspaceRepo` factory functions following existing repository patterns. Includes a Drizzle migration. Touches `packages/db` only.

**WS-16 — Cognito JWT Auth Plugin**
Creates a Fastify plugin in `@swiftagent/api` that validates Cognito ID tokens via JWKS. Adds Cognito-related env vars (`COGNITO_USER_POOL_ID`, `COGNITO_ISSUER_URL`) to `@swiftagent/shared` ENV_KEYS. Unit tests with mocked JWTs. Touches `packages/api` and `packages/shared`.

**WS-17 — Management API Routes**
Implements all seven management endpoints as Fastify route handlers registered under a `/v1/management` prefix plugin. Includes Zod request/response schemas, workspace membership authorization checks, API key generation (raw key → SHA-256 hash), and the JIT user provisioning logic on `GET /me`. Touches `packages/api`.

**WS-18 — Management Integration & E2E Tests**
Wires the management plugin into `apps/server` service composition. Writes integration tests using Testcontainers Postgres that exercise the full flow: authenticated request → user auto-creation → workspace CRUD → API key lifecycle. Verifies 401/403 error paths. Requires WS-14 (Cognito pool) to be provisioned so real JWKS validation can be tested. Touches `apps/server` and test files.

---

## Dependency Graph

```
product-x WS-13a (Terraform) ────────→ WS-14 (Cognito Infra) ──────────────────┐
                                                                                │
product-x WS-02 (Shared Types) ──┐                                             │
product-x WS-03 (Database) ──────┼──→ WS-15 (Data Layer) ───┐                  │
                                  │                           ├──→ WS-17 (Routes) ──→ WS-18 (Integration)
product-x WS-02 (Shared Types) ──┤                           │                  │
product-x WS-07 (API) ───────────┼──→ WS-16 (Auth Plugin) ──┘                  │
                                  │                                             │
                                  └────────────────── product-x WS-11 (Composition) ─┘
```

Three parallel tracks: WS-14 (infra), WS-15 (data), and WS-16 (auth) have **no dependencies on each other**. WS-17 merges the code tracks. WS-18 merges everything including the provisioned Cognito pool.

---

## Critical Path

**WS-14 + WS-15 + WS-16 (all parallel) → WS-17 → WS-18**

Minimum timeline: S + M + S = ~5-8 days (assuming product-x prerequisites are complete).

All three foundation workstreams run concurrently:
- WS-14 provisions Cognito infrastructure (Terraform — `infra/`)
- WS-15 builds the data layer (`packages/db`)
- WS-16 builds the auth plugin (`packages/api` + `packages/shared`)

WS-17 (routes) merges the two code tracks. WS-18 (integration) merges everything — including the live Cognito pool for real JWT validation.

---

## Scope (In)

- AWS Cognito User Pool provisioned via Terraform (email sign-up, password policy, verification)
- Cognito app client for the marketing site (authorization code + PKCE)
- User Pool domain for hosted OIDC endpoints
- `users` table with Cognito sub → `usr_` ID mapping
- `user_workspaces` join table with role-based membership
- Cognito JWT validation via JWKS (`jose`, RS256)
- JIT user provisioning on first authenticated call
- All seven `/v1/management/*` endpoints per vision.md
- Workspace membership authorization on all workspace-scoped routes
- API key generation (raw key returned once, SHA-256 hash stored)
- API key revocation (soft-delete via `revokedAt`)
- Env var configuration for Cognito pool details
- Integration tests covering the full auth → CRUD flow

## Scope (Out)

- Team/organization management (multi-user workspace invitations, role changes)
- Usage metering or billing
- Rate limiting on management endpoints
- API key rotation (revoke + create is sufficient for Phase 1)
- Workspace deletion (not in vision.md Phase 1)
- Audit logging of management operations

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Cognito User Pool config drift between envs | Medium | Single Terraform module with env-specific `tfvars` for callback URLs; review plan output before apply |
| Cognito JWKS endpoint latency on cold start | Medium | `jose` caches JWKS automatically; configure reasonable cache TTL |
| Race condition on JIT user provisioning (concurrent first requests) | Medium | Use `ON CONFLICT DO NOTHING` on `cognitoSub` unique constraint; retry read after conflict |
| API key entropy / collision | Low | `nanoid` with sufficient length (21+ chars) + `ak_` prefix; SHA-256 hash for storage |
| Workspace membership check on every request adds latency | Low | Single indexed join query; consider caching if measured latency is an issue |
| Marketing site CORS preflight on management endpoints | Medium | Fastify CORS plugin configured for marketing site origin; server-side calls from Next.js don't need CORS but browser-based dev tooling might |

---

## Success Criteria

1. A Cognito User Pool is provisioned with a working app client; a test user can sign up, verify email, and obtain an ID token via the hosted OIDC flow.
2. A user authenticated via Cognito JWT can call `GET /v1/management/me` and receive their user profile, auto-created on first call.
3. An authenticated user can create a workspace, and the `user_workspaces` join table records them as `owner`.
4. A workspace owner can create an API key, receive the raw `ak_` key exactly once, and see it listed (hash only) on subsequent calls.
5. A workspace owner can revoke an API key, and subsequent runtime auth attempts with that key are rejected.
6. A user who is NOT a member of a workspace receives 403 on all workspace-scoped operations.
7. An unauthenticated request (no token, expired token, invalid token) receives 401.
8. Integration tests verify the complete flow: JWT auth → user provisioning → workspace CRUD → key lifecycle → revocation.
9. The marketing site console can complete its full onboarding flow (sign up → create workspace → generate key) using only these endpoints.
