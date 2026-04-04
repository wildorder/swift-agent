import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { buildApp, type AppContext } from '@swiftagent/api';
import {
  createDbClient,
  createWorkspaceRepo,
  createApiKeyRepo,
  createAgentRepo,
  createSessionRepo,
  createMessageRepo,
  createRunRepo,
  createToolCallRepo,
  createTraceRepo,
  createUserRepo,
  createUserWorkspaceRepo,
} from '@swiftagent/db';
import type { Db } from '@swiftagent/db';
import { generateWorkspaceId, generateApiKeyId } from '@swiftagent/shared';

// ── Constants ────────────────────────────────────────────────────────

const ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TestPool';
const AUDIENCE = 'test-client-id';
const SUB_USER_1 = 'cognito-sub-user-1';
const EMAIL_USER_1 = 'user1@example.com';
const SUB_USER_2 = 'cognito-sub-user-2';
const EMAIL_USER_2 = 'user2@example.com';

// ── State ────────────────────────────────────────────────────────────

let db: Db;
let dbClose: () => Promise<void>;
let privateKey: CryptoKey;
let wrongPrivateKey: CryptoKey;
let localJwkSet: ReturnType<typeof createLocalJWKSet>;
let api: AppContext;

// ── Helpers ──────────────────────────────────────────────────────────

