import { loadConfig as sharedLoadConfig, ENV_KEYS, type AppConfig } from '@swiftagent/shared';

/**
 * Extended server config with AUTO_MIGRATE flag.
 * Delegates to @swiftagent/shared loadConfig for core env vars,
 * then adds server-specific fields.
 */
export interface ServerConfig extends AppConfig {
  AUTO_MIGRATE: boolean;
}

/** Hosts that are never a valid public endpoint in a cloud environment. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/**
 * Deploy environments that are "cloud" — the exact values used as the Terraform
 * `environment` and injected as the `DEPLOY_ENV` container env (see WS-32).
 */
const CLOUD_ENVS = new Set(['dev', 'staging', 'prod']);

/**
 * Cloud-only validation for PUBLIC_WEBSOCKET_URL (SC-04).
 *
 * When `DEPLOY_ENV` marks a cloud environment, the URL MUST be present, use the
 * `wss:` scheme, and NOT point at localhost — otherwise clients would be handed
 * an unreachable/wrong-scheme WebSocket URL. In local dev (`DEPLOY_ENV` absent
 * or not a cloud env) the check is skipped entirely, so local boot needs no
 * ceremony and a `ws://localhost:3001` value is allowed.
 *
 * INSECURE OPT-OUT (`PUBLIC_WS_ALLOW_INSECURE=true`): a domainless environment
 * (e.g. dev, whose ALB has no ACM cert and thus no TLS listener) cannot serve a
 * real `wss://` endpoint on its raw `*.elb.amazonaws.com` name. Setting this
 * boot-time flag permits a non-localhost `ws://` URL so the realtime path is
 * reachable over plain HTTP (port 80). It is deliberately NOT set for
 * staging/prod, which keep the strict `wss://`-only policy. The localhost ban
 * still applies either way.
 *
 * `DEPLOY_ENV` / `PUBLIC_WS_ALLOW_INSECURE` are read directly from `env`
 * (mirroring AUTO_MIGRATE) rather than added to ENV_KEYS/ConfigSchema — they are
 * boot-time deployment markers, not app config the schema needs to type.
 *
 * @returns an error message when the URL violates cloud policy, else `null`.
 */
export function validatePublicWebsocketUrl(
  env: Record<string, string | undefined>,
): string | null {
  const deployEnv = env['DEPLOY_ENV'];
  if (!deployEnv || !CLOUD_ENVS.has(deployEnv)) return null; // local dev: no constraint

  const raw = env[ENV_KEYS.PUBLIC_WEBSOCKET_URL];
  if (!raw) {
    return `${ENV_KEYS.PUBLIC_WEBSOCKET_URL} is required in a cloud environment (DEPLOY_ENV=${deployEnv})`;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `${ENV_KEYS.PUBLIC_WEBSOCKET_URL} is not a valid URL (got '${raw}')`;
  }

  const allowInsecure = env['PUBLIC_WS_ALLOW_INSECURE'] === 'true';
  const okProtocol = url.protocol === 'wss:' || (allowInsecure && url.protocol === 'ws:');
  if (!okProtocol) {
    const schemes = allowInsecure ? 'wss:// or ws://' : 'wss://';
    return `${ENV_KEYS.PUBLIC_WEBSOCKET_URL} must use the ${schemes} scheme in a cloud environment (got '${raw}')`;
  }
  if (LOCAL_HOSTS.has(url.hostname)) {
    return `${ENV_KEYS.PUBLIC_WEBSOCKET_URL} must not point at localhost in a cloud environment (got '${raw}')`;
  }

  return null;
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

  // Cloud-only: PUBLIC_WEBSOCKET_URL must be a real wss:// endpoint (SC-04).
  // Folded into the same fail-fast aggregation so a bad URL is reported
  // alongside any other missing var in one message.
  const websocketUrlError = validatePublicWebsocketUrl(env);
  if (websocketUrlError) {
    missing.push(websocketUrlError);
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
