import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ProviderRegistry } from '../registry.js';
import type { ModelProvider } from '../provider.js';
import type { ProviderConfig, ModelStreamChunk } from '../types.js';
import { ModelError } from '../types.js';

/** Creates a mock ModelProvider that yields a single finish chunk. */
function createMockProvider(): ModelProvider {
  return {
    async *generate(): AsyncGenerator<ModelStreamChunk, void, undefined> {
      yield { type: 'finish', finishReason: 'stop', usage: {} };
    },
  };
}

describe('ProviderRegistry', () => {
  let registry: ProviderRegistry;
  const originalEnv = process.env;

  beforeEach(() => {
    registry = new ProviderRegistry();
    // Isolate env mutations
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('registers a factory and returns a ModelProvider via getProvider', () => {
    const mockProvider = createMockProvider();
    const factory = vi.fn((_config: ProviderConfig) => mockProvider);

    registry.register('openai', factory, { apiKey: 'test-key' });
    const provider = registry.getProvider('openai');

    expect(provider).toBe(mockProvider);
    expect(factory).toHaveBeenCalledWith({ apiKey: 'test-key' });
  });

  it('caches provider instances', () => {
    const factory = vi.fn((_config: ProviderConfig) => createMockProvider());
    registry.register('openai', factory, { apiKey: 'test-key' });

    const first = registry.getProvider('openai');
    const second = registry.getProvider('openai');

    expect(first).toBe(second);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('resolveForModel parses model string and returns provider + modelId', () => {
    const mockProvider = createMockProvider();
    registry.register('openai', () => mockProvider, { apiKey: 'test-key' });

    const result = registry.resolveForModel('openai/gpt-4o');

    expect(result.provider).toBe(mockProvider);
    expect(result.modelId).toBe('gpt-4o');
  });

  it('throws for unregistered provider', () => {
    expect(() => registry.getProvider('openai')).toThrow(ModelError);
    expect(() => registry.getProvider('openai')).toThrow('No provider registered');
  });

  it('resolves API key from environment variables', () => {
    process.env.OPENAI_API_KEY = 'sk-env-key';
    const factory = vi.fn((_config: ProviderConfig) => createMockProvider());

    registry.register('openai', factory);
    registry.getProvider('openai');

    expect(factory).toHaveBeenCalledWith({ apiKey: 'sk-env-key' });
  });

  it('throws with env var name when API key is missing', () => {
    delete process.env.OPENAI_API_KEY;
    registry.register('openai', () => createMockProvider());

    expect(() => registry.getProvider('openai')).toThrow(ModelError);
    expect(() => registry.getProvider('openai')).toThrow('OPENAI_API_KEY');
  });

  it('throws for unknown provider without env mapping or explicit config', () => {
    registry.register('custom', () => createMockProvider());

    expect(() => registry.getProvider('custom')).toThrow(ModelError);
    expect(() => registry.getProvider('custom')).toThrow('No config or known env var');
  });

  it('explicit config takes precedence over env var', () => {
    process.env.OPENAI_API_KEY = 'sk-env-key';
    const factory = vi.fn((_config: ProviderConfig) => createMockProvider());

    registry.register('openai', factory, { apiKey: 'sk-explicit-key' });
    registry.getProvider('openai');

    expect(factory).toHaveBeenCalledWith({ apiKey: 'sk-explicit-key' });
  });

  it('clears cached instance when re-registering', () => {
    const first = createMockProvider();
    const second = createMockProvider();

    registry.register('openai', () => first, { apiKey: 'key-1' });
    expect(registry.getProvider('openai')).toBe(first);

    registry.register('openai', () => second, { apiKey: 'key-2' });
    expect(registry.getProvider('openai')).toBe(second);
  });
});
