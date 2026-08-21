import type { UserRepo } from '@swiftagent/db';
import { generateUserId, SwiftAgentError, type UserRecord } from '@swiftagent/shared';

/**
 * Resolve the authenticated Cognito principal to a local user row, creating it
 * just-in-time when absent.
 *
 * Every management request carries a Cognito JWT already verified by the auth
 * middleware (guaranteed `sub` + `email`), so an authenticated caller is always
 * a valid principal. Provisioning must therefore not depend on `GET /me` having
 * been called first — otherwise a legitimate, authenticated user hitting a
 * resource they don't belong to would get a misleading `401` instead of the
 * correct `403`.
 */
export async function resolveOrCreateUser(
  userRepo: UserRepo,
  cognitoSub: string,
  email: string,
): Promise<UserRecord> {
  const existing = await userRepo.getByCognitoSub(cognitoSub);
  if (existing) return existing;

  try {
    return await userRepo.create({ userId: generateUserId(), cognitoSub, email });
  } catch {
    // Concurrent insert won the race — re-read the row it created.
    const user = await userRepo.getByCognitoSub(cognitoSub);
    if (!user) {
      throw new SwiftAgentError('INTERNAL', 'Failed to provision user');
    }
    return user;
  }
}
