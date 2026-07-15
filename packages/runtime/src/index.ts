export const PACKAGE_NAME = 'runtime' as const;

// Tool executor (WS-05a)
export type {
  ToolExecutor,
  ToolCall,
  ToolCallContext,
  ToolCallResult,
} from './tool-executor.js';

export { LocalToolExecutor } from './tool-executor-local.js';
export type { ToolHandler, LocalToolExecutorOptions } from './tool-executor-local.js';

export { RemoteToolExecutor } from './tool-executor-remote.js';
export type { RemoteToolExecutorOptions } from './tool-executor-remote.js';

export { createToolExecutor } from './tool-executor-factory.js';

// Types (WS-05b)
export type {
  AgentEngineDeps,
  AgentEngineOptions,
  RunContext,
  Logger,
  Tracer,
} from './types.js';
export {
  DEFAULT_MAX_TOOL_ITERATIONS,
  DEFAULT_TOOL_TIMEOUT_MS,
  DEFAULT_LAST_N,
} from './types.js';

// Memory strategies
export type { MemoryStrategyImpl } from './memory/strategy.js';
export type { MemoryStrategyName } from './memory/strategy.js';
export { createMemoryStrategy } from './memory/strategy.js';
export { LastNMemoryStrategy } from './memory/last-n.js';
export { SummaryMemoryStrategy } from './memory/summary.js';

// Context builder
export { ContextBuilder } from './context-builder.js';
export type { ToolMessageContent } from './context-builder.js';

// Tool mapping + validation (WS-20)
export { toModelToolSchemas, buildToolIndex } from './tool-mapping.js';
export type { ToolIndexEntry } from './tool-mapping.js';
export { validateToolCall } from './tool-validation.js';
export type { ToolValidationResult } from './tool-validation.js';

// Session lock
export { SessionLock, RUN_IN_PROGRESS } from './session-lock.js';

// Core loop
export { runAgentLoop } from './loop.js';

// Agent engine
export { AgentEngine } from './engine.js';
