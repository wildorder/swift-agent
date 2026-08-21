import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerCognitoAuth } from '../middleware/cognito-auth.js';
import { registerErrorHandler } from '../middleware/error-handler.js';

// ── Test fixtures ─────────────────────────────────────────────────

const AUDIENCE = 'test-client-id';
const SUB = 'cognito-sub-123';
const EMAIL = 'user@example.com';

let privateKey: CryptoKey;
let jwksServer: Server;
let issuerUrl: string;

async function mintToken(overrides: {
  iss?: string;
  aud?: string;
  sub?: string;
  email?: string;
  exp?: number;
  signingKey?: CryptoKey;
  /** Cognito token type. Defaults to `'id'` — the only accepted type. */
  token_use?: string | null;
  /** Set `false` to omit `email` — the shape of a real Cognito access token. */
  includeEmail?: boolean;
  /** Set `false` to omit `aud` — the shape of a real Cognito access token. */
  includeAud?: boolean;
  /** Set `false` to omit `sub`. */
  includeSub?: boolean;
} = {}): Promise<string> {
  const key = overrides.signingKey ?? privateKey;

  const claims: Record<string, unknown> = {};
  if (overrides.token_use !== null) {
    claims.token_use = overrides.token_use ?? 'id';
  }
  if (overrides.includeEmail !== false) {
    claims.email = overrides.email ?? EMAIL;
  }

  let builder = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setIssuer(overrides.iss ?? issuerUrl);

  if (overrides.includeAud !== false) {
    builder = builder.setAudience(overrides.aud ?? AUDIENCE);
  }
  if (overrides.includeSub !== false) {
    builder = builder.setSubject(overrides.sub ?? SUB);
  }

  if (overrides.exp !== undefined) {
    builder = builder.setExpirationTime(overrides.exp);
  } else {
    builder = builder.setExpirationTime('5m');
  }

  return builder.sign(key);
}

function buildTestApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerCognitoAuth(app, { issuerUrl, audience: AUDIENCE });

  app.get('/test', async (req) => {
    const mgmtReq = req as typeof req & { cognitoSub: string; email: string };
    return { sub: mgmtReq.cognitoSub, email: mgmtReq.email };
  });

  return app;
}

// ── Setup / Teardown ──────────────────────────────────────────────

