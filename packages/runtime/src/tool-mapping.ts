import type { ToolDefinition } from '@swiftagent/shared';
import type { ToolSchema } from '@swiftagent/models';
import { Ajv, type ValidateFunction } from 'ajv';
// ajv-formats ships CJS (`module.exports = plugin`). Under Node16 ESM the
// callable plugin is the module's `default` binding at runtime, but its type
// resolves to the module namespace, so normalize it to the callable shape.
import * as addFormatsModule from 'ajv-formats';

const addFormats = (addFormatsModule as unknown as { default: (ajv: Ajv) => void }).default;

/**
 * An entry in the tool index: the persisted definition plus a compiled
 * Ajv validator for its `inputSchema`. Compilation happens once, at index
 * build time, so per-call validation is O(1).
 */
export type ToolIndexEntry = {
  def: ToolDefinition;
  validate: ValidateFunction;
};

/**
 * Sentinel validator used when a tool's `inputSchema` fails to compile.
 * It always reports the input as invalid so the loop rejects the call with
 * `INVALID_ARGUMENTS` rather than crashing the run. The attached error carries
 * a schema-compilation message that surfaces to the model.
 */
function makeSchemaErrorValidator(toolName: string, reason: string): ValidateFunction {
  const validate = ((_data: unknown) => false) as unknown as ValidateFunction;
  validate.errors = [
    {
      keyword: 'schemaCompilation',
      instancePath: '',
      schemaPath: '',
      params: {},
      message: `tool "${toolName}" has an invalid input schema: ${reason}`,
    },
  ];
  return validate;
}

/**
 * Map persisted `ToolDefinition[]` to the provider-neutral `ToolSchema[]` the
 * model layer understands. Each `{ name, description, inputSchema }` becomes
 * `{ name, description, parameters: inputSchema }`.
 */
export function toModelToolSchemas(tools: ToolDefinition[]): ToolSchema[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }));
}

/**
 * Build an O(1) lookup index keyed by tool name. Each entry carries the
 * persisted definition and a compiled Ajv `ValidateFunction` for its
 * `inputSchema`.
 *
 * The persisted schema is produced by `zod-to-json-schema` with
 * `target: 'openApi3'`, so it may contain nested objects, arrays, enums, and
 * string formats. Ajv is configured with `{ strict: false, allErrors: true }`
 * and `ajv-formats` so those OpenAPI-style schemas compile without throwing.
 *
 * If a tool name is duplicated, the last definition wins. If a schema fails to
 * compile, a sentinel validator is stored so calls to that tool are rejected
 * with `INVALID_ARGUMENTS` instead of crashing the run.
 */
export function buildToolIndex(tools: ToolDefinition[]): Map<string, ToolIndexEntry> {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);

  const index = new Map<string, ToolIndexEntry>();
  for (const def of tools) {
    let validate: ValidateFunction;
    try {
      validate = ajv.compile(def.inputSchema);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      validate = makeSchemaErrorValidator(def.name, reason);
    }
    index.set(def.name, { def, validate });
  }
  return index;
}
