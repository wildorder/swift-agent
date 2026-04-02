import type { FastifyInstance } from 'fastify';
import type { TraceRepo } from '@swiftagent/db';
import type { SessionService } from '../services/session-service.js';

export function registerTraceRoutes(
  app: FastifyInstance,
  deps: { traceRepo: TraceRepo; sessionService: SessionService },
): void {
  const { traceRepo, sessionService } = deps;

  // GET /runs/:runId/trace — returns trace with nested spans
  app.get<{ Params: { runId: string } }>(
    '/runs/:runId/trace',
    async (req, reply) => {
      const { runId } = req.params;

      // Auth middleware verifies API key → workspace; getRun throws NOT_FOUND if missing
      await sessionService.getRun(runId);

      const trace = await traceRepo.getTraceByRunId(runId);
      if (!trace) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: `No trace found for run ${runId}` },
        });
      }

      const spans = await traceRepo.listSpansByTraceId(trace.traceId);

      return reply.send({ trace, spans });
    },
  );

  // GET /traces/:traceId/spans — returns span list
  app.get<{ Params: { traceId: string } }>(
    '/traces/:traceId/spans',
    async (req, reply) => {
      const spans = await traceRepo.listSpansByTraceId(req.params.traceId);
      return reply.send({ data: spans });
    },
  );
}
