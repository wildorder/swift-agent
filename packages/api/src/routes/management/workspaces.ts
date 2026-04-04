import type { FastifyInstance } from 'fastify';
import type { UserRepo, UserWorkspaceRepo, WorkspaceRepo } from '@swiftagent/db';
import { generateWorkspaceId, SwiftAgentError } from '@swiftagent/shared';
import type { ManagementAuthenticatedRequest } from '../../types.js';
import { CreateWorkspaceBodySchema } from '../../types.js';

export interface WorkspaceRouteDeps {
  userRepo: UserRepo;
  userWorkspaceRepo: UserWorkspaceRepo;
  workspaceRepo: WorkspaceRepo;
}

/** Resolve the current user (must already exist from GET /me JIT). */
async function resolveUser(userRepo: UserRepo, cognitoSub: string) {
  const user = await userRepo.getByCognitoSub(cognitoSub);
  if (!user) {
    throw new SwiftAgentError('UNAUTHORIZED', 'User not provisioned');
  }
  return user;
}

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  deps: WorkspaceRouteDeps,
): void {
  const { userRepo, userWorkspaceRepo, workspaceRepo } = deps;

  // POST /workspaces — create workspace + owner membership
  app.post('/workspaces', async (req, reply) => {
    const { cognitoSub } = req as ManagementAuthenticatedRequest;
    const body = CreateWorkspaceBodySchema.parse(req.body);
    const user = await resolveUser(userRepo, cognitoSub);

    const workspaceId = generateWorkspaceId();
    const workspace = await workspaceRepo.create({ workspaceId, name: body.name });
    await userWorkspaceRepo.create({ userId: user.userId, workspaceId, role: 'owner' });

    return reply.status(201).send(workspace);
  });

  // GET /workspaces — list current user's workspaces
  app.get('/workspaces', async (req, reply) => {
    const { cognitoSub } = req as ManagementAuthenticatedRequest;
    const user = await resolveUser(userRepo, cognitoSub);

    const memberships = await userWorkspaceRepo.listByUserId(user.userId);
    const workspaces = await Promise.all(
      memberships.map((m) => workspaceRepo.getById(m.workspaceId)),
    );

    // Filter out any null (shouldn't happen, but be safe) and preserve membership order
    return reply.send(workspaces.filter(Boolean));
  });

  // GET /workspaces/:id — workspace detail (member only)
  app.get<{ Params: { id: string } }>('/workspaces/:id', async (req, reply) => {
    const { cognitoSub } = req as ManagementAuthenticatedRequest;
    const user = await resolveUser(userRepo, cognitoSub);
    const { id } = req.params;

    const isMember = await userWorkspaceRepo.isMember(user.userId, id);
    if (!isMember) {
      throw new SwiftAgentError('FORBIDDEN', 'Not a member of this workspace');
    }

    const workspace = await workspaceRepo.getById(id);
    if (!workspace) {
      throw new SwiftAgentError('NOT_FOUND', 'Workspace not found');
    }

    return reply.send(workspace);
  });
}
