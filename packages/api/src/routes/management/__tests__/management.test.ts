import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ApiKeyRepo } from '@swiftagent/db';
import type { ApiKeyRecord } from '@swiftagent/shared';
import {
  createMockUserRepo,
  createMockUserWorkspaceRepo,
  createMockWorkspaceRepo,
} from '../../../__tests__/helpers.js';
import { registerErrorHandler } from '../../../middleware/error-handler.js';
import { registerMeRoutes } from '../me.js';
import { registerWorkspaceRoutes } from '../workspaces.js';
import { registerKeyRoutes } from '../keys.js';
import type { ManagementAuthenticatedRequest } from '../../../types.js';

/** Management-specific mock that actually stores created keys. */
function createManagementMockApiKeyRepo(): ApiKeyRepo {
  const keys = new Map<string, ApiKeyRecord>();

  return {
    create: async (record) => {
      const key: ApiKeyRecord = {
        apiKeyId: record.apiKeyId,
        workspaceId: record.workspaceId,
        keyHash: record.keyHash,
        name: record.name,
        createdAt: new Date(),
        revokedAt: null,
      };
      keys.set(record.apiKeyId, key);
      return key;
    },
    getByKeyHash: async () => null,
    listByWorkspace: async (workspaceId) =>
      [...keys.values()].filter((k) => k.workspaceId === workspaceId),
    revoke: async (apiKeyId) => {
      const key = keys.get(apiKeyId);
      if (!key) return null;
      const revoked = { ...key, revokedAt: new Date() };
      keys.set(apiKeyId, revoked);
      return revoked;
    },
  };
}

const TEST_COGNITO_SUB = 'cognito-sub-12345';
const TEST_EMAIL = 'test@example.com';

/**
 * Build a minimal Fastify instance with mocked Cognito auth
 * (decorates cognitoSub/email via preHandler instead of real JWKS).
 */
async function buildManagementTestApp() {
  const userRepo = createMockUserRepo();
  const userWorkspaceRepo = createMockUserWorkspaceRepo();
  const workspaceRepo = createMockWorkspaceRepo();
  const apiKeyRepo = createManagementMockApiKeyRepo();

  const app = Fastify({ logger: false });

  // Register error handler so Zod errors → 400
  registerErrorHandler(app);

  // Mock Cognito auth — inject cognitoSub + email
  app.addHook('onRequest', async (req) => {
    (req as ManagementAuthenticatedRequest).cognitoSub = TEST_COGNITO_SUB;
    (req as ManagementAuthenticatedRequest).email = TEST_EMAIL;
  });

  registerMeRoutes(app, { userRepo });
  registerWorkspaceRoutes(app, { userRepo, userWorkspaceRepo, workspaceRepo });
  registerKeyRoutes(app, { userRepo, userWorkspaceRepo, apiKeyRepo });

  await app.ready();
  return { app, userRepo, userWorkspaceRepo, workspaceRepo, apiKeyRepo };
}

