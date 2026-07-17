import type { FastifyInstance } from 'fastify';
import type { TraceRepo } from '@swiftagent/db';
import { deriveRunMetrics, type SpanRecord } from '@swiftagent/observability';
import { RunMetricsResponseSchema } from '../types.js';
import type { AuthenticatedRequest } from '../types.js';
import type { SessionService } from '../services/session-service.js';

/**
 * Run-metrics route (WS-28). Metrics are COMPUTED ON READ from the run's
 * persisted spans — no new table, enum, or migration. A dedicated module (not
 * an extension of `traces.ts`) keeps the raw trace/span readers separate from
 * this computed roll-up with its own Zod response contract.
 */
export function registerMetricsRoutes(
  app: FastifyInstance,
  deps: { traceRepo: TraceRepo; sessionService: SessionService },
): void {
  const { traceRepo, sessionService } = deps;

  // GET /runs/:runId/metrics — derived latency + token roll-up for an owned run.
  app.get<{ Params: { runId: string } }>('/runs/:runId/metrics', async (req, reply) => {
    const { workspaceId } = req as AuthenticatedRequest;
    const { runId } = req.params;

    // Ownership first: getRun throws NOT_FOUND (→ 404) if the run is missing OR
    // owned by another workspace, so a cross-workspace read returns 404 without
    // leaking existence. Byte-for-byte the `routes/traces.ts` semantics.
    const run = await sessionService.getRun(workspaceId, runId);

    const trace = await traceRepo.getTraceByRunId(runId);
    if (!trace) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: `No trace found for run ${runId}` },
      });
    }

    const spans = await traceRepo.listSpansByTraceId(trace.traceId);
    // Rows carry DB-enum-constrained `type`/`status`; `deriveRunMetrics` only
    // reads a subset of fields, so treating the trusted rows as SpanRecord[] is
    // safe and localized to this single call site.
    const metrics = deriveRunMetrics(spans as unknown as SpanRecord[]);

    // Surface the span-derived total for internal consistency with the
    // span-derived latencies. Fall back to the run row's authoritative
    // `tokenUsage.totalTokens` only when the spans carry no token metadata
    // (older traces, or a provider that omitted usage).
    const rowTokens = run.tokenUsage?.totalTokens ?? 0;
    const totalTokens =
      metrics.totalTokens === 0 && rowTokens > 0 ? rowTokens : metrics.totalTokens;

    return reply.send(
      RunMetricsResponseSchema.parse({
        runId,
        traceId: trace.traceId,
        ...metrics,
        totalTokens,
      }),
    );
  });
}
