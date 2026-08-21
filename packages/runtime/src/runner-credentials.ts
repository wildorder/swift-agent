import { SignJWT, importPKCS8, importJWK, type CryptoKey, type KeyObject } from 'jose';

/**
 * Short-lived, asymmetrically-signed runner credentials (WS-22, SC-08).
 *
 * The hosted runtime holds the PRIVATE signing key and mints a fresh token per
 * tool invocation, scoped to a single run/agent/tool with a short expiry. Each
 * customer SDK runner is provisioned only the PUBLIC verification key (see the
 * SDK's `verifyRunnerToken`), so the private key never reaches customer infra —
 * closing the shared-secret forgery hole where any secret-holder could mint
 * tokens for arbitrary workspaces.
 */

/** A private/public key usable by `jose` for asymmetric sign/verify. */
export type RunnerSigningKey = CryptoKey | KeyObject;

/** Signing algorithm for runner tokens. EdDSA (Ed25519) — compact, no key-size choice. */
export const RUNNER_TOKEN_ALG = 'EdDSA' as const;

/** Default token lifetime — deliberately short (SC-08). */
export const DEFAULT_RUNNER_TOKEN_TTL_SECONDS = 60;
/** Hard ceiling; the spec caps runner-token TTL at 120s. */
export const MAX_RUNNER_TOKEN_TTL_SECONDS = 120;

export interface RunnerTokenClaims {
  /** Runner AUDIENCE — the target runner's stable public URL / provisioned id. */
  aud: string;
  workspaceId: string;
  agentId: string;
  runId: string;
  callId: string; // tc_ id (also the idempotency key)
  idempotencyKey: string;
  toolName: string;
  /** Seconds since epoch. */
  exp: number;
}

/**
 * Mint a scoped runner token. `exp` is derived from `ttlSeconds` (clamped to
 * {@link MAX_RUNNER_TOKEN_TTL_SECONDS}); all other claims are caller-supplied so
 * the signed scope cannot drift from the request the resolver builds.
 */
export async function mintRunnerToken(
  privateKey: RunnerSigningKey,
  claims: Omit<RunnerTokenClaims, 'exp'>,
  ttlSeconds: number = DEFAULT_RUNNER_TOKEN_TTL_SECONDS,
): Promise<string> {
  const ttl = Math.min(Math.max(1, Math.floor(ttlSeconds)), MAX_RUNNER_TOKEN_TTL_SECONDS);

  return new SignJWT({
    workspaceId: claims.workspaceId,
    agentId: claims.agentId,
    runId: claims.runId,
    callId: claims.callId,
    idempotencyKey: claims.idempotencyKey,
    toolName: claims.toolName,
  })
    .setProtectedHeader({ alg: RUNNER_TOKEN_ALG })
    .setAudience(claims.aud)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(privateKey);
}

/**
 * Import the runtime's private signing key from PEM (PKCS8) or JWK JSON. Kept
 * here so the server wiring never imports `jose` (or the private key path)
 * directly.
 */
export async function importRunnerPrivateKey(material: string): Promise<RunnerSigningKey> {
  const trimmed = material.trim();
  if (trimmed.startsWith('{')) {
    return (await importJWK(JSON.parse(trimmed), RUNNER_TOKEN_ALG)) as RunnerSigningKey;
  }
  return (await importPKCS8(trimmed, RUNNER_TOKEN_ALG)) as RunnerSigningKey;
}
