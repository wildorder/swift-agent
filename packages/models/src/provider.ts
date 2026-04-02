import type { ModelRequest, ModelStreamChunk } from './types.js';

/**
 * ModelProvider — the contract that all provider implementations must conform to.
 *
 * ## Chunk ordering contract
 *
 * A single call to `generate()` yields chunks in this order:
 * 1. Zero or more `token` chunks (partial text tokens as they stream in)
 * 2. Zero or more `tool_call` chunks (each with fully assembled `arguments`)
 * 3. Exactly one terminal `finish` chunk per model round
 *
 * The `finish` chunk always comes last. Consumers can rely on receiving it
 * to know the model round is complete.
 */
export interface ModelProvider {
  generate(request: ModelRequest): AsyncGenerator<ModelStreamChunk, void, undefined>;
}
