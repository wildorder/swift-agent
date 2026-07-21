import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../../server.js';
import {
  TEST_JWT_SECRET,
  createMockRunExecutionService,
  createMockAgentRepo,
  createMockSessionRepo,
  createMockMessageRepo,
  createMockRunRepo,
  createMockToolCallRepo,
  createMockTraceRepo,
  createMockUserRepo,
  createMockUserWorkspaceRepo,
  createMockWorkspaceRepo,
} from '../../../__tests__/helpers.js';
import {
  AUDIENCE,
  ISSUER,
  createManagementMockApiKeyRepo,
  getKey,
  mintToken,
} from './management-helpers.js';

/**
 * Route-protection contract for `/v1/management/*`, asserted through the REAL
 * Cognito middleware — `buildApp` is given `cognitoIssuerUrl` / `cognitoClientId`
 * / `cognitoGetKey`, so `registerCognitoAuth` verifies every token here for real.
 *
 * The matrix splits along the two layers that enforce it:
 *
 * - **Authentication** is a plugin-level `onRequest` hook registered once in
 *   `managementPlugin`, so it is route-independent. It is asserted against the
 *   representative route `GET /v1/management/me`; the same hook guards every
 *   route under the prefix identically.
 * - **Authorization** (workspace membership) lives in each handler, so it is
 *   asserted per protected resource.
 *
 * `401` means "authentication failed" (absent / wrong-type / invalid token);
 * `403` means "authenticated principal, not a member". An authenticated caller
 * is always a valid principal (see `resolveOrCreateUser`), so a membership
 * failure must never degrade to `401`.
 */

const ME = '/v1/management/me';

