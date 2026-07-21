import { describe, it, expect } from 'vitest';
import { loadServerConfig, redactConfig, validatePublicWebsocketUrl } from '../config.js';

describe('loadServerConfig', () => {
  const validEnv: Record<string, string> = {
    DATABASE_URL: 'postgres://localhost:5432/test',
    CLIENT_JWT_SECRET: 'test-secret-key',
    OPENAI_API_KEY: 'sk-test-key',
    API_PORT: '4000',
    GATEWAY_PORT: '4001',
  };

  it('loads valid config successfully', () => {
    const config = loadServerConfig(validEnv);
    expect(config.DATABASE_URL).toBe('postgres://localhost:5432/test');
    expect(config.CLIENT_JWT_SECRET).toBe('test-secret-key');
    expect(config.OPENAI_API_KEY).toBe('sk-test-key');
    expect(config.API_PORT).toBe(4000);
    expect(config.GATEWAY_PORT).toBe(4001);
    expect(config.AUTO_MIGRATE).toBe(false);
  });

  it('parses AUTO_MIGRATE=true', () => {
    const config = loadServerConfig({ ...validEnv, AUTO_MIGRATE: 'true' });
    expect(config.AUTO_MIGRATE).toBe(true);
  });

  it('defaults AUTO_MIGRATE to false', () => {
    const config = loadServerConfig(validEnv);
    expect(config.AUTO_MIGRATE).toBe(false);
  });

  it('fails fast listing ALL missing required vars', () => {
    expect(() => loadServerConfig({})).toThrow(/Missing required environment variables/);
    try {
      loadServerConfig({});
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('DATABASE_URL');
      expect(msg).toContain('CLIENT_JWT_SECRET');
      expect(msg).toContain('At least one of');
    }
  });

  it('requires at least one model provider key', () => {
    const envNoModel: Record<string, string> = {
      DATABASE_URL: 'postgres://localhost:5432/test',
      CLIENT_JWT_SECRET: 'test-secret-key',
    };
    expect(() => loadServerConfig(envNoModel)).toThrow(/At least one of/);
  });

  it('accepts Anthropic key as the only model provider', () => {
    const env: Record<string, string> = {
      DATABASE_URL: 'postgres://localhost:5432/test',
      CLIENT_JWT_SECRET: 'test-secret-key',
      ANTHROPIC_API_KEY: 'sk-ant-test',
    };
    const config = loadServerConfig(env);
    expect(config.ANTHROPIC_API_KEY).toBe('sk-ant-test');
  });

  it('uses default ports when not specified', () => {
    const env: Record<string, string> = {
      DATABASE_URL: 'postgres://localhost:5432/test',
      CLIENT_JWT_SECRET: 'test-secret-key',
      GOOGLE_API_KEY: 'gk-test',
    };
    const config = loadServerConfig(env);
    expect(config.API_PORT).toBe(3000);
    expect(config.GATEWAY_PORT).toBe(3001);
  });

  it('treats REDIS_URL as optional', () => {
    const config = loadServerConfig(validEnv);
    // REDIS_URL not provided so should be falsy
    expect(config.REDIS_URL).toBeFalsy();
  });
});

