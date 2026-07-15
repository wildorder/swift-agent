import type { FastifyInstance } from 'fastify';
import type { TraceRepo } from '@swiftagent/db';
import type { AuthenticatedRequest } from '../types.js';
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
      const { workspaceId } = req as AuthenticatedRequest;
      const { runId } = req.params;

      // Ownership: getRun throws NOT_FOUND if the run is missing OR owned by
      // another workspace (run → session → agent → workspace), so a
      // cross-workspace trace read returns 404 without leaking existence.
      await sessionService.getRun(workspaceId, runId);

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

  // GET /traces/:traceId/spans — returns span list. Resolve the trace to its
  // owning run and assert workspace ownership before returning spans, closing
  // the direct cross-tenant leak.
  app.get<{ Params: { traceId: string } }>(
    '/traces/:traceId/spans',
    async (req, reply) => {
      const { workspaceId } = req as AuthenticatedRequest;
      const { traceId } = req.params;

      const trace = await traceRepo.getTraceById(traceId);
      if (!trace) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: `Trace ${traceId} not found` },
        });
      }

      // Throws NOT_FOUND (→ 404) if the owning run is in another workspace.
      await sessionService.getRun(workspaceId, trace.runId);

      const spans = await traceRepo.listSpansByTraceId(traceId);
      return reply.send({ data: spans });
    },
  );
}
