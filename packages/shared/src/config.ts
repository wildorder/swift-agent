import { z } from 'zod';

/**
 * Single source of truth for all environment variable names used across the system.
 */
export const ENV_KEYS = {
  DATABASE_URL: 'DATABASE_URL',
  REDIS_URL: 'REDIS_URL',
  CLIENT_JWT_SECRET: 'CLIENT_JWT_SECRET',
  OPENAI_API_KEY: 'OPENAI_API_KEY',
  ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY',
  GOOGLE_API_KEY: 'GOOGLE_API_KEY',
  PUBLIC_WEBSOCKET_URL: 'PUBLIC_WEBSOCKET_URL',
  TOOL_RUNNER_PUBLIC_URL: 'TOOL_RUNNER_PUBLIC_URL',
  // ── Scoped runner credentials (WS-22) ──────────────────────────────────────
  // Asymmetric signing keypair for short-lived, per-call runner tokens. The
  // hosted runtime holds the PRIVATE key and mints; each customer SDK runner is
  // provisioned only the PUBLIC key so the private key never reaches customer
  // infra. PEM (PKCS8/SPKI) or JWK JSON.
  RUNNER_TOKEN_PRIVATE_KEY: 'RUNNER_TOKEN_PRIVATE_KEY',
  RUNNER_TOKEN_PUBLIC_KEY: 'RUNNER_TOKEN_PUBLIC_KEY',
  // The runner's audience — its stable public base URL. Defaults to
  // TOOL_RUNNER_PUBLIC_URL when unset. Bound into `aud`; blocks cross-runner replay.
  RUNNER_AUDIENCE: 'RUNNER_AUDIENCE',
  // The runner's owning workspace ws_ id (provisioned SDK-side). Blocks the
  // confused-deputy attack where a foreign runner URL is registered.
  RUNNER_WORKSPACE_ID: 'RUNNER_WORKSPACE_ID',
  // Require https for outbound runner targets (SSRF policy). Default true in prod.
  RUNNER_REQUIRE_HTTPS: 'RUNNER_REQUIRE_HTTPS',
  API_PORT: 'API_PORT',
  GATEWAY_PORT: 'GATEWAY_PORT',
  COGNITO_USER_POOL_ID: 'COGNITO_USER_POOL_ID',
  COGNITO_ISSUER_URL: 'COGNITO_ISSUER_URL',
  COGNITO_CLIENT_ID: 'COGNITO_CLIENT_ID',
} as const;

/**
 * Zod schema for environment configuration.
 * Required: DATABASE_URL, REDIS_URL, CLIENT_JWT_SECRET
 * Optional: model provider keys, URLs, ports (have defaults or are deployment-specific)
 */
const ConfigSchema = z.object({
  [ENV_KEYS.DATABASE_URL]: z.string().min(1, 'DATABASE_URL is required'),
  [ENV_KEYS.REDIS_URL]: z.string().min(1, 'REDIS_URL is required'),
  [ENV_KEYS.CLIENT_JWT_SECRET]: z.string().min(1, 'CLIENT_JWT_SECRET is required'),
  [ENV_KEYS.OPENAI_API_KEY]: z.string().optional(),
  [ENV_KEYS.ANTHROPIC_API_KEY]: z.string().optional(),
  [ENV_KEYS.GOOGLE_API_KEY]: z.string().optional(),
  [ENV_KEYS.PUBLIC_WEBSOCKET_URL]: z.string().url().optional(),
  [ENV_KEYS.TOOL_RUNNER_PUBLIC_URL]: z.string().url().optional(),
  [ENV_KEYS.RUNNER_TOKEN_PRIVATE_KEY]: z.string().optional(),
  [ENV_KEYS.RUNNER_TOKEN_PUBLIC_KEY]: z.string().optional(),
  [ENV_KEYS.RUNNER_AUDIENCE]: z.string().optional(),
  [ENV_KEYS.RUNNER_WORKSPACE_ID]: z.string().optional(),
  // Optional: undefined means "unset" (the runtime defaults it to true in prod);
  // an explicit 'false' opts out (dev/test).
  [ENV_KEYS.RUNNER_REQUIRE_HTTPS]: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  [ENV_KEYS.API_PORT]: z.coerce.number().int().positive().default(3000),
  [ENV_KEYS.GATEWAY_PORT]: z.coerce.number().int().positive().default(3001),
  [ENV_KEYS.COGNITO_USER_POOL_ID]: z.string().optional(),
  [ENV_KEYS.COGNITO_ISSUER_URL]: z.string().url().optional(),
  [ENV_KEYS.COGNITO_CLIENT_ID]: z.string().optional(),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

/**
 * Validates required environment variables at startup using Zod.
 * Throws a ZodError if required vars are missing or invalid.
 */
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  return ConfigSchema.parse(env);
}
