import type { FastifyInstance } from 'fastify';
import { CreateSessionBodySchema, PatchSessionBodySchema } from '../types.js';
import type { AuthenticatedRequest } from '../types.js';
import type { SessionService } from '../services/session-service.js';
import type { TokenService } from '../services/token-service.js';

export interface SessionRouteDeps {
  sessionService: SessionService;
  tokenService: TokenService;
  publicWebsocketUrl: string;
}

export function registerSessionRoutes(app: FastifyInstance, deps: SessionRouteDeps): void {
  const { sessionService, tokenService, publicWebsocketUrl } = deps;

  // POST /sessions — create session, issue client token
  app.post('/sessions', async (req, reply) => {
    const { workspaceId } = req as AuthenticatedRequest;
    const body = CreateSessionBodySchema.parse(req.body);

    const { session, agentId } = await sessionService.createSession({
      workspaceId,
      agentName: body.agentName,
      userId: body.userId,
      metadata: body.metadata,
    });

    const clientToken = await tokenService.signClientToken({
      sessionId: session.sessionId,
      agentId,
      permissions: ['chat'],
    });

    const websocketUrl = `${publicWebsocketUrl}?token=${clientToken}`;

    return reply.status(201).send({
      sessionId: session.sessionId,
      clientToken,
      websocketUrl,
    });
  });

  // GET /sessions/:sessionId
  app.get<{ Params: { sessionId: string } }>('/sessions/:sessionId', async (req, reply) => {
    const { workspaceId } = req as AuthenticatedRequest;
    const session = await sessionService.getSession(workspaceId, req.params.sessionId);
    return reply.send(session);
  });

  // PATCH /sessions/:sessionId
  app.patch<{ Params: { sessionId: string } }>('/sessions/:sessionId', async (req, reply) => {
    const { workspaceId } = req as AuthenticatedRequest;
    const body = PatchSessionBodySchema.parse(req.body);
    const session = await sessionService.updateSession(
      workspaceId,
      req.params.sessionId,
      { status: body.status },
    );
    return reply.send(session);
  });
}
