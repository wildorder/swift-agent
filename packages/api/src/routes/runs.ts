import type { FastifyInstance } from 'fastify';
import { CreateRunBodySchema, AcceptedRunResponseSchema } from '../types.js';
import type { AuthenticatedRequest } from '../types.js';
import type { SessionService } from '../services/session-service.js';

export function registerRunRoutes(app: FastifyInstance, sessionService: SessionService): void {
  // POST /sessions/:sessionId/runs — create + start a run (async, process-bound).
  // Returns 202; the run executes without a WebSocket client and is observed
  // via GET /runs/:runId. A concurrent active run yields 409 (CONFLICT).
  app.post<{ Params: { sessionId: string } }>(
    '/sessions/:sessionId/runs',
    async (req, reply) => {
      const { workspaceId } = req as AuthenticatedRequest;
      const body = CreateRunBodySchema.parse(req.body);

      const { runId } = await sessionService.createRun({
        workspaceId,
        sessionId: req.params.sessionId,
        content: body.content,
      });

      return reply
        .status(202)
        .send(AcceptedRunResponseSchema.parse({ runId, status: 'running' }));
    },
  );

  // GET /runs/:runId — reflects current + terminal status; 404 for another
  // workspace's run (no existence leak).
  app.get<{ Params: { runId: string } }>('/runs/:runId', async (req, reply) => {
    const { workspaceId } = req as AuthenticatedRequest;
    const run = await sessionService.getRun(workspaceId, req.params.runId);
    return reply.send(run);
  });

  // GET /runs/:runId/tool-calls
  app.get<{ Params: { runId: string } }>('/runs/:runId/tool-calls', async (req, reply) => {
    const { workspaceId } = req as AuthenticatedRequest;
    const toolCalls = await sessionService.getRunToolCalls(workspaceId, req.params.runId);
    return reply.send({ data: toolCalls });
  });

  // POST /runs/:runId/cancel — idempotent cancellation request. Repeated calls
  // (including after terminal state) also return 202.
  app.post<{ Params: { runId: string } }>('/runs/:runId/cancel', async (req, reply) => {
    const { workspaceId } = req as AuthenticatedRequest;
    await sessionService.requestCancel(workspaceId, req.params.runId);
    return reply
      .status(202)
      .send(AcceptedRunResponseSchema.parse({ runId: req.params.runId, status: 'cancelling' }));
  });
}
