import type { FastifyInstance } from 'fastify';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { SwiftAgentError } from '@swiftagent/shared';
import type { ManagementAuthenticatedRequest } from '../types.js';

export interface CognitoAuthOptions {
  issuerUrl: string;
  audience: string;
  /** Optional override for JWT key resolution — use `createLocalJWKSet` in tests. */
  getKey?: JWTVerifyGetKey;
}

export function registerCognitoAuth(
  app: FastifyInstance,
  opts: CognitoAuthOptions,
): void {
  let JWKS: JWTVerifyGetKey;

  if (opts.getKey) {
    JWKS = opts.getKey;
  } else {
    // Normalize issuerUrl to end with /
    const normalizedIssuer = opts.issuerUrl.endsWith('/')
      ? opts.issuerUrl
      : `${opts.issuerUrl}/`;
    const jwksUri = new URL('.well-known/jwks.json', normalizedIssuer);
    JWKS = createRemoteJWKSet(jwksUri);
  }

  app.addHook('onRequest', async (req, _reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new SwiftAgentError(
        'UNAUTHORIZED',
        'Missing or invalid Authorization header',
      );
    }

    const token = authHeader.slice(7);
    if (!token) {
      throw new SwiftAgentError('UNAUTHORIZED', 'Missing token');
    }

    try {
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: opts.issuerUrl,
        audience: opts.audience,
      });

      const sub = payload.sub;
      const email = payload.email as string | undefined;

      if (!sub) {
        throw new SwiftAgentError('UNAUTHORIZED', 'Token missing sub claim');
      }

      if (!email) {
        throw new SwiftAgentError('UNAUTHORIZED', 'Token missing email claim');
      }

      (req as ManagementAuthenticatedRequest).cognitoSub = sub;
      (req as ManagementAuthenticatedRequest).email = email;
    } catch (err) {
      if (err instanceof SwiftAgentError) throw err;
      throw new SwiftAgentError('UNAUTHORIZED', 'Invalid or expired token', {
        cause: err,
      });
    }
  });
}
