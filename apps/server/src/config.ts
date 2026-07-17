import { loadConfig as sharedLoadConfig, ENV_KEYS, type AppConfig } from '@swiftagent/shared';

/**
 * Extended server config with AUTO_MIGRATE flag.
 * Delegates to @swiftagent/shared loadConfig for core env vars,
 * then adds server-specific fields.
 */
export interface ServerConfig extends AppConfig {
  AUTO_MIGRATE: boolean;
}

/**
 * Load and validate all required environment variables at startup.
 * Fails fast with clear error messages listing ALL missing required vars.
 */
export function loadServerConfig(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): ServerConfig {
  // Collect all missing required vars before throwing
  const missing: string[] = [];

  const required = [ENV_KEYS.DATABASE_URL, ENV_KEYS.CLIENT_JWT_SECRET] as const;
  for (const key of required) {
    if (!env[key]) {
      missing.push(key);
    }
  }

  // At least one model provider key is required
  const modelKeys = [
    ENV_KEYS.OPENAI_API_KEY,
    ENV_KEYS.ANTHROPIC_API_KEY,
    ENV_KEYS.GOOGLE_API_KEY,
  ] as const;
  const hasModelKey = modelKeys.some((k) => !!env[k]);
  if (!hasModelKey) {
    missing.push(`At least one of: ${modelKeys.join(', ')}`);
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n${missing.map((m) => `  - ${m}`).join('\n')}`,
    );
  }

  // Parse via shared loadConfig (validates with Zod)
  // REDIS_URL is optional for MVP — provide a placeholder if absent so Zod doesn't reject it
  const envWithDefaults: Record<string, string | undefined> = { ...env };

  // REDIS_URL is marked required in shared config but optional for MVP per spec
  // If not provided, set a sentinel so loadConfig passes, then we handle it below
  const redisProvided = !!env[ENV_KEYS.REDIS_URL];
  if (!redisProvided) {
    envWithDefaults[ENV_KEYS.REDIS_URL] = 'redis://localhost:6379';
  }

  const config = sharedLoadConfig(envWithDefaults);

  const autoMigrate = env['AUTO_MIGRATE'] === 'true';

  return {
    ...config,
    // Clear REDIS_URL if it wasn't actually provided
    [ENV_KEYS.REDIS_URL]: redisProvided ? config[ENV_KEYS.REDIS_URL] : undefined as unknown as string,
    AUTO_MIGRATE: autoMigrate,
  };
}

/**
 * Build a redacted config summary for the startup banner.
 * Secrets are replaced with '***'.
 */
export function redactConfig(config: ServerConfig): Record<string, string> {
  const redact = (val: string | undefined): string =>
    val ? '***' : '(not set)';

  return {
    DATABASE_URL: config[ENV_KEYS.DATABASE_URL] ? '***' : '(not set)',
    REDIS_URL: config[ENV_KEYS.REDIS_URL] ? '***' : '(disabled)',
    CLIENT_JWT_SECRET: redact(config[ENV_KEYS.CLIENT_JWT_SECRET]),
    OPENAI_API_KEY: redact(config[ENV_KEYS.OPENAI_API_KEY]),
    ANTHROPIC_API_KEY: redact(config[ENV_KEYS.ANTHROPIC_API_KEY]),
    GOOGLE_API_KEY: redact(config[ENV_KEYS.GOOGLE_API_KEY]),
    PUBLIC_WEBSOCKET_URL: config[ENV_KEYS.PUBLIC_WEBSOCKET_URL] ?? '(not set)',
    API_PORT: String(config[ENV_KEYS.API_PORT]),
    // GATEWAY_PORT is retained in ENV_KEYS for the standalone gateway (local
    // dev / tests), but the unified server (WS-30) binds only API_PORT — it is
    // not a second listening port, so the banner marks it local-only.
    GATEWAY_PORT: '(local-only)',
    AUTO_MIGRATE: String(config.AUTO_MIGRATE),
  };
}
