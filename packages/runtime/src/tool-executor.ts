/**
 * Tool executor interface and shared types.
 * Implementations: LocalToolExecutor (in-process) and RemoteToolExecutor (HTTP).
 */

export type ToolCallResult =
  | { ok: true; output: unknown }
  | { ok: false; error: string };

export type ToolCallContext = {
  sessionId: string;
  runId: string;
  userId?: string;
  metadata?: Record<string, unknown>;
};

export type ToolCall = {
  toolName: string;
  callId: string;
  arguments: unknown;
};

export interface ToolExecutor {
  execute(
    call: ToolCall,
    ctx: ToolCallContext,
    signal: AbortSignal,
  ): Promise<ToolCallResult>;
}