async function mintToken(overrides: {
  iss?: string;
  aud?: string;
  sub?: string;
  email?: string;
  exp?: number;
  signingKey?: CryptoKey;
} = {}): Promise<string> {
  const key = overrides.signingKey ?? privateKey;
  let builder = new SignJWT({
    email: overrides.email ?? EMAIL_USER_1,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-kid-1' })
    .setIssuedAt()
    .setIssuer(overrides.iss ?? ISSUER)
    .setAudience(overrides.aud ?? AUDIENCE)
    .setSubject(overrides.sub ?? SUB_USER_1);

  if (overrides.exp !== undefined) {
    builder = builder.setExpirationTime(overrides.exp);
  } else {
    builder = builder.setExpirationTime('5m');
  }

  return builder.sign(key);
}

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

// ── Setup / Teardown ─────────────────────────────────────────────────

beforeAll(async () => {
  // 1. Database
  const databaseUrl = process.env['DATABASE_URL'];
  expect(databaseUrl).toBeDefined();
  const client = createDbClient(databaseUrl!);
  db = client.db;
  dbClose = client.close;

  // 2. RSA key pair for signing test JWTs
  const { privateKey: priv, publicKey: pub } = await generateKeyPair('RS256');
  privateKey = priv;

  const publicJwk = await exportJWK(pub);
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  publicJwk.kid = 'test-kid-1';

  localJwkSet = createLocalJWKSet({ keys: [publicJwk] });

  // Wrong key for signature mismatch tests
  const { privateKey: wrongPriv } = await generateKeyPair('RS256');
  wrongPrivateKey = wrongPriv;

  // 3. Build repos
  const repos = {
    workspaceRepo: createWorkspaceRepo(db),
    apiKeyRepo: createApiKeyRepo(db),
    agentRepo: createAgentRepo(db),
    sessionRepo: createSessionRepo(db),
    messageRepo: createMessageRepo(db),
    runRepo: createRunRepo(db),
    toolCallRepo: createToolCallRepo(db),
    traceRepo: createTraceRepo(db),
    userRepo: createUserRepo(db),
    userWorkspaceRepo: createUserWorkspaceRepo(db),
  };

  // 4. Build Fastify app (same middleware order as production)
  api = await buildApp({
    repos,
    jwtSecret: 'test-jwt-secret-for-client-tokens',
    cognitoIssuerUrl: ISSUER,
    cognitoClientId: AUDIENCE,
    cognitoGetKey: localJwkSet,
    logger: false,
  });
});

afterAll(async () => {
  await api.app.close();
  await dbClose();
});

// ── Management API Tests ─────────────────────────────────────────────

describe('GET /v1/management/me', () => {
  it('JIT-creates user on first request', async () => {
    const token = await mintToken();
    const res = await api.app.inject({
      method: 'GET',
      url: '/v1/management/me',
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cognitoSub).toBe(SUB_USER_1);
    expect(body.email).toBe(EMAIL_USER_1);
    expect(body.userId).toMatch(/^usr_/);
  });

  it('returns same user on second request', async () => {
    const token = await mintToken();
    const res1 = await api.app.inject({
      method: 'GET',
      url: '/v1/management/me',
      headers: authHeader(token),
    });
    const res2 = await api.app.inject({
      method: 'GET',
      url: '/v1/management/me',
      headers: authHeader(token),
    });

    expect(res1.json().userId).toBe(res2.json().userId);
  });
});

describe('POST /v1/management/workspaces', () => {
  it('creates workspace and assigns creator as owner', async () => {
    const token = await mintToken();
    const res = await api.app.inject({
      method: 'POST',
      url: '/v1/management/workspaces',
      headers: { ...authHeader(token), 'content-type': 'application/json' },
      payload: { name: 'Test Workspace' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.workspaceId).toMatch(/^ws_/);
    expect(body.name).toBe('Test Workspace');
  });
});

describe('GET /v1/management/workspaces', () => {
  it('lists only the authenticated user workspaces', async () => {
    const token1 = await mintToken();

    // Create a workspace as user 1
    await api.app.inject({
      method: 'POST',
      url: '/v1/management/workspaces',
      headers: { ...authHeader(token1), 'content-type': 'application/json' },
      payload: { name: 'User1 Workspace' },
    });

    // List as user 1
    const res1 = await api.app.inject({
      method: 'GET',
      url: '/v1/management/workspaces',
      headers: authHeader(token1),
    });

    expect(res1.statusCode).toBe(200);
    const workspaces1 = res1.json() as { workspaceId: string; name: string }[];
    expect(workspaces1.length).toBeGreaterThanOrEqual(1);
    expect(workspaces1.some((w) => w.name === 'User1 Workspace')).toBe(true);

    // Create user2 and list — should NOT see user1's workspace
    const token2 = await mintToken({ sub: SUB_USER_2, email: EMAIL_USER_2 });
    // JIT user2
    await api.app.inject({
      method: 'GET',
      url: '/v1/management/me',
      headers: authHeader(token2),
    });

    const res2 = await api.app.inject({
      method: 'GET',
      url: '/v1/management/workspaces',
      headers: authHeader(token2),
    });

    expect(res2.statusCode).toBe(200);
    const workspaces2 = res2.json() as { workspaceId: string; name: string }[];
    expect(workspaces2.every((w) => w.name !== 'User1 Workspace')).toBe(true);
  });
});

describe('GET /v1/management/workspaces/:id', () => {
  it('returns 200 for member', async () => {
    const token = await mintToken();
    const createRes = await api.app.inject({
      method: 'POST',
      url: '/v1/management/workspaces',
      headers: { ...authHeader(token), 'content-type': 'application/json' },
      payload: { name: 'Detail Test' },
    });
    const { workspaceId } = createRes.json() as { workspaceId: string };

    const res = await api.app.inject({
      method: 'GET',
      url: `/v1/management/workspaces/${workspaceId}`,
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().workspaceId).toBe(workspaceId);
  });

  it('returns 403 for non-member', async () => {
    const token1 = await mintToken();
    const createRes = await api.app.inject({
      method: 'POST',
      url: '/v1/management/workspaces',
      headers: { ...authHeader(token1), 'content-type': 'application/json' },
      payload: { name: 'Forbidden Test' },
    });
    const { workspaceId } = createRes.json() as { workspaceId: string };

    // user2 tries to access
    const token2 = await mintToken({ sub: SUB_USER_2, email: EMAIL_USER_2 });
    const res = await api.app.inject({
      method: 'GET',
      url: `/v1/management/workspaces/${workspaceId}`,
      headers: authHeader(token2),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });
});

describe('POST /v1/management/workspaces/:id/keys', () => {
  it('returns raw key on creation; raw key not exposed afterward', async () => {
    const token = await mintToken();
    const wsRes = await api.app.inject({
      method: 'POST',
      url: '/v1/management/workspaces',
      headers: { ...authHeader(token), 'content-type': 'application/json' },
      payload: { name: 'Key Test WS' },
    });
    const { workspaceId } = wsRes.json() as { workspaceId: string };

    // Create key
    const createRes = await api.app.inject({
      method: 'POST',
      url: `/v1/management/workspaces/${workspaceId}/keys`,
      headers: { ...authHeader(token), 'content-type': 'application/json' },
      payload: { name: 'My Key' },
    });

    expect(createRes.statusCode).toBe(201);
    const keyBody = createRes.json();
    expect(keyBody.rawKey).toBeDefined();
    expect(keyBody.rawKey).toMatch(/^ak_/);
    expect(keyBody.apiKeyId).toMatch(/^ak_/);
    expect(keyBody.name).toBe('My Key');

    // List keys — rawKey should NOT be present
    const listRes = await api.app.inject({
      method: 'GET',
      url: `/v1/management/workspaces/${workspaceId}/keys`,
      headers: authHeader(token),
    });

    expect(listRes.statusCode).toBe(200);
    const keys = listRes.json() as Record<string, unknown>[];
    expect(keys.length).toBeGreaterThanOrEqual(1);
    for (const k of keys) {
      expect(k).not.toHaveProperty('rawKey');
      expect(k).not.toHaveProperty('keyHash');
    }
  });
});

describe('GET /v1/management/workspaces/:id/keys', () => {
  it('lists key metadata without raw key or hash', async () => {
    const token = await mintToken();
    const wsRes = await api.app.inject({
      method: 'POST',
      url: '/v1/management/workspaces',
      headers: { ...authHeader(token), 'content-type': 'application/json' },
      payload: { name: 'Keys List WS' },
    });
    const { workspaceId } = wsRes.json() as { workspaceId: string };

    // Create two keys
    for (const name of ['Key A', 'Key B']) {
      await api.app.inject({
        method: 'POST',
        url: `/v1/management/workspaces/${workspaceId}/keys`,
        headers: { ...authHeader(token), 'content-type': 'application/json' },
        payload: { name },
      });
    }

    const listRes = await api.app.inject({
      method: 'GET',
      url: `/v1/management/workspaces/${workspaceId}/keys`,
      headers: authHeader(token),
    });

    expect(listRes.statusCode).toBe(200);
    const keys = listRes.json() as { apiKeyId: string; name: string; revokedAt: string | null }[];
    expect(keys).toHaveLength(2);
    for (const k of keys) {
      expect(k.apiKeyId).toMatch(/^ak_/);
      expect(k.revokedAt).toBeNull();
    }
  });
});

describe('DELETE /v1/management/workspaces/:id/keys/:keyId', () => {
  it('revokes a key; list reflects revocation', async () => {
    const token = await mintToken();
    const wsRes = await api.app.inject({
      method: 'POST',
      url: '/v1/management/workspaces',
      headers: { ...authHeader(token), 'content-type': 'application/json' },
      payload: { name: 'Revoke WS' },
    });
    const { workspaceId } = wsRes.json() as { workspaceId: string };

    const createRes = await api.app.inject({
      method: 'POST',
      url: `/v1/management/workspaces/${workspaceId}/keys`,
      headers: { ...authHeader(token), 'content-type': 'application/json' },
      payload: { name: 'Revokable Key' },
    });
    const { apiKeyId } = createRes.json() as { apiKeyId: string };

    // Revoke
    const delRes = await api.app.inject({
      method: 'DELETE',
      url: `/v1/management/workspaces/${workspaceId}/keys/${apiKeyId}`,
      headers: authHeader(token),
    });

    expect(delRes.statusCode).toBe(204);

    // List — key should have revokedAt set
    const listRes = await api.app.inject({
      method: 'GET',
      url: `/v1/management/workspaces/${workspaceId}/keys`,
      headers: authHeader(token),
    });

    const keys = listRes.json() as { apiKeyId: string; revokedAt: string | null }[];
    const revoked = keys.find((k) => k.apiKeyId === apiKeyId);
    expect(revoked).toBeDefined();
    expect(revoked!.revokedAt).not.toBeNull();
  });
});

// ── Auth error scenarios ─────────────────────────────────────────────

describe('401 — authentication failures', () => {
  it('rejects missing Authorization header', async () => {
    const res = await api.app.inject({
      method: 'GET',
      url: '/v1/management/me',
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects invalid JWT', async () => {
    const res = await api.app.inject({
      method: 'GET',
      url: '/v1/management/me',
      headers: authHeader('not.a.valid.jwt'),
    });

    expect(res.statusCode).toBe(401);
  });

  it('rejects JWT signed with wrong key', async () => {
    const token = await mintToken({ signingKey: wrongPrivateKey });
    const res = await api.app.inject({
      method: 'GET',
      url: '/v1/management/me',
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(401);
  });

  it('rejects expired JWT', async () => {
    const token = await mintToken({ exp: Math.floor(Date.now() / 1000) - 3600 });
    const res = await api.app.inject({
      method: 'GET',
      url: '/v1/management/me',
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(401);
  });
});

describe('403 — authorization failures', () => {
  it('non-member cannot access workspace keys', async () => {
    const token1 = await mintToken();
    const wsRes = await api.app.inject({
      method: 'POST',
      url: '/v1/management/workspaces',
      headers: { ...authHeader(token1), 'content-type': 'application/json' },
      payload: { name: 'Forbidden Keys WS' },
    });
    const { workspaceId } = wsRes.json() as { workspaceId: string };

    const token2 = await mintToken({ sub: SUB_USER_2, email: EMAIL_USER_2 });
    const res = await api.app.inject({
      method: 'GET',
      url: `/v1/management/workspaces/${workspaceId}/keys`,
      headers: authHeader(token2),
    });

    expect(res.statusCode).toBe(403);
  });
});

// ── Regression: /v1/* API key auth still works ───────────────────────

describe('Regression: API key auth on /v1/*', () => {
  it('/v1/health returns 200 (public endpoint unaffected)', async () => {
    const res = await api.app.inject({
      method: 'GET',
      url: '/v1/health',
    });

    expect(res.statusCode).toBe(200);
  });

  it('/v1/agents with valid API key returns 200', async () => {
    // Seed a workspace + API key directly in the DB
    const workspaceRepo = createWorkspaceRepo(db);
    const apiKeyRepo = createApiKeyRepo(db);

    const workspace = await workspaceRepo.create({
      workspaceId: generateWorkspaceId(),
      name: `regression-ws-${Date.now()}`,
    });

    const rawKey = `ak_regression_test_key_${Date.now()}`;
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    await apiKeyRepo.create({
      apiKeyId: generateApiKeyId(),
      workspaceId: workspace.workspaceId,
      keyHash,
      name: 'Regression Key',
    });

    // Call a /v1/* route with the API key
    const res = await api.app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: { authorization: `Bearer ${rawKey}` },
    });

    expect(res.statusCode).toBe(200);
  });

  it('/v1/agents without auth returns 401', async () => {
    const res = await api.app.inject({
      method: 'GET',
      url: '/v1/agents',
    });

    expect(res.statusCode).toBe(401);
  });
});
