import * as jose from 'jose';
import type { ClientTokenClaims } from '@swiftagent/shared';

export interface TokenServiceOptions {
  secret: string;
  issuer?: string;
  audience?: string;
  defaultTtlSeconds?: number;
}

export interface TokenService {
  signClientToken(payload: {
    sessionId: string;
    agentId: string;
    permissions: string[];
  }): Promise<string>;
  verifyClientToken(token: string): Promise<ClientTokenClaims>;
}

export function createTokenService(opts: TokenServiceOptions): TokenService {
  const secret = new TextEncoder().encode(opts.secret);
  const issuer = opts.issuer ?? 'swiftagent';
  const audience = opts.audience ?? 'swiftagent-gateway';
  const defaultTtl = opts.defaultTtlSeconds ?? 900; // 15 minutes

  return {
    async signClientToken(payload) {
      const now = Math.floor(Date.now() / 1000);
      const exp = now + defaultTtl;

      const jwt = await new jose.SignJWT({
        sessionId: payload.sessionId,
        agentId: payload.agentId,
        permissions: payload.permissions,
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt(now)
        .setExpirationTime(exp)
        .setIssuer(issuer)
        .setAudience(audience)
        .sign(secret);

      return jwt;
    },

    async verifyClientToken(token) {
      const { payload } = await jose.jwtVerify(token, secret, {
        issuer,
        audience,
      });

      return {
        sessionId: payload.sessionId as string,
        agentId: payload.agentId as string,
        permissions: payload.permissions as string[],
        exp: payload.exp ?? 0,
        iss: payload.iss,
        aud: payload.aud as string | undefined,
      };
    },
  };
}
