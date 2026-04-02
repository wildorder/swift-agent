import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolDefinition, ToolSchema } from './types.js';

/**
 * Define a tool with a typed input schema and execute handler.
 * The returned object is frozen to prevent accidental mutation.
 */
export function tool<TInput, TResult>(
  config: ToolDefinition<TInput, TResult>,
): ToolDefinition<TInput, TResult> {
  if (!config.name || typeof config.name !== 'string') {
    throw new Error('Tool "name" is required and must be a non-empty string');
  }
  if (!config.description || typeof config.description !== 'string') {
    throw new Error('Tool "description" is required and must be a non-empty string');
  }
  if (!config.inputSchema || typeof config.inputSchema.safeParse !== 'function') {
    throw new Error('Tool "inputSchema" must be a Zod schema');
  }
  if (typeof config.execute !== 'function') {
    throw new Error('Tool "execute" must be a function');
  }

  return Object.freeze({ ...config });
}

/**
 * Convert a ToolDefinition's Zod inputSchema to a JSON Schema object
 * suitable for API registration payloads.
 */
export function toolToJsonSchema(def: ToolDefinition): ToolSchema {
  return {
    name: def.name,
    description: def.description,
    parameters: zodToJsonSchema(def.inputSchema, {
      target: 'openApi3',
      $refStrategy: 'none',
    }) as Record<string, unknown>,
  };
}
