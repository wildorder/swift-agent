import type { MessageRepo, RunRepo, ToolCallRepo, SessionRepo, AgentRepo } from '@swiftagent/db';
import type { ProviderRegistry } from '@swiftagent/models';
import type { AgentRecord } from '@swiftagent/shared';
import type { ToolExecutor } from './tool-executor.js';
import type { ToolExecutorResolver } from './tool-executor-resolver.js';

export type Logger = {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
};

/**
 * Structural view of the observability `Span` the loop drives. Kept minimal
 * (and structural, not an import) so `@swiftagent/runtime` need not depend on
 * `@swiftagent/observability` — the concrete `Span` satisfies this shape.
 */
export interface RunSpan {
  end(status: 'ok' | 'error', error?: Error): unknown;
  addMetadata(partial: Record<string, unknown>): unknown;
}

/**
 * Structural view of `RunTraceContext` from `@swiftagent/observability`. One
 * trace per run; a span per model call and per tool call; `finish` persists the
 * trace + all spans via the `TraceSink`.
 */
export interface RunTrace {
  startModelCall(modelName: string): RunSpan;
  startToolCall(toolName: string, callId: string): RunSpan;
  finish(status: 'ok' | 'error', error?: Error): Promise<void>;
}

/**
 * Runtime-facing tracer. Reconciled with the observability `Tracer` (WS-24) —
 * the previous `startSpan`/`endSpan` shape was never implemented by anything.
 * The concrete `Tracer` from `@swiftagent/observability` satisfies this.
 */
export interface Tracer {
  startRunTrace(runId: string): RunTrace;
}

export type AgentEngineDeps = {
  db: {
    messages: MessageRepo;
    runs: RunRepo;
    toolCalls: ToolCallRepo;
    sessions: SessionRepo;
    agents: AgentRepo;
  };
  modelRegistry: ProviderRegistry;
  // Resolves the run-scoped executor from the active run's agent (WS-21).
  // The executor itself lives on RunContext, never here — this keeps one
  // agent's runner from being reachable by another (SC-07).
  toolExecutorResolver: ToolExecutorResolver;
  tracer?: Tracer;
  logger?: Logger;
};

export const DEFAULT_MAX_TOOL_ITERATIONS = 10;
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
export const DEFAULT_LAST_N = 50;

export type AgentEngineOptions = {
  maxToolIterations?: number;
  /** Per-tool-call deadline. Exceeding it fails the tool call AND times out
   *  the run (`timed_out`) — there is no silent continuation (WS-24, SC-14). */
  toolTimeoutMs?: number;
  /** Per-model-call deadline. Exceeding it times out the run (WS-24, SC-14). */
  modelTimeoutMs?: number;
  /** Total-run deadline across all iterations. Exceeding it times out the run
   *  (WS-24, SC-14). Composed in `executePreparedRun`. */
  totalRunMs?: number;
  memoryStrategy?: 'last_n' | 'summary';
  lastN?: number;
};

export type RunContext = {
  sessionId: string;
  runId: string;
  agentConfig: AgentRecord;
  abortSignal: AbortSignal;
  iterationCount: number;
  // Executor resolved once per run from `agentConfig`, bound to this run only.
  // The loop reads it here (not from deps) so cross-routing between concurrent
  // agents is structurally impossible (WS-21, SC-07).
  toolExecutor: ToolExecutor;
};