describe('Management API routes', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    const ctx = await buildManagementTestApp();
    app = ctx.app;
  });

  afterAll(async () => {
    await app.close();
  });

  // ── GET /me ──────────────────────────────────────────────────────

  describe('GET /me', () => {
    it('creates user on first hit (JIT provisioning)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/me',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.cognitoSub).toBe(TEST_COGNITO_SUB);
      expect(body.email).toBe(TEST_EMAIL);
      expect(body.userId).toMatch(/^usr_/);
    });

    it('returns same user on second hit (idempotent)', async () => {
      const res1 = await app.inject({ method: 'GET', url: '/me' });
      const res2 = await app.inject({ method: 'GET', url: '/me' });

      expect(res1.json().userId).toBe(res2.json().userId);
    });
  });

  // ── POST /workspaces ─────────────────────────────────────────────

  describe('POST /workspaces', () => {
    it('creates workspace and sets owner membership', async () => {
      // Ensure user exists
      await app.inject({ method: 'GET', url: '/me' });

      const res = await app.inject({
        method: 'POST',
        url: '/workspaces',
        payload: { name: 'My Workspace' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.workspaceId).toMatch(/^ws_/);
      expect(body.name).toBe('My Workspace');
    });

    it('returns 400 for empty name', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/workspaces',
        payload: { name: '' },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // ── GET /workspaces ──────────────────────────────────────────────

  describe('GET /workspaces', () => {
    it('lists workspaces for current user', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/workspaces',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── GET /workspaces/:id ──────────────────────────────────────────

  describe('GET /workspaces/:id', () => {
    it('returns workspace detail for member', async () => {
      // Create a workspace first
      await app.inject({ method: 'GET', url: '/me' });
      const createRes = await app.inject({
        method: 'POST',
        url: '/workspaces',
        payload: { name: 'Detail Workspace' },
      });
      const { workspaceId } = createRes.json();

      const res = await app.inject({
        method: 'GET',
        url: `/workspaces/${workspaceId}`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().workspaceId).toBe(workspaceId);
    });

    it('returns 403 for non-member', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/workspaces/ws_nonexistent00000000',
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // ── API key routes ───────────────────────────────────────────────

  describe('API key routes', () => {
    let workspaceId: string;

    beforeAll(async () => {
      // Ensure user and workspace
      await app.inject({ method: 'GET', url: '/me' });
      const wsRes = await app.inject({
        method: 'POST',
        url: '/workspaces',
        payload: { name: 'Key Workspace' },
      });
      workspaceId = wsRes.json().workspaceId;
    });

    describe('POST /workspaces/:id/keys', () => {
      it('creates API key and returns raw key once', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/workspaces/${workspaceId}/keys`,
          payload: { name: 'my-key' },
        });

        expect(res.statusCode).toBe(201);
        const body = res.json();
        expect(body.rawKey).toMatch(/^ak_/);
        expect(body.rawKey.length).toBeGreaterThan(10);
        expect(body.apiKeyId).toMatch(/^ak_/);
        expect(body.name).toBe('my-key');
      });

      it('returns 403 for non-member workspace', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/workspaces/ws_otherperson0000000/keys',
          payload: { name: 'should-fail' },
        });

        expect(res.statusCode).toBe(403);
      });
    });

    describe('GET /workspaces/:id/keys', () => {
      it('lists keys without secrets', async () => {
        // Create a key first
        await app.inject({
          method: 'POST',
          url: `/workspaces/${workspaceId}/keys`,
          payload: { name: 'list-test-key' },
        });

        const res = await app.inject({
          method: 'GET',
          url: `/workspaces/${workspaceId}/keys`,
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(Array.isArray(body)).toBe(true);
        // Ensure no raw key or hash in response
        for (const key of body) {
          expect(key).not.toHaveProperty('rawKey');
          expect(key).not.toHaveProperty('keyHash');
        }
      });
    });

    describe('DELETE /workspaces/:id/keys/:keyId', () => {
      it('revokes an existing key', async () => {
        // Create a key
        const createRes = await app.inject({
          method: 'POST',
          url: `/workspaces/${workspaceId}/keys`,
          payload: { name: 'revoke-test-key' },
        });
        const { apiKeyId } = createRes.json();

        const res = await app.inject({
          method: 'DELETE',
          url: `/workspaces/${workspaceId}/keys/${apiKeyId}`,
        });

        expect(res.statusCode).toBe(204);
      });

      it('returns 404 for key not in workspace', async () => {
        const res = await app.inject({
          method: 'DELETE',
          url: `/workspaces/${workspaceId}/keys/ak_nonexistent00000000`,
        });

        expect(res.statusCode).toBe(404);
      });

      it('returns 403 for non-member workspace', async () => {
        const res = await app.inject({
          method: 'DELETE',
          url: '/workspaces/ws_otherperson0000000/keys/ak_somekey000000',
        });

        expect(res.statusCode).toBe(403);
      });
    });
  });
});
