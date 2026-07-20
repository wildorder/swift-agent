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