beforeAll(async () => {
  const { privateKey: priv, publicKey: pub } = await generateKeyPair('RS256');
  privateKey = priv;

  const publicJwk = await exportJWK(pub);
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  publicJwk.kid = 'test-kid-1';

  const jwksBody = JSON.stringify({ keys: [publicJwk] });

  jwksServer = createServer((req, res) => {
    if (req.url === '/.well-known/jwks.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(jwksBody);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>((resolve) => {
    jwksServer.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = jwksServer.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to bind JWKS server');
  issuerUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    jwksServer.close((err) => (err ? reject(err) : resolve()));
  });
});

// ── Tests ─────────────────────────────────────────────────────────

describe('Cognito auth middleware', () => {
  it('decorates request with cognitoSub and email for a valid ID token', async () => {
    const app = buildTestApp();
    const token = await mintToken({ token_use: 'id' });

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sub).toBe(SUB);
    expect(body.email).toBe(EMAIL);
    await app.close();
  });

  it('rejects when Authorization header is missing', async () => {
    const app = buildTestApp();

    const res = await app.inject({
      method: 'GET',
      url: '/test',
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
    await app.close();
  });

  it('rejects a malformed Authorization header', async () => {
    const app = buildTestApp();

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { authorization: 'Basic abc123' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
    await app.close();
  });

  it('rejects a Cognito access token by token type, not incidentally', async () => {
    const app = buildTestApp();
    // A real Cognito access token: token_use "access", no `aud` (it uses
    // `client_id`), and no `email`. It must fail on the TYPE check — which only
    // works because `audience` is no longer enforced inside `jwtVerify`.
    const token = await mintToken({
      token_use: 'access',
      includeAud: false,
      includeEmail: false,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(401);
    const { error } = res.json();
    expect(error.code).toBe('UNAUTHORIZED');
    expect(error.message).toMatch(/token_use/i);
    expect(error.message).toMatch(/access/);
    // Proves it did NOT fall through to the audience/email checks.
    expect(error.message).not.toMatch(/audience/i);
    expect(error.message).not.toMatch(/email/i);
    await app.close();
  });

  it('rejects a token with no token_use claim', async () => {
    const app = buildTestApp();
    const token = await mintToken({ token_use: null });

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(401);
    const { error } = res.json();
    expect(error.code).toBe('UNAUTHORIZED');
    expect(error.message).toMatch(/no token_use claim/i);
    await app.close();
  });

  it('rejects token with wrong audience via the manual audience check', async () => {
    const app = buildTestApp();
    const token = await mintToken({ token_use: 'id', aud: 'wrong-audience' });

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(401);
    const { error } = res.json();
    expect(error.code).toBe('UNAUTHORIZED');
    expect(error.message).toBe('Invalid token audience');
    await app.close();
  });

  it('accepts an ID token whose aud is an array containing the client id', async () => {
    const app = buildTestApp();
    const token = await new SignJWT({ token_use: 'id', email: EMAIL })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt()
      .setIssuer(issuerUrl)
      .setAudience(['other-client', AUDIENCE])
      .setSubject(SUB)
      .setExpirationTime('5m')
      .sign(privateKey);

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().sub).toBe(SUB);
    await app.close();
  });

  it('rejects token with wrong issuer', async () => {
    const app = buildTestApp();
    const token = await mintToken({ token_use: 'id', iss: 'https://wrong-issuer.example.com' });

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
    await app.close();
  });

  it('rejects an expired token', async () => {
    const app = buildTestApp();
    // Set exp to 1 hour in the past
    const token = await mintToken({
      token_use: 'id',
      exp: Math.floor(Date.now() / 1000) - 3600,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(401);
    const { error } = res.json();
    expect(error.code).toBe('UNAUTHORIZED');
    expect(error.message).toBe('Invalid or expired token');
    await app.close();
  });

  it('rejects a token signed with a different key', async () => {
    const app = buildTestApp();
    const { privateKey: otherKey } = await generateKeyPair('RS256');
    const token = await mintToken({ token_use: 'id', signingKey: otherKey });

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
    await app.close();
  });

  it('rejects a malformed JWT string', async () => {
    const app = buildTestApp();

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { authorization: 'Bearer not.a.valid.jwt' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
    await app.close();
  });

  it('rejects a well-typed ID token missing the email claim', async () => {
    const app = buildTestApp();
    const token = await mintToken({ token_use: 'id', includeEmail: false });

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(401);
    const { error } = res.json();
    expect(error.code).toBe('UNAUTHORIZED');
    expect(error.message).toBe('Token missing email claim');
    await app.close();
  });

  it('rejects a well-typed ID token missing the sub claim', async () => {
    const app = buildTestApp();
    const token = await mintToken({ token_use: 'id', includeSub: false });

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(401);
    const { error } = res.json();
    expect(error.code).toBe('UNAUTHORIZED');
    expect(error.message).toBe('Token missing sub claim');
    await app.close();
  });

  it('distinguishes every auth failure by message while keeping 401/UNAUTHORIZED', async () => {
    const app = buildTestApp();

    // NOTE: the `Missing bearer token` branch is not exercised here — the HTTP
    // layer trims trailing whitespace from header values, so `Bearer ` arrives
    // as `Bearer` and is caught by the header guard instead. That branch remains
    // as defence-in-depth for non-HTTP callers of the hook.
    const cases: { name: string; headers: Record<string, string> }[] = [
      // "missing" and "malformed" header are deliberately ONE taxonomy case —
      // both mean "no usable Bearer credential was presented".
      { name: 'missing or invalid header', headers: {} },
      { name: 'wrong token type', headers: { authorization: `Bearer ${await mintToken({ token_use: 'access', includeAud: false, includeEmail: false })}` } },
      { name: 'missing token_use', headers: { authorization: `Bearer ${await mintToken({ token_use: null })}` } },
      { name: 'wrong audience', headers: { authorization: `Bearer ${await mintToken({ aud: 'nope' })}` } },
      { name: 'missing sub', headers: { authorization: `Bearer ${await mintToken({ includeSub: false })}` } },
      { name: 'missing email', headers: { authorization: `Bearer ${await mintToken({ includeEmail: false })}` } },
      { name: 'invalid or expired', headers: { authorization: 'Bearer not.a.valid.jwt' } },
    ];

    const messages: string[] = [];
    for (const { headers } of cases) {
      const res = await app.inject({ method: 'GET', url: '/test', headers });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
      messages.push(res.json().error.message);
    }

    expect(new Set(messages).size).toBe(cases.length);
    await app.close();
  });
});
