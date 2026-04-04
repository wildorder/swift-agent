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
} = {}): Promise<string> {
  const key = overrides.signingKey ?? privateKey;
  let builder = new SignJWT({
    email: overrides.email ?? EMAIL,
  })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setIssuer(overrides.iss ?? issuerUrl)
    .setAudience(overrides.aud ?? AUDIENCE)
    .setSubject(overrides.sub ?? SUB);

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
  it('decorates request with cognitoSub and email for a valid token', async () => {
    const app = buildTestApp();
    const token = await mintToken();

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

  it('rejects token with wrong audience', async () => {
    const app = buildTestApp();
    const token = await mintToken({ aud: 'wrong-audience' });

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
    await app.close();
  });

  it('rejects token with wrong issuer', async () => {
    const app = buildTestApp();
    const token = await mintToken({ iss: 'https://wrong-issuer.example.com' });

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
    const token = await mintToken({ exp: Math.floor(Date.now() / 1000) - 3600 });

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
    await app.close();
  });

  it('rejects a token signed with a different key', async () => {
    const app = buildTestApp();
    const { privateKey: otherKey } = await generateKeyPair('RS256');
    const token = await mintToken({ signingKey: otherKey });

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

  it('rejects token missing email claim', async () => {
    const app = buildTestApp();

    // Mint a token without the email claim
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt()
      .setIssuer(issuerUrl)
      .setAudience(AUDIENCE)
      .setSubject(SUB)
      .setExpirationTime('5m')
      .sign(privateKey);

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
    await app.close();
  });
});
