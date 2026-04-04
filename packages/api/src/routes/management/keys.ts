import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRepo, UserWorkspaceRepo, ApiKeyRepo } from '@swiftagent/db';
import { generateApiKeyId, SwiftAgentError } from '@swiftagent/shared';
import type { ManagementAuthenticatedRequest } from '../../types.js';
import { CreateApiKeyBodySchema } from '../../types.js';

export interface KeyRouteDeps {
  userRepo: UserRepo;
  userWorkspaceRepo: UserWorkspaceRepo;
  apiKeyRepo: ApiKeyRepo;
}

/** Resolve the current user (must already exist from GET /me JIT). */
async function resolveUser(userRepo: UserRepo, cognitoSub: string) {
  const user = await userRepo.getByCognitoSub(cognitoSub);
  if (!user) {
    throw new SwiftAgentError('UNAUTHORIZED', 'User not provisioned');
  }
  return user;
}

/** Check membership, throw 403 if not a member. */
async function ensureMember(
  userWorkspaceRepo: UserWorkspaceRepo,
  userId: string,
  workspaceId: string,
) {
  const isMember = await userWorkspaceRepo.isMember(userId, workspaceId);
  if (!isMember) {
    throw new SwiftAgentError('FORBIDDEN', 'Not a member of this workspace');
  }
}

export function registerKeyRoutes(
  app: FastifyInstance,
  deps: KeyRouteDeps,
): void {
  const { userRepo, userWorkspaceRepo, apiKeyRepo } = deps;

  // POST /workspaces/:id/keys — create API key; return raw key once
  app.post<{ Params: { id: string } }>('/workspaces/:id/keys', async (req, reply) => {
    const { cognitoSub } = req as ManagementAuthenticatedRequest;
    const body = CreateApiKeyBodySchema.parse(req.body);
    const user = await resolveUser(userRepo, cognitoSub);
    const { id: workspaceId } = req.params;

    await ensureMember(userWorkspaceRepo, user.userId, workspaceId);

    const rawKey = `ak_${nanoid(40)}`;
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const apiKeyId = generateApiKeyId();

    const apiKey = await apiKeyRepo.create({
      apiKeyId,
      workspaceId,
      keyHash,
      name: body.name,
    });

    return reply.status(201).send({
      apiKeyId: apiKey.apiKeyId,
      name: apiKey.name,
      createdAt: apiKey.createdAt,
      revokedAt: apiKey.revokedAt,
      rawKey,
    });
  });

  // GET /workspaces/:id/keys — list keys (metadata only)
  app.get<{ Params: { id: string } }>('/workspaces/:id/keys', async (req, reply) => {
    const { cognitoSub } = req as ManagementAuthenticatedRequest;
    const user = await resolveUser(userRepo, cognitoSub);
    const { id: workspaceId } = req.params;

    await ensureMember(userWorkspaceRepo, user.userId, workspaceId);

    const keys = await apiKeyRepo.listByWorkspace(workspaceId);

    return reply.send(
      keys.map((k) => ({
        apiKeyId: k.apiKeyId,
        name: k.name,
        createdAt: k.createdAt,
        revokedAt: k.revokedAt,
      })),
    );
  });

  // DELETE /workspaces/:id/keys/:keyId — revoke key
  app.delete<{ Params: { id: string; keyId: string } }>(
    '/workspaces/:id/keys/:keyId',
    async (req, reply) => {
      const { cognitoSub } = req as ManagementAuthenticatedRequest;
      const user = await resolveUser(userRepo, cognitoSub);
      const { id: workspaceId, keyId } = req.params;

      await ensureMember(userWorkspaceRepo, user.userId, workspaceId);

      // Verify key belongs to this workspace by checking list
      const keys = await apiKeyRepo.listByWorkspace(workspaceId);
      const keyBelongs = keys.some((k) => k.apiKeyId === keyId);
      if (!keyBelongs) {
        throw new SwiftAgentError('NOT_FOUND', 'API key not found in this workspace');
      }

      const revoked = await apiKeyRepo.revoke(keyId);
      if (!revoked) {
        throw new SwiftAgentError('NOT_FOUND', 'API key not found');
      }

      return reply.status(204).send();
    },
  );
}
