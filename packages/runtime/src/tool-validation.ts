import type { ErrorObject } from 'ajv';
import type { ToolIndexEntry } from './tool-mapping.js';

/**
 * Result of validating a model-emitted tool call against the registered
 * allowlist and the tool's persisted JSON input schema.
 */
export type ToolValidationResult =
  | { ok: true }
  | { ok: false; code: 'UNKNOWN_TOOL' | 'INVALID_ARGUMENTS'; message: string };

/**
 * Assemble a human-readable, actionable message from Ajv errors so the model
 * can correct the call on its next turn.
 */
function formatAjvErrors(toolName: string, errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) {
    return `Arguments for tool "${toolName}" failed schema validation.`;
  }
  const details = errors
    .map((e) => {
      const path = e.instancePath && e.instancePath.length > 0 ? e.instancePath : '(root)';
      return `${path} ${e.message ?? 'is invalid'}`.trim();
    })
    .join('; ');
  return `Arguments for tool "${toolName}" failed schema validation: ${details}`;
}

/**
 * Validate a model-emitted tool call:
 *
 * 1. Allowlist — if `toolName` is not present in `index`, reject with
 *    `UNKNOWN_TOOL` (the executor must never see an unregistered tool).
 * 2. Argument schema — validate `args` against the tool's persisted JSON
 *    `inputSchema` using the pre-compiled Ajv `ValidateFunction`. On failure,
 *    reject with `INVALID_ARGUMENTS` and an actionable message.
 *
 * A tool whose schema failed to compile carries a sentinel validator that
 * always fails, so its calls are rejected with `INVALID_ARGUMENTS` rather than
 * crashing the run.
 */
export function validateToolCall(
  index: Map<string, ToolIndexEntry>,
  toolName: string,
  args: unknown,
): ToolValidationResult {
  const entry = index.get(toolName);
  if (!entry) {
    return {
      ok: false,
      code: 'UNKNOWN_TOOL',
      message: `Tool "${toolName}" is not registered for this agent.`,
    };
  }

  const valid = entry.validate(args);
  if (!valid) {
    return {
      ok: false,
      code: 'INVALID_ARGUMENTS',
      message: formatAjvErrors(toolName, entry.validate.errors),
    };
  }

  return { ok: true };
}
