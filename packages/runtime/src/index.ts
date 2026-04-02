export const PACKAGE_NAME = 'runtime' as const;

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
