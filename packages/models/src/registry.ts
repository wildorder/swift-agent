import { ENV_KEYS } from '@swiftagent/shared';
import type { ModelProvider } from './provider.js';
import { parseModelString } from './parser.js';
import type { ProviderConfig } from './types.js';
import { ModelError } from './types.js';

/** Factory function that provider packages export. */
export type ProviderFactory = (config: ProviderConfig) => ModelProvider;

/** Map from canonical provider id to the env var holding its API key. */
const PROVIDER_KEY_MAP: Record<string, string> = {
  openai: ENV_KEYS.OPENAI_API_KEY,
  anthropic: ENV_KEYS.ANTHROPIC_API_KEY,
  google: ENV_KEYS.GOOGLE_API_KEY,
};

/**
 * ProviderRegistry — manages provider factories and resolves model strings
 * to concrete `ModelProvider` instances.
 *
 * ## Config resolution order
 *
 * 1. Explicit `ProviderConfig` passed at registration time (used in tests).
 * 2. Environment variables via `ENV_KEYS` from `@swiftagent/shared`.
 */
export class ProviderRegistry {
  private readonly factories = new Map<string, ProviderFactory>();
  private readonly configs = new Map<string, ProviderConfig>();
  private readonly instances = new Map<string, ModelProvider>();

  /**
   * Register a provider factory. Optionally supply an explicit config
   * (useful for tests or multi-tenant setups).
   */
  register(
    providerId: string,
    factory: ProviderFactory,
    config?: ProviderConfig,
  ): void {
    this.factories.set(providerId, factory);
    if (config) {
      this.configs.set(providerId, config);
    }
    // Clear cached instance so next getProvider picks up new factory/config
    this.instances.delete(providerId);
  }

  /**
   * Return a `ModelProvider` for the given provider id.
   * Instantiates via factory with resolved config (explicit or env-based).
   * Caches the instance for subsequent calls.
   */
  getProvider(providerId: string): ModelProvider {
    const cached = this.instances.get(providerId);
    if (cached) return cached;

    const factory = this.factories.get(providerId);
    if (!factory) {
      throw new ModelError(
        `No provider registered for "${providerId}"`,
        providerId,
      );
    }

    const config = this.resolveConfig(providerId);
    const instance = factory(config);
    this.instances.set(providerId, instance);
    return instance;
  }

  /**
   * Parse a model string (e.g. "openai/gpt-4o"), resolve the provider,
   * and return both the provider instance and the provider-local model name.
   */
  resolveForModel(modelString: string): { provider: ModelProvider; modelId: string } {
    const parsed = parseModelString(modelString);
    const provider = this.getProvider(parsed.provider);
    return { provider, modelId: parsed.model };
  }

  /** Resolve a `ProviderConfig` for the given provider id. */
  private resolveConfig(providerId: string): ProviderConfig {
    const explicit = this.configs.get(providerId);
    if (explicit) return explicit;

    const envVar = PROVIDER_KEY_MAP[providerId];
    if (!envVar) {
      throw new ModelError(
        `No config or known env var for provider "${providerId}". ` +
          `Register with an explicit config or add a mapping to PROVIDER_KEY_MAP.`,
        providerId,
      );
    }

    const apiKey = process.env[envVar];
    if (!apiKey) {
      throw new ModelError(
        `Missing API key for provider "${providerId}": set the ${envVar} environment variable`,
        providerId,
      );
    }

    return { apiKey };
  }
}