async function buildProtectedApp(): Promise<FastifyInstance> {
  const { app } = await buildApp({
    runExecutionService: createMockRunExecutionService(),
    repos: {
      apiKeyRepo: createManagementMockApiKeyRepo(),
      agentRepo: createMockAgentRepo(),
      sessionRepo: createMockSessionRepo(),
      messageRepo: createMockMessageRepo(),
      runRepo: createMockRunRepo(),
      toolCallRepo: createMockToolCallRepo(),
      traceRepo: createMockTraceRepo(),
      userRepo: createMockUserRepo(),
      userWorkspaceRepo: createMockUserWorkspaceRepo(),
      workspaceRepo: createMockWorkspaceRepo(),
    },
    jwtSecret: TEST_JWT_SECRET,
    cognitoIssuerUrl: ISSUER,
    cognitoClientId: AUDIENCE,
    cognitoGetKey: getKey,
    logger: false,
  });

  await app.ready();
  return app;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

// ── Authentication (plugin-level hook) ─────────────────────────────

describe('Management route protection — authentication', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildProtectedApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await app.inject({ method: 'GET', url: ME });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('accepts a valid Cognito ID token with 200 and echoes the principal', async () => {
    const token = await mintToken({
      token_use: 'id',
      sub: 'sub-valid',
      email: 'valid@example.com',
    });

    const res = await app.inject({ method: 'GET', url: ME, headers: bearer(token) });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cognitoSub).toBe('sub-valid');
    expect(body.email).toBe('valid@example.com');
    expect(body.userId).toMatch(/^usr_/);
  });

  it('accepts a valid Cognito ID token with 201 on workspace create', async () => {
    const token = await mintToken({ token_use: 'id', sub: 'sub-creator' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/management/workspaces',
      headers: bearer(token),
      payload: { name: 'Protected Workspace' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().workspaceId).toMatch(/^ws_/);
  });

  it('rejects a realistically-shaped Cognito access token with 401 on token type', async () => {
    // A real access token: token_use "access", no `aud` (it carries `client_id`),
    // no `email`. It must fail on the TYPE assertion — proving WS-19's ordering
    // holds end-to-end and not incidentally via the audience/email checks.
    const token = await mintToken({
      token_use: 'access',
      includeAud: false,
      includeEmail: false,
    });

    const res = await app.inject({ method: 'GET', url: ME, headers: bearer(token) });

    expect(res.statusCode).toBe(401);
    const { error } = res.json();
    expect(error.code).toBe('UNAUTHORIZED');
    expect(error.message).toMatch(/token_use/i);
    expect(error.message).toMatch(/access/);
    expect(error.message).not.toMatch(/audience/i);
    expect(error.message).not.toMatch(/email/i);
  });

  it('rejects a token with no token_use claim with 401', async () => {
    const token = await mintToken({ token_use: null });

    const res = await app.inject({ method: 'GET', url: ME, headers: bearer(token) });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a token with the wrong audience with 401', async () => {
    const token = await mintToken({ aud: 'wrong-client-id' });

    const res = await app.inject({ method: 'GET', url: ME, headers: bearer(token) });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects an expired token with 401', async () => {
    const token = await mintToken({ exp: Math.floor(Date.now() / 1000) - 3600 });

    const res = await app.inject({ method: 'GET', url: ME, headers: bearer(token) });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });
});

// ── Authorization (per handler) ────────────────────────────────────

describe('Management route protection — cross-workspace authorization', () => {
  let app: FastifyInstance;
  let tokenA: string;
  let tokenB: string;
  let workspaceId: string;
  let apiKeyId: string;

  beforeAll(async () => {
    app = await buildProtectedApp();

    tokenA = await mintToken({ sub: 'sub-A', email: 'a@example.com' });
    tokenB = await mintToken({ sub: 'sub-B', email: 'b@example.com' });

    // User A owns a workspace containing one API key. Both users are JIT
    // provisioned by the handlers from their verified tokens.
    const wsRes = await app.inject({
      method: 'POST',
      url: '/v1/management/workspaces',
      headers: bearer(tokenA),
      payload: { name: "A's Workspace" },
    });
    expect(wsRes.statusCode).toBe(201);
    workspaceId = wsRes.json().workspaceId;

    const keyRes = await app.inject({
      method: 'POST',
      url: `/v1/management/workspaces/${workspaceId}/keys`,
      headers: bearer(tokenA),
      payload: { name: 'a-key' },
    });
    expect(keyRes.statusCode).toBe(201);
    apiKeyId = keyRes.json().apiKeyId;
  });

  afterAll(async () => {
    await app.close();
  });

  it("lets the owner read their own workspace (control for the 403 cases)", async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/management/workspaces/${workspaceId}`,
      headers: bearer(tokenA),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().workspaceId).toBe(workspaceId);
  });

  // Authorization is enforced per handler, so every protected resource of A's
  // workspace is asserted individually — read and write, workspace and keys.
  // `url`/`payload` are lazy because the ids are only known after `beforeAll`.
  const resources: {
    label: string;
    method: 'GET' | 'POST' | 'DELETE';
    url: () => string;
    payload?: Record<string, string>;
  }[] = [
    {
      label: 'GET /workspaces/:id',
      method: 'GET',
      url: () => `/v1/management/workspaces/${workspaceId}`,
    },
    {
      label: 'GET /workspaces/:id/keys',
      method: 'GET',
      url: () => `/v1/management/workspaces/${workspaceId}/keys`,
    },
    {
      label: 'POST /workspaces/:id/keys',
      method: 'POST',
      url: () => `/v1/management/workspaces/${workspaceId}/keys`,
      payload: { name: 'b-key' },
    },
    {
      label: 'DELETE /workspaces/:id/keys/:keyId',
      method: 'DELETE',
      url: () => `/v1/management/workspaces/${workspaceId}/keys/${apiKeyId}`,
    },
  ];

  it.each(resources)('rejects user B with 403 on $label', async ({ method, url, payload }) => {
    const res = await app.inject({
      method,
      url: url(),
      headers: bearer(tokenB),
      payload,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it("does not let user B's rejected requests mutate A's workspace", async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/management/workspaces/${workspaceId}/keys`,
      headers: bearer(tokenA),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0].apiKeyId).toBe(apiKeyId);
    expect(body[0].revokedAt).toBeNull();
  });
});
