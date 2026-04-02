import type { FastifyInstance } from 'fastify';
import { CreateRunBodySchema } from '../types.js';
import type { AuthenticatedRequest } from '../types.js';
import type { SessionService } from '../services/session-service.js';

export function registerRunRoutes(app: FastifyInstance, sessionService: SessionService): void {
  // POST /sessions/:sessionId/runs — create a run with a user message
  app.post<{ Params: { sessionId: string } }>(
    '/sessions/:sessionId/runs',
    async (req, reply) => {
      const { workspaceId } = req as AuthenticatedRequest;
      const body = CreateRunBodySchema.parse(req.body);

      const { run } = await sessionService.createRun({
        workspaceId,
        sessionId: req.params.sessionId,
        content: body.content,
      });

      return reply.status(201).send(run);
    },
  );

  // GET /runs/:runId
  app.get<{ Params: { runId: string } }>('/runs/:runId', async (req, reply) => {
    const run = await sessionService.getRun(req.params.runId);
    return reply.send(run);
  });

  // GET /runs/:runId/tool-calls
  app.get<{ Params: { runId: string } }>('/runs/:runId/tool-calls', async (req, reply) => {
    const toolCalls = await sessionService.getRunToolCalls(req.params.runId);
    return reply.send({ data: toolCalls });
  });
}
