import { SdkAgentConfigSchema } from './types.js';
import type { SdkAgentConfig, AgentDefinition } from './types.js';
import { toolToJsonSchema } from './tool.js';

/**
 * Define an agent with a validated configuration.
 * Returns a frozen AgentDefinition suitable for API registration.
 */
export function defineAgent(config: SdkAgentConfig): AgentDefinition {
  // Validate the config shape (tools array validated separately since they're objects)
  const parsed = SdkAgentConfigSchema.parse(config);

  const tools = config.tools ?? [];

  // Check for duplicate tool names within this agent
  const seen = new Set<string>();
  for (const t of tools) {
    if (seen.has(t.name)) {
      throw new Error(`Duplicate tool name "${t.name}" in agent "${parsed.name}"`);
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
