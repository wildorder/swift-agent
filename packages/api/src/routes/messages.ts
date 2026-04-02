import type { FastifyInstance } from 'fastify';
import { ListMessagesQuerySchema } from '../types.js';
import type { AuthenticatedRequest } from '../types.js';
import type { SessionService } from '../services/session-service.js';

export function registerMessageRoutes(app: FastifyInstance, sessionService: SessionService): void {
  // GET /sessions/:sessionId/messages — cursor/limit pagination
  app.get<{ Params: { sessionId: string } }>(
    '/sessions/:sessionId/messages',
    async (req, reply) => {
      const { workspaceId } = req as AuthenticatedRequest;

      // Verify session belongs to workspace
      await sessionService.getSession(workspaceId, req.params.sessionId);

      const query = ListMessagesQuerySchema.parse(req.query);
      const messages = await sessionService.listMessages(req.params.sessionId, {
        limit: query.limit,
        cursor: query.cursor,
      });

      return reply.send({
        data: messages,
        hasMore: messages.length === query.limit,
      });
    },
  );
}
