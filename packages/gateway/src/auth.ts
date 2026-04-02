import * as jose from 'jose';
import {
  ClientTokenClaimsSchema,
  type ClientTokenClaims,
} from '@swiftagent/shared';

// ── Error codes ────────────────────────────────────────────────────────

export const AuthErrorCode = {
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_MALFORMED: 'TOKEN_MALFORMED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
} as const;

export type AuthErrorCode = typeof AuthErrorCode[keyof typeof AuthErrorCode];

export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

// ── Token validation ───────────────────────────────────────────────────

const ISSUER = 'swiftagent';
const AUDIENCE = 'swiftagent-gateway';

/**
 * Validates a client JWT and returns the decoded claims.
 * Uses jose for JWT verification and Zod for claim shape validation.
 */
export async function validateClientToken(
  token: string,
  jwtSecret: Uint8Array | CryptoKey,
): Promise<ClientTokenClaims> {
  let payload: jose.JWTPayload;

  try {
    const result = await jose.jwtVerify(token, jwtSecret, {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    payload = result.payload;
  } catch (err) {
    if (err instanceof jose.errors.JWTExpired) {
      throw new AuthError(AuthErrorCode.TOKEN_EXPIRED, 'Token has expired');
    }
    if (
      err instanceof jose.errors.JWTInvalid ||
      err instanceof jose.errors.JWTClaimValidationFailed
    ) {
      throw new AuthError(AuthErrorCode.TOKEN_MALFORMED, 'Token is malformed or has invalid claims');
    }
    if (err instanceof jose.errors.JWSSignatureVerificationFailed) {
      throw new AuthError(AuthErrorCode.TOKEN_INVALID, 'Token signature is invalid');
    }
    // Any other jose error → invalid
    throw new AuthError(AuthErrorCode.TOKEN_INVALID, 'Token validation failed');
  }

  // Validate claim shape with Zod
  const parsed = ClientTokenClaimsSchema.safeParse({
    sessionId: payload.sessionId,
    agentId: payload.agentId,
    permissions: payload.permissions,
    exp: payload.exp,
    iss: payload.iss,
    aud: payload.aud,
  });

  if (!parsed.success) {
    throw new AuthError(
      AuthErrorCode.TOKEN_MALFORMED,
      `Token claims do not match expected shape: ${parsed.error.message}`,
    );
  }

  return parsed.data;
}
