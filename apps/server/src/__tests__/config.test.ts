import { describe, it, expect } from 'vitest';
import { loadServerConfig, redactConfig } from '../config.js';

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
    expect(summary.GATEWAY_PORT).toBe('3001');
    expect(summary.REDIS_URL).toBe('(disabled)');
  });
});
