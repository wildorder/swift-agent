import { describe, it, expect } from 'vitest';
import * as jose from 'jose';
import { validateClientToken, AuthError, AuthErrorCode } from '../auth.js';

const JWT_SECRET_STRING = 'test-secret-key-that-is-long-enough-for-hs256';
const JWT_SECRET = new TextEncoder().encode(JWT_SECRET_STRING);
const WRONG_SECRET = new TextEncoder().encode('wrong-secret-key-that-is-long-enough-for-hs256');

async function signToken(
  claims: Record<string, unknown>,
  options?: {
    secret?: Uint8Array;
    expiresIn?: string;
    issuer?: string;
    audience?: string;
    /** Set exp directly (for expired tokens) */
    exp?: number;
  },
): Promise<string> {
  const secret = options?.secret ?? JWT_SECRET;
  let builder = new jose.SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt();

  if (options?.issuer !== undefined) {
    builder = builder.setIssuer(options.issuer);
  } else {
    builder = builder.setIssuer('swiftagent');
  }

  if (options?.audience !== undefined) {
    builder = builder.setAudience(options.audience);
  } else {
    builder = builder.setAudience('swiftagent-gateway');
  }

  if (options?.exp !== undefined) {
    builder = builder.setExpirationTime(options.exp);
  } else {
    builder = builder.setExpirationTime(options?.expiresIn ?? '1h');
  }

  return builder.sign(secret);
}

function validClaims(): Record<string, unknown> {
  return {
    sessionId: 'ses_abc123',
    agentId: 'agt_xyz789',
    permissions: ['chat'],
  };
}

describe('validateClientToken', () => {
  it('returns claims for a valid token', async () => {
    const token = await signToken(validClaims());
    const result = await validateClientToken(token, JWT_SECRET);

    expect(result.sessionId).toBe('ses_abc123');
    expect(result.agentId).toBe('agt_xyz789');
    expect(result.permissions).toEqual(['chat']);
    expect(result.exp).toBeTypeOf('number');
    expect(result.iss).toBe('swiftagent');
    expect(result.aud).toBe('swiftagent-gateway');
  });

  it('throws TOKEN_EXPIRED for an expired token', async () => {
    // Create a token that expired 1 hour ago
    const pastExp = Math.floor(Date.now() / 1000) - 3600;
    const token = await signToken(validClaims(), { exp: pastExp });

    await expect(validateClientToken(token, JWT_SECRET)).rejects.toThrow(AuthError);

    try {
      await validateClientToken(token, JWT_SECRET);
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).code).toBe(AuthErrorCode.TOKEN_EXPIRED);
    }
  });

  it('throws TOKEN_INVALID for wrong signature', async () => {
    const token = await signToken(validClaims(), { secret: WRONG_SECRET });

    await expect(validateClientToken(token, JWT_SECRET)).rejects.toThrow(AuthError);

    try {
      await validateClientToken(token, JWT_SECRET);
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).code).toBe(AuthErrorCode.TOKEN_INVALID);
    }
  });

  it('throws TOKEN_MALFORMED for wrong issuer', async () => {
    const token = await signToken(validClaims(), { issuer: 'wrong-issuer' });

    try {
      await validateClientToken(token, JWT_SECRET);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).code).toBe(AuthErrorCode.TOKEN_MALFORMED);
    }
  });

  it('throws TOKEN_MALFORMED for wrong audience', async () => {
    const token = await signToken(validClaims(), { audience: 'wrong-audience' });

    try {
      await validateClientToken(token, JWT_SECRET);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).code).toBe(AuthErrorCode.TOKEN_MALFORMED);
    }
  });

  it('throws TOKEN_MALFORMED for completely garbled input', async () => {
    try {
      await validateClientToken('not-a-jwt-at-all', JWT_SECRET);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      // Garbled input may yield TOKEN_INVALID or TOKEN_MALFORMED depending on jose
      expect([AuthErrorCode.TOKEN_INVALID, AuthErrorCode.TOKEN_MALFORMED]).toContain(
        (err as AuthError).code,
      );
    }
  });

  it('throws TOKEN_MALFORMED when claims have wrong shape (missing sessionId)', async () => {
    const token = await signToken({
      agentId: 'agt_xyz',
      permissions: ['chat'],
      // sessionId is missing
    });

    try {
      await validateClientToken(token, JWT_SECRET);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).code).toBe(AuthErrorCode.TOKEN_MALFORMED);
    }
  });

  it('throws TOKEN_MALFORMED when sessionId has wrong prefix', async () => {
    const token = await signToken({
      sessionId: 'bad_prefix',
      agentId: 'agt_xyz',
      permissions: ['chat'],
    });

    try {
      await validateClientToken(token, JWT_SECRET);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).code).toBe(AuthErrorCode.TOKEN_MALFORMED);
    }
  });

  describe('AuthError', () => {
    it('has correct name and code properties', () => {
      const err = new AuthError(AuthErrorCode.TOKEN_EXPIRED, 'Token has expired');
      expect(err.name).toBe('AuthError');
      expect(err.code).toBe('TOKEN_EXPIRED');
      expect(err.message).toBe('Token has expired');
      expect(err).toBeInstanceOf(Error);
    });
  });
});
