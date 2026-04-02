import type { AgentRepo } from '@swiftagent/db';
import type { AgentRecord, MemoryConfig } from '@swiftagent/shared';
import { generateAgentId, SwiftAgentError } from '@swiftagent/shared';
import { CreateAgentBodySchema, type CreateAgentBody } from '../types.js';

export interface AgentService {
  registerOrUpdateAgent(workspaceId: string, input: CreateAgentBody): Promise<AgentRecord>;
  getById(workspaceId: string, agentId: string): Promise<AgentRecord>;
  getByName(workspaceId: string, name: string): Promise<AgentRecord>;
}

const DEFAULT_MEMORY_CONFIG: MemoryConfig = { strategy: 'last_n', maxMessages: 50 };

export function createAgentService(agentRepo: AgentRepo): AgentService {
  return {
    async registerOrUpdateAgent(workspaceId, input) {
      const parsed = CreateAgentBodySchema.parse(input);

      // Try upsert by (workspaceId, name)
      const existing = await agentRepo.getByName(workspaceId, parsed.name);
      if (existing) {
        const updated = await agentRepo.update(existing.agentId, {
          modelConfig: parsed.modelConfig,
          systemPrompt: parsed.systemPrompt,
          memoryConfig: parsed.memoryConfig ?? existing.memoryConfig,
          toolRunnerUrl: parsed.toolRunnerUrl ?? existing.toolRunnerUrl,
        });
        if (!updated) {
          throw new SwiftAgentError('INTERNAL', 'Failed to update agent');
        }
        return updated;
      }

      return agentRepo.create({
        agentId: generateAgentId(),
        workspaceId,
        name: parsed.name,
        modelConfig: parsed.modelConfig,
        systemPrompt: parsed.systemPrompt,
        memoryConfig: parsed.memoryConfig ?? DEFAULT_MEMORY_CONFIG,
        toolRunnerUrl: parsed.toolRunnerUrl ?? null,
      });
    },

    async getById(workspaceId, agentId) {
      const agent = await agentRepo.getById(agentId);
      if (!agent || agent.workspaceId !== workspaceId) {
        throw new SwiftAgentError('NOT_FOUND', `Agent ${agentId} not found`);
      }
      return agent;
    },

    async getByName(workspaceId, name) {
      const agent = await agentRepo.getByName(workspaceId, name);
      if (!agent) {
        throw new SwiftAgentError('NOT_FOUND', `Agent "${name}" not found`);
      }
      return agent;
    },
  };
}
