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
