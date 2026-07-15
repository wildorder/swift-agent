import { jwtVerify, type CryptoKey, type KeyObject } from 'jose';
import { SwiftAgentError, SwiftAgentErrorCode } from '@swiftagent/shared';

/**
 * Public-key verification of scoped runner tokens (WS-22, SC-08).
 *
 * This module deliberately imports ONLY the verification path: a customer SDK
 * runner is provisioned the public key and never the private signing key, so it
 * can verify tokens the hosted runtime minted but can never forge one.
 */

/** A public key usable by `jose` to verify an asymmetric signature. */
export type RunnerVerifyKey = CryptoKey | KeyObject;

/** Accepted signing algorithm — must match the runtime minter (EdDSA / Ed25519). */
const ACCEPTED_ALGS = ['EdDSA'] as const;

export interface RunnerTokenClaims {
  aud: string;
  workspaceId: string;
  agentId: string;
  runId: string;
  callId: string;
  idempotencyKey: string;
  toolName: string;
  exp: number;
}

/**
 * The runner's own provisioned identity. Verification REQUIRES the token's `aud`
 * to equal `audience` (blocks cross-runner replay) AND its `workspaceId` claim to
 * equal `workspaceId` (blocks the confused-deputy: a token minted for another
 * workspace that merely targets this runner's URL).
 */
export interface ExpectedRunnerIdentity {
  audience: string;
  workspaceId: string;
}

function unauthorized(detail: string): SwiftAgentError {
  return new SwiftAgentError(SwiftAgentErrorCode.UNAUTHORIZED, detail);
}

/**
 * Verify signature, expiry, audience, and workspace binding, returning the
 * scoped claims. Throws `SwiftAgentError(UNAUTHORIZED)` on any failure —
 * expiry, bad/foreign/symmetric signature, audience mismatch, workspace
 * mismatch, or a malformed claim set.
 */
export async function verifyRunnerToken(
  publicKey: RunnerVerifyKey,
  token: string,
  expected: ExpectedRunnerIdentity,
): Promise<RunnerTokenClaims> {
  let payload: Record<string, unknown>;
  try {
    const result = await jwtVerify(token, publicKey, {
      algorithms: [...ACCEPTED_ALGS],
      audience: expected.audience, // enforces claims.aud === expected.audience
    });
    payload = result.payload as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw unauthorized(`Runner token verification failed: ${message}`);
  }

  if (payload.workspaceId !== expected.workspaceId) {
    throw unauthorized('Runner token workspace mismatch');
  }

  const claims: RunnerTokenClaims = {
    aud: expected.audience,
    workspaceId: str(payload.workspaceId),
    agentId: str(payload.agentId),
    runId: str(payload.runId),
    callId: str(payload.callId),
    idempotencyKey: str(payload.idempotencyKey),
    toolName: str(payload.toolName),
    exp: typeof payload.exp === 'number' ? payload.exp : 0,
  };

  if (
    !claims.workspaceId ||
    !claims.agentId ||
    !claims.runId ||
    !claims.callId ||
    !claims.idempotencyKey ||
    !claims.toolName
  ) {
    throw unauthorized('Runner token missing required scope claims');
  }

  return claims;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
