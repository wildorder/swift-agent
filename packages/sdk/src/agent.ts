import type { ZodError } from 'zod';
import { SwiftAgentError, SwiftAgentErrorCode } from '@swiftagent/shared';
import { SdkAgentConfigSchema } from './types.js';
import type { SdkAgentConfig, AgentDefinition } from './types.js';
import { toolToJsonSchema } from './tool.js';

/**
 * Define an agent with a validated configuration.
 * Returns a frozen AgentDefinition suitable for API registration.
 */
export function defineAgent(config: SdkAgentConfig): AgentDefinition {
  // Validate the developer-supplied config shape (tools array validated
  // separately since they're objects). A Zod failure is wrapped into an
  // actionable SwiftAgentError(VALIDATION) that names the first failing field
  // path, preserving the ZodError as `.cause` for callers who want the detail (WS-41).
  const result = SdkAgentConfigSchema.safeParse(config);
  if (!result.success) {
    throw invalidAgentConfig(result.error);
  }
  const parsed = result.data;

  const tools = config.tools ?? [];

  // Check for duplicate tool names within this agent
  const seen = new Set<string>();
  for (const t of tools) {
    if (seen.has(t.name)) {
      throw new SwiftAgentError(
        SwiftAgentErrorCode.VALIDATION,
        `Duplicate tool name "${t.name}" in agent "${parsed.name}" — each tool name must be ` +
          `unique within an agent; rename one of the conflicting tools.`,
      );
    }
    seen.add(t.name);
  }

  const toolSchemas = tools.map(toolToJsonSchema);

  const definition: AgentDefinition = {
    name: parsed.name,
    modelConfig: {
      model: parsed.model,
      ...(parsed.temperature !== undefined && { temperature: parsed.temperature }),
      ...(parsed.maxTokens !== undefined && { maxTokens: parsed.maxTokens }),
    },
    systemPrompt: parsed.system ?? '',
    ...(parsed.memory && {
      memoryConfig: {
        strategy: parsed.memory.strategy,
        ...(parsed.memory.maxMessages !== undefined && {
          maxMessages: parsed.memory.maxMessages,
        }),
      },
    }),
    toolSchemas,
    tools,
  };

  return Object.freeze(definition);
}

/** Wrap a Zod validation failure into an actionable, field-named SwiftAgentError. */
function invalidAgentConfig(error: ZodError): SwiftAgentError {
  const [first] = error.issues;
  const path = first && first.path.length > 0 ? first.path.join('.') : '(root)';
  const detail = first ? `${path} — ${first.message}` : error.message;
  return new SwiftAgentError(
    SwiftAgentErrorCode.VALIDATION,
    `Invalid agent config: ${detail}. Check the value passed to defineAgent().`,
    { cause: error },
  );
}
