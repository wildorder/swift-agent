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

export type Tracer = {
  startSpan(name: string, attributes?: Record<string, unknown>): void;
  endSpan(): void;
};

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
  toolTimeoutMs?: number;
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
