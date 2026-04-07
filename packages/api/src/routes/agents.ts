import type { FastifyInstance } from 'fastify';
import { CreateAgentBodySchema } from '../types.js';
import type { AuthenticatedRequest } from '../types.js';
import type { AgentService } from '../services/agent-service.js';

export function registerAgentRoutes(app: FastifyInstance, agentService: AgentService): void {
  // POST /agents — register or update an agent
  app.post('/agents', async (req, reply) => {
    const { workspaceId } = req as AuthenticatedRequest;
    const body = CreateAgentBodySchema.parse(req.body);
    const agent = await agentService.registerOrUpdateAgent(workspaceId, body);

    // 201 if newly created (check updatedAt ~ createdAt), else 200
    const isNew =
      Math.abs(agent.updatedAt.getTime() - agent.createdAt.getTime()) < 1000;
    return reply.status(isNew ? 201 : 200).send(agent);
  });

  // GET /agents/:agentId — get agent by ID
  app.get<{ Params: { agentId: string } }>('/agents/:agentId', async (req, reply) => {
    const { workspaceId } = req as AuthenticatedRequest;
    const agent = await agentService.getById(workspaceId, req.params.agentId);
    return reply.send(agent);
  });

  // GET /agents?name=... — get agent by name, or list all agents for the workspace
  app.get('/agents', async (req, reply) => {
    const { workspaceId } = req as AuthenticatedRequest;
    const { name } = req.query as { name?: string };

    if (!name) {
      const agents = await agentService.list(workspaceId);
      return reply.send(agents);
    }

    const agent = await agentService.getByName(workspaceId, name);
    return reply.send(agent);
  });
}
