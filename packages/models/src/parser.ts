import { ModelError } from './types.js';

/** Supported provider identifiers. */
export type ProviderId = 'openai' | 'anthropic' | 'google';

/** Result of parsing a model string. */
export interface ParsedModel {
  provider: ProviderId;
  model: string;
}

/**
 * Common aliases that map to canonical provider names.
 *
 * - "openai" → "openai"
 * - "anthropic" → "anthropic"
 * - "google" → "google"
 * - "gemini" → "google"  (convenience alias)
 * - "claude" → "anthropic" (convenience alias)
 * - "gpt" → "openai" (convenience alias)
 */
const PROVIDER_ALIASES: Record<string, ProviderId> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  gemini: 'google',
  claude: 'anthropic',
  gpt: 'openai',
};

/**
 * Parse a model string of the form `provider/model-name` into its parts.
 *
 * The provider segment is resolved through known aliases. Unknown provider
 * names are still accepted — the registry will decide whether the provider
 * is registered.
 *
 * @example parseModelString("openai/gpt-4o") → { provider: "openai", model: "gpt-4o" }
 * @example parseModelString("gemini/gemini-1.5-pro") → { provider: "google", model: "gemini-1.5-pro" }
 */
export function parseModelString(model: string): ParsedModel {
  if (!model) {
    throw new ModelError('Model string must not be empty', 'unknown');
  }

  const slashIndex = model.indexOf('/');
  if (slashIndex === -1) {
    throw new ModelError(
      `Invalid model string "${model}": expected format "provider/model-name"`,
      'unknown',
    );
  }

  const rawProvider = model.slice(0, slashIndex);
  const modelName = model.slice(slashIndex + 1);

  if (!rawProvider) {
    throw new ModelError(
      `Invalid model string "${model}": provider segment is empty`,
      'unknown',
    );
  }
  if (!modelName) {
    throw new ModelError(
      `Invalid model string "${model}": model segment is empty`,
      'unknown',
    );
  }

  const provider = PROVIDER_ALIASES[rawProvider] ?? (rawProvider as ProviderId);

  return { provider, model: modelName };
}

/**
 * Inverse of `parseModelString` — formats a provider and model into a
 * model string suitable for logging and display.
 */
export function formatModelString(provider: string, model: string): string {
  return `${provider}/${model}`;
}
