import type { FastifyInstance } from 'fastify';
import type { UserRepo, UserWorkspaceRepo, WorkspaceRepo, ApiKeyRepo } from '@swiftagent/db';
import { registerCognitoAuth } from '../../middleware/cognito-auth.js';
import { registerMeRoutes } from './me.js';
import { registerWorkspaceRoutes } from './workspaces.js';
import { registerKeyRoutes } from './keys.js';

export interface ManagementPluginOptions {
  issuerUrl: string;
  audience: string;
  userRepo: UserRepo;
  userWorkspaceRepo: UserWorkspaceRepo;
  workspaceRepo: WorkspaceRepo;
  apiKeyRepo: ApiKeyRepo;
}

export async function managementPlugin(
  app: FastifyInstance,
  opts: ManagementPluginOptions,
): Promise<void> {
  // Cognito JWT auth on this scope
  registerCognitoAuth(app, {
    issuerUrl: opts.issuerUrl,
    audience: opts.audience,
  });

  // Routes
  registerMeRoutes(app, { userRepo: opts.userRepo });
  registerWorkspaceRoutes(app, {
    userRepo: opts.userRepo,
    userWorkspaceRepo: opts.userWorkspaceRepo,
    workspaceRepo: opts.workspaceRepo,
  });
  registerKeyRoutes(app, {
    userRepo: opts.userRepo,
    userWorkspaceRepo: opts.userWorkspaceRepo,
    apiKeyRepo: opts.apiKeyRepo,
  });
}