describe('validatePublicWebsocketUrl (cloud startup guard, SC-04)', () => {
  const VALID = 'wss://api.swiftagent.dev/v1/stream';

  it('cloud env + missing URL → non-null message mentioning required', () => {
    const msg = validatePublicWebsocketUrl({ DEPLOY_ENV: 'prod' });
    expect(msg).not.toBeNull();
    expect(msg).toContain('PUBLIC_WEBSOCKET_URL');
    expect(msg).toContain('required');
  });

  it('cloud env + ws://localhost:3001 → rejected for scheme', () => {
    const msg = validatePublicWebsocketUrl({
      DEPLOY_ENV: 'prod',
      PUBLIC_WEBSOCKET_URL: 'ws://localhost:3001',
    });
    expect(msg).not.toBeNull();
    expect(msg).toContain('wss://');
  });

  it('cloud env + wss://localhost/v1/stream → rejected for localhost host', () => {
    const msg = validatePublicWebsocketUrl({
      DEPLOY_ENV: 'staging',
      PUBLIC_WEBSOCKET_URL: 'wss://localhost/v1/stream',
    });
    expect(msg).not.toBeNull();
    expect(msg).toContain('localhost');
  });

  it('cloud env + ws://api.swiftagent.dev/v1/stream → rejected for scheme', () => {
    const msg = validatePublicWebsocketUrl({
      DEPLOY_ENV: 'prod',
      PUBLIC_WEBSOCKET_URL: 'ws://api.swiftagent.dev/v1/stream',
    });
    expect(msg).not.toBeNull();
    expect(msg).toContain('wss://');
  });

  it('cloud env + unparseable value → rejected as invalid URL', () => {
    const msg = validatePublicWebsocketUrl({
      DEPLOY_ENV: 'prod',
      PUBLIC_WEBSOCKET_URL: 'not a url',
    });
    expect(msg).not.toBeNull();
    expect(msg).toContain('valid URL');
  });

  it('cloud env + valid wss non-localhost URL → null', () => {
    expect(
      validatePublicWebsocketUrl({ DEPLOY_ENV: 'prod', PUBLIC_WEBSOCKET_URL: VALID }),
    ).toBeNull();
  });

  it('rejects 127.0.0.1 in a cloud environment', () => {
    const msg = validatePublicWebsocketUrl({
      DEPLOY_ENV: 'dev',
      PUBLIC_WEBSOCKET_URL: 'wss://127.0.0.1/v1/stream',
    });
    expect(msg).not.toBeNull();
    expect(msg).toContain('localhost');
  });

  it('cloud env + PUBLIC_WS_ALLOW_INSECURE=true + ws:// non-localhost → allowed', () => {
    expect(
      validatePublicWebsocketUrl({
        DEPLOY_ENV: 'dev',
        PUBLIC_WS_ALLOW_INSECURE: 'true',
        PUBLIC_WEBSOCKET_URL: 'ws://dev-alb-123.us-west-2.elb.amazonaws.com/v1/stream',
      }),
    ).toBeNull();
  });

  it('cloud env + PUBLIC_WS_ALLOW_INSECURE=true still rejects ws://localhost', () => {
    const msg = validatePublicWebsocketUrl({
      DEPLOY_ENV: 'dev',
      PUBLIC_WS_ALLOW_INSECURE: 'true',
      PUBLIC_WEBSOCKET_URL: 'ws://localhost:3000/v1/stream',
    });
    expect(msg).not.toBeNull();
    expect(msg).toContain('localhost');
  });

  it('PUBLIC_WS_ALLOW_INSECURE unset → ws:// still rejected (strict default)', () => {
    const msg = validatePublicWebsocketUrl({
      DEPLOY_ENV: 'prod',
      PUBLIC_WEBSOCKET_URL: 'ws://api.swiftagent.dev/v1/stream',
    });
    expect(msg).not.toBeNull();
    expect(msg).toContain('wss://');
  });

  it('no DEPLOY_ENV → missing URL is allowed (local dev, zero ceremony)', () => {
    expect(validatePublicWebsocketUrl({})).toBeNull();
  });

  it('no DEPLOY_ENV → ws://localhost:3001 is allowed', () => {
    expect(
      validatePublicWebsocketUrl({ PUBLIC_WEBSOCKET_URL: 'ws://localhost:3001' }),
    ).toBeNull();
  });

  it('DEPLOY_ENV=test (not a cloud env) → no constraint', () => {
    expect(validatePublicWebsocketUrl({ DEPLOY_ENV: 'test' })).toBeNull();
  });
});

describe('loadServerConfig — cloud PUBLIC_WEBSOCKET_URL guard (SC-04)', () => {
  const cloudBase: Record<string, string> = {
    DATABASE_URL: 'postgres://localhost:5432/test',
    CLIENT_JWT_SECRET: 'test-secret-key',
    OPENAI_API_KEY: 'sk-test-key',
    DEPLOY_ENV: 'prod',
  };

  it('throws when cloud + PUBLIC_WEBSOCKET_URL missing', () => {
    expect(() => loadServerConfig(cloudBase)).toThrow(/Missing required environment variables/);
    try {
      loadServerConfig(cloudBase);
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('PUBLIC_WEBSOCKET_URL');
      expect(msg).toContain('required');
    }
  });

  it('throws when cloud + PUBLIC_WEBSOCKET_URL is ws://localhost:3001', () => {
    expect(() =>
      loadServerConfig({ ...cloudBase, PUBLIC_WEBSOCKET_URL: 'ws://localhost:3001' }),
    ).toThrow(/PUBLIC_WEBSOCKET_URL/);
  });

  it('does NOT throw when cloud + valid wss URL and all required vars present', () => {
    const config = loadServerConfig({
      ...cloudBase,
      PUBLIC_WEBSOCKET_URL: 'wss://api.swiftagent.dev/v1/stream',
    });
    expect(config.PUBLIC_WEBSOCKET_URL).toBe('wss://api.swiftagent.dev/v1/stream');
  });
});

describe('redactConfig', () => {
  it('redacts secrets and shows non-secret values', () => {
    const config = loadServerConfig({
      DATABASE_URL: 'postgres://localhost:5432/test',
      CLIENT_JWT_SECRET: 'test-secret-key',
      OPENAI_API_KEY: 'sk-test',
      API_PORT: '3000',
      GATEWAY_PORT: '3001',
    });
    const summary = redactConfig(config);
    expect(summary.DATABASE_URL).toBe('***');
    expect(summary.CLIENT_JWT_SECRET).toBe('***');
    expect(summary.OPENAI_API_KEY).toBe('***');
    expect(summary.API_PORT).toBe('3000');
    // Unified server (WS-30) binds only API_PORT; GATEWAY_PORT is marked
    // local-only in the banner rather than shown as a second listening port.
    expect(summary.GATEWAY_PORT).toBe('(local-only)');
    expect(summary.REDIS_URL).toBe('(disabled)');
  });
});
