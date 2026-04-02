import { generateTraceId, generateSpanId } from '@swiftagent/shared';
import type { TraceSink, TraceRecord } from './types.js';
import { Span } from './span.js';

export interface RunTraceContext {
  readonly traceId: string;
  readonly rootSpan: Span;
  startModelCall(modelName: string): Span;
  startToolCall(toolName: string, callId: string): Span;
  finish(status: 'ok' | 'error', error?: Error): Promise<void>;
}

export class Tracer {
  private readonly sink: TraceSink;

  constructor(traceSink: TraceSink) {
    this.sink = traceSink;
  }

  startRunTrace(runId: string): RunTraceContext {
    const traceId = generateTraceId();
    const rootSpanId = generateSpanId();
    const rootSpan = new Span(rootSpanId, traceId, null, 'run_span', `run:${runId}`);
    rootSpan.start();

    const spans: Span[] = [rootSpan];

    return {
      traceId,
      rootSpan,

      startModelCall(modelName: string): Span {
        const child = rootSpan.startChild('model_call_span', `model:${modelName}`);
        child.addMetadata({ modelName });
        spans.push(child);
        return child;
      },

      startToolCall(toolName: string, callId: string): Span {
        const child = rootSpan.startChild('tool_call_span', `tool:${toolName}`);
        child.addMetadata({ toolName, callId });
        spans.push(child);
        return child;
      },

      finish: async (status: 'ok' | 'error', error?: Error): Promise<void> => {
        rootSpan.end(status, error);

        const rootRecord = rootSpan.toRecord();
        const trace: TraceRecord = {
          traceId,
          runId,
          rootSpanId,
          startedAt: rootRecord.startedAt,
          completedAt: rootRecord.completedAt,
          totalDurationMs: rootRecord.durationMs,
        };

        await this.sink.saveTrace(trace);
        await this.sink.saveSpans(spans.map((s) => s.toRecord()));
      },
    };
  }
}
