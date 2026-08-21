import type { FastifyInstance } from 'fastify';
import type { UserRepo } from '@swiftagent/db';
import type { ManagementAuthenticatedRequest } from '../../types.js';
import { resolveOrCreateUser } from './provision-user.js';

export function registerMeRoutes(
  app: FastifyInstance,
  deps: { userRepo: UserRepo },
): void {
  const { userRepo } = deps;

  // GET /me — current user; JIT create if missing
  app.get('/me', async (req, reply) => {
    const { cognitoSub, email } = req as ManagementAuthenticatedRequest;
    const user = await resolveOrCreateUser(userRepo, cognitoSub, email);
    return reply.send(user);
  });
}
