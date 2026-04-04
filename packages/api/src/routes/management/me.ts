import type { FastifyInstance } from 'fastify';
import type { UserRepo } from '@swiftagent/db';
import { generateUserId } from '@swiftagent/shared';
import type { ManagementAuthenticatedRequest } from '../../types.js';

export function registerMeRoutes(
  app: FastifyInstance,
  deps: { userRepo: UserRepo },
): void {
  const { userRepo } = deps;

  // GET /me — current user; JIT create if missing
  app.get('/me', async (req, reply) => {
    const { cognitoSub, email } = req as ManagementAuthenticatedRequest;

    let user = await userRepo.getByCognitoSub(cognitoSub);

    if (!user) {
      const userId = generateUserId();
      // ON CONFLICT DO NOTHING handled by the repo layer;
      // if a race creates the row first, this is a no-op.
      try {
        user = await userRepo.create({ userId, cognitoSub, email });
      } catch {
        // Concurrent insert — re-read
        user = await userRepo.getByCognitoSub(cognitoSub);
      }

      // Re-read to guarantee we have the row (covers ON CONFLICT DO NOTHING)
      if (!user) {
        user = await userRepo.getByCognitoSub(cognitoSub);
      }
    }

    return reply.send(user);
  });
}
