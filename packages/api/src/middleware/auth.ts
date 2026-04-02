import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ApiKeyRepo } from '@swiftagent/db';
import { SwiftAgentError } from '@swiftagent/shared';
import type { AuthenticatedRequest } from '../types.js';

const SKIP_AUTH_PATHS = new Set(['/health', '/v1/health']);

function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function registerAuth(app: FastifyInstance, apiKeyRepo: ApiKeyRepo): void {
  app.addHook('onRequest', async (req, _reply) => {
    const path = req.url.split('?')[0] ?? '';
    if (SKIP_AUTH_PATHS.has(path)) return;

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new SwiftAgentError('UNAUTHORIZED', 'Missing or invalid Authorization header');
    }

    const token = authHeader.slice(7);
    if (!token) {
      throw new SwiftAgentError('UNAUTHORIZED', 'Missing API key');
    }

    const keyHash = hashApiKey(token);
    const apiKey = await apiKeyRepo.getByKeyHash(keyHash);

    if (!apiKey || apiKey.revokedAt) {
      throw new SwiftAgentError('UNAUTHORIZED', 'Invalid or revoked API key');
    }

    (req as AuthenticatedRequest).workspaceId = apiKey.workspaceId;
    (req as AuthenticatedRequest).apiKeyId = apiKey.apiKeyId;
  });
}
