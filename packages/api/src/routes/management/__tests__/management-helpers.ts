import {
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  SignJWT,
  type JWTVerifyGetKey,
} from 'jose';
import type { ApiKeyRepo } from '@swiftagent/db';
import type { ApiKeyRecord } from '@swiftagent/shared';

/**
 * Shared fixtures for the management route suites.
 *
 * Two things live here so `management.test.ts` (mocked auth, handler-level
 * coverage) and `management-protection.test.ts` (real Cognito middleware driven
 * through `buildApp`) share one source:
 *
 * 1. `createManagementMockApiKeyRepo` — a key-*storing* `ApiKeyRepo` mock. The
 *    generic `createMockApiKeyRepo` in `src/__tests__/helpers.ts` always returns
 *    the same seeded key, which cannot express "created key is listed, then
 *    revoked"; the management key routes need real storage.
 * 2. The local-JWKS keypair + `mintToken`, so the protection suite can mint
 *    tokens the real `registerCognitoAuth` hook actually verifies.
 */

/** Management-specific mock that actually stores created keys. */
export function createManagementMockApiKeyRepo(): ApiKeyRepo {
  const keys = new Map<string, ApiKeyRecord>();

  return {
    create: async (record) => {
      const key: ApiKeyRecord = {
        apiKeyId: record.apiKeyId,
        workspaceId: record.workspaceId,
        keyHash: record.keyHash,
        name: record.name,
        createdAt: new Date(),
        revokedAt: null,
      };
      keys.set(record.apiKeyId, key);
      return key;
    },
    getByKeyHash: async () => null,
    listByWorkspace: async (workspaceId) =>
      [...keys.values()].filter((k) => k.workspaceId === workspaceId),
    revoke: async (apiKeyId) => {
      const key = keys.get(apiKeyId);
      if (!key) return null;
      const revoked = { ...key, revokedAt: new Date() };
      keys.set(apiKeyId, revoked);
      return revoked;
    },
  };
}

// ── Local JWKS harness ────────────────────────────────────────────
//
// `createLocalJWKSet` resolves the signing key in-process, so the protection
// suite exercises the REAL middleware with no JWKS HTTP server to stand up
// (unlike the remote-JWKS harness in `src/__tests__/cognito-auth.test.ts`).

const KID = 'test-kid-1';

const { privateKey, publicKey } = await generateKeyPair('RS256');

const jwk = await exportJWK(publicKey);
jwk.alg = 'RS256';
jwk.use = 'sig';
jwk.kid = KID;

/** Pass as `buildApp({ cognitoGetKey })` / `managementPlugin({ getKey })`. */
export const getKey: JWTVerifyGetKey = createLocalJWKSet({ keys: [jwk] });

/** Shape-accurate Cognito user-pool issuer; must match `cognitoIssuerUrl`. */
export const ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TESTPOOL';
/** The Cognito app client id; must match `cognitoClientId`. */
export const AUDIENCE = 'test-client-id';

export interface MintTokenOptions {
  /**
   * Cognito token type. Defaults to `'id'` — the only accepted type. Pass
   * `null` to omit the claim entirely (the missing-`token_use` reject case).
   */
  token_use?: string | null;
  sub?: string;
  email?: string;
  aud?: string;
  iss?: string;
  /** Seconds since epoch, or a `jose` duration string. Defaults to `'5m'`. */
  exp?: number | string;
  /** Set `false` to omit `email` — the shape of a real Cognito access token. */
  includeEmail?: boolean;
  /** Set `false` to omit `aud` — the shape of a real Cognito access token. */
  includeAud?: boolean;
}

/**
 * Mint a token signed by the local keypair above.
 *
 * A real Cognito ACCESS token carries no `aud` (it uses `client_id`) and no
 * `email`, so the access-token case must mint with
 * `{ token_use: 'access', includeAud: false, includeEmail: false }` to be
 * realistic — the middleware asserts `token_use` BEFORE audience, so it is
 * still rejected on token type rather than incidentally on audience/email.
 */
export async function mintToken(o: MintTokenOptions = {}): Promise<string> {
  const claims: Record<string, unknown> = {};
  if (o.token_use !== null) claims.token_use = o.token_use ?? 'id';
  if (o.includeEmail !== false) claims.email = o.email ?? 'user@example.com';

  let jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuedAt()
    .setIssuer(o.iss ?? ISSUER)
    .setSubject(o.sub ?? 'cognito-sub-123')
    .setExpirationTime(o.exp ?? '5m');

  if (o.includeAud !== false) jwt = jwt.setAudience(o.aud ?? AUDIENCE);

  return jwt.sign(privateKey);
}
