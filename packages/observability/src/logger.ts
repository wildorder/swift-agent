import type { Logger } from 'pino';

export interface TraceLogContext {
  traceId: string;
  spanId?: string;
}

/**
 * Creates a pino child logger with trace context bindings.
 * Every log line emitted by the returned logger will include
 * `traceId` and optionally `spanId` fields.
 *
 * For MVP, trace context is passed explicitly. A future iteration
 * can use AsyncLocalStorage for implicit propagation.
 */
export function createTracedLogger(
  baseLogger: Logger,
  ctx: TraceLogContext,
): Logger {
  const bindings: Record<string, string> = { traceId: ctx.traceId };
  if (ctx.spanId) {
    bindings.spanId = ctx.spanId;
  }
  return baseLogger.child(bindings);
}
