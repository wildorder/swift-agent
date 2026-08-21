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

/**
 * Accepted-token contract for the Management API (`/v1/management/*`).
 *
 * **A Cognito ID token — and only an ID token — is accepted.** Callers send it as
 * `Authorization: Bearer <cognito-id-token>`. The marketing site consumes this
 * contract via `session.idToken` (never `session.accessToken`).
 *
 * Required claims on an accepted token:
 *
 * | Claim       | Value                                                     |
 * |-------------|-----------------------------------------------------------|
 * | `token_use` | exactly `"id"`                                            |
 * | `aud`       | the Cognito app client id (string, or array containing it) |
 * | `iss`       | the Cognito user pool issuer URL                          |
 * | `sub`       | the Cognito subject (mapped to a local `usr_` row)        |
 * | `email`     | the user's email                                          |
 *
 * A Cognito **access token** (`token_use: "access"`, `client_id` instead of
 * `aud`, no `email`) is rejected with `401` by the `token_use` assertion below.
 * Dual-token acceptance is deliberately not supported.
 *
 * **Validation ordering is load-bearing.** `jose` enforces `aud` *during*
 * `jwtVerify`, but a real access token carries no `aud` at all — so passing
 * `audience` to `jwtVerify` would reject access tokens generically ("invalid or
 * expired token") before `token_use` could ever be read. We therefore let
 * `jwtVerify` check the signature, `iss`, and `exp`/`nbf`, assert `token_use`
 * first, and enforce `aud` manually afterwards. That way the wrong *kind* of
 * token fails with an accurate, actionable token-type error.
 *
 * Every failure below keeps the `SwiftAgentError` code `'UNAUTHORIZED'` (→ HTTP
 * `401`); only the message varies, so the failures are distinguishable without
 * changing the status contract. Authorization (workspace membership) is a
 * separate concern and surfaces as `403` — see `resolveOrCreateUser`.
 */
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
      throw new SwiftAgentError('UNAUTHORIZED', 'Missing bearer token');
    }

    try {
      // `audience` is intentionally NOT passed to jose — it is enforced manually
      // below, AFTER the token-type assertion, so a Cognito access token (which
      // has no `aud`) fails with an accurate token-type error rather than a
      // generic verification failure. Signature, `iss` and `exp`/`nbf` are still
      // fully validated here.
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: opts.issuerUrl,
      });

      // 1. Token type — an ID token carries `token_use: "id"`; an access token
      //    carries `token_use: "access"`. Anything else is the wrong kind of token.
      const tokenUse = payload.token_use as string | undefined;
      if (tokenUse !== 'id') {
        throw new SwiftAgentError(
          'UNAUTHORIZED',
          `Expected a Cognito ID token (token_use "id"), received ${
            tokenUse ? `token_use "${tokenUse}"` : 'a token with no token_use claim'
          }`,
        );
      }

      // 2. Audience — Cognito sets `aud` to the app client id; it is normally a
      //    string but the JWT spec permits an array.
      const aud = payload.aud;
      const audienceOk = Array.isArray(aud)
        ? aud.includes(opts.audience)
        : aud === opts.audience;
      if (!audienceOk) {
        throw new SwiftAgentError('UNAUTHORIZED', 'Invalid token audience');
      }

      // 3. Required identity claims on a well-typed ID token.
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
