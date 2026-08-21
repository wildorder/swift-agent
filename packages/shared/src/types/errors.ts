/**
 * Error reference (code → meaning → remediation).
 *
 * Terse in-code companion to the SDK/runtime error surface (WS-41). The fuller
 * prose table lives in the README (WS-40); this exists so the contract is
 * discoverable at the type. Every error the SDK client, tool runner, and React
 * client raise carries one of these codes on a {@link SwiftAgentError}.
 *
 * - `VALIDATION`      — bad input/config (missing apiKey/env key, malformed
 *                       agent/tool config, 400 from the server). Fix the named
 *                       field/key and retry; not retryable as-is.
 * - `NOT_FOUND`       — the session/agent/run id does not exist (404). Verify the id.
 * - `CONFLICT`        — resource already exists or is in a conflicting state (409).
 * - `RATE_LIMIT`      — too many requests (429). Back off and retry.
 * - `PROVIDER_ERROR`  — a model provider / upstream dependency failed (502). Retry.
 * - `UNAUTHORIZED`    — authentication failed (401). Check the workspace API key /
 *                       client token.
 * - `FORBIDDEN`       — authenticated but not permitted (403). Check the key's scope.
 * - `INTERNAL`        — unexpected server error (500). Retry; if persistent, contact support.
 * - `TIMEOUT`         — the request/tool exceeded its deadline (504). Retry.
 * - `CONNECTION_ERROR`— could not reach the server / upstream unavailable (503).
 *                       Check the base URL / that the server is running; retry.
 * - `INCOMPATIBLE_VERSION` — SDK/server protocol versions disagree (409, WS-37).
 *                       Upgrade the older side.
 */
export const SwiftAgentErrorCode = {
  VALIDATION: 'VALIDATION',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMIT: 'RATE_LIMIT',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  INTERNAL: 'INTERNAL',
  TIMEOUT: 'TIMEOUT',
  CONNECTION_ERROR: 'CONNECTION_ERROR',
  INCOMPATIBLE_VERSION: 'INCOMPATIBLE_VERSION',
} as const;

export type SwiftAgentErrorCode = typeof SwiftAgentErrorCode[keyof typeof SwiftAgentErrorCode];

const CODE_TO_STATUS: Record<SwiftAgentErrorCode, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMIT: 429,
  PROVIDER_ERROR: 502,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  INTERNAL: 500,
  TIMEOUT: 504,
  CONNECTION_ERROR: 503,
  INCOMPATIBLE_VERSION: 409,
};

export class SwiftAgentError extends Error {
  readonly code: SwiftAgentErrorCode;
  readonly statusCode: number;
  override readonly cause?: unknown;

  constructor(
    code: SwiftAgentErrorCode,
    message: string,
    options?: { cause?: unknown; statusCode?: number },
  ) {
    super(message);
    this.name = 'SwiftAgentError';
    this.code = code;
    this.statusCode = options?.statusCode ?? CODE_TO_STATUS[code];
    this.cause = options?.cause;
  }

  toJSON(): { code: SwiftAgentErrorCode; message: string; statusCode: number } {
    return {
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
    };
  }
}

export function isSwiftAgentError(value: unknown): value is SwiftAgentError {
  return value instanceof SwiftAgentError;
}
