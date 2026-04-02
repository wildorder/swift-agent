import { describe, it, expect } from 'vitest';
import { createTokenService } from '../services/token-service.js';

const secret = 'test-secret-that-is-at-least-32-bytes-long';

describe('TokenService', () => {
  const tokenService = createTokenService({ secret, defaultTtlSeconds: 60 });

  it('signs and verifies a client token', async () => {
    const token = await tokenService.signClientToken({
      sessionId: 'ses_abc123',
      agentId: 'agt_xyz789',
      permissions: ['chat'],
    });

    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3); // JWT format

    const claims = await tokenService.verifyClientToken(token);
    expect(claims.sessionId).toBe('ses_abc123');
    expect(claims.agentId).toBe('agt_xyz789');
    expect(claims.permissions).toEqual(['chat']);
    expect(typeof claims.exp).toBe('number');
    expect(claims.iss).toBe('swiftagent');
  });

  it('rejects an expired token', async () => {
    const expiredService = createTokenService({ secret, defaultTtlSeconds: -1 });
    const token = await expiredService.signClientToken({
      sessionId: 'ses_abc123',
      agentId: 'agt_xyz789',
      permissions: ['chat'],
    });

    await expect(tokenService.verifyClientToken(token)).rejects.toThrow();
  });

  it('rejects a token signed with a different secret', async () => {
    const otherService = createTokenService({
      secret: 'different-secret-that-is-at-least-32-bytes',
    });
    const token = await otherService.signClientToken({
      sessionId: 'ses_abc123',
      agentId: 'agt_xyz789',
      permissions: ['chat'],
    });

    await expect(tokenService.verifyClientToken(token)).rejects.toThrow();
  });

  it('payload contains expected fields', async () => {
    const token = await tokenService.signClientToken({
      sessionId: 'ses_test1',
      agentId: 'agt_test2',
      permissions: ['chat', 'admin'],
    });

    const claims = await tokenService.verifyClientToken(token);
    expect(claims).toMatchObject({
      sessionId: 'ses_test1',
      agentId: 'agt_test2',
      permissions: ['chat', 'admin'],
    });
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});
