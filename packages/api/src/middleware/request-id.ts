import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';

export function registerRequestId(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    const id = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
    req.id = id;
    req.log = req.log.child({ requestId: id });
    reply.header('X-Request-Id', id);
  });
}
