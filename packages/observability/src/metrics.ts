import type { SpanRecord } from './types.js';

export interface RunMetrics {
  totalRunDurationMs: number | null;
  timeToFirstTokenMs: number | null;
  modelCallCount: number;
  toolCallCount: number;
  totalModelLatencyMs: number;
  totalToolLatencyMs: number;
  totalTokens: number;
}

/**
 * Derives latency and usage metrics from a set of spans belonging to a single trace.
 * Expects spans ordered by startedAt.
 */
export function deriveRunMetrics(spans: SpanRecord[]): RunMetrics {
  const runSpan = spans.find((s) => s.type === 'run_span');
  const modelSpans = spans.filter((s) => s.type === 'model_call_span');
  const toolSpans = spans.filter((s) => s.type === 'tool_call_span');

  const totalRunDurationMs = runSpan?.durationMs ?? null;

  // Time-to-first-token: gap between run start and first model call span end
  let timeToFirstTokenMs: number | null = null;
  if (runSpan?.startedAt && modelSpans.length > 0) {
    const firstModel = modelSpans[0];
    if (firstModel?.completedAt) {
      timeToFirstTokenMs = firstModel.completedAt.getTime() - runSpan.startedAt.getTime();
    }
  }

  const totalModelLatencyMs = modelSpans.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);
  const totalToolLatencyMs = toolSpans.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);

  const totalTokens = spans.reduce((sum, s) => {
    const promptTokens = (s.metadata.promptTokens as number) ?? 0;
    const completionTokens = (s.metadata.completionTokens as number) ?? 0;
    return sum + promptTokens + completionTokens;
  }, 0);

  return {
    totalRunDurationMs,
    timeToFirstTokenMs,
    modelCallCount: modelSpans.length,
    toolCallCount: toolSpans.length,
    totalModelLatencyMs,
    totalToolLatencyMs,
    totalTokens,
  };
}
