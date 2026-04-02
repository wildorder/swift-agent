import type {
  ToolExecutor,
  ToolCall,
  ToolCallContext,
  ToolCallResult,
} from './tool-executor.js';

export type ToolHandler = (
  input: unknown,
  ctx: ToolCallContext,
) => Promise<unknown>;

export interface LocalToolExecutorOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class LocalToolExecutor implements ToolExecutor {
  private readonly handlers = new Map<string, ToolHandler>();
  private readonly timeoutMs: number;

  constructor(opts: LocalToolExecutorOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  registerTool(name: string, handler: ToolHandler): void {
    if (this.handlers.has(name)) {
      throw new Error(`Tool already registered: ${name}`);
    }
    this.handlers.set(name, handler);
  }

  async execute(
    call: ToolCall,
    ctx: ToolCallContext,
    signal: AbortSignal,
  ): Promise<ToolCallResult> {
    if (signal.aborted) {
      return { ok: false, error: 'Aborted' };
    }

    const handler = this.handlers.get(call.toolName);
    if (!handler) {
      return { ok: false, error: `Unknown tool: ${call.toolName}` };
    }

    try {
      const result = await Promise.race([
        handler(call.arguments, ctx),
        this.createTimeoutPromise(),
        this.createAbortPromise(signal),
      ]);

      // Sentinel values from race losers
      if (result === TIMEOUT_SENTINEL) {
        return {
          ok: false,
          error: `Tool execution timed out after ${this.timeoutMs}ms`,
        };
      }
      if (result === ABORT_SENTINEL) {
        return { ok: false, error: 'Aborted' };
      }

      return { ok: true, output: result };
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  private createTimeoutPromise(): Promise<typeof TIMEOUT_SENTINEL> {
    return new Promise((resolve) => {
      setTimeout(() => resolve(TIMEOUT_SENTINEL), this.timeoutMs);
    });
  }

  private createAbortPromise(
    signal: AbortSignal,
  ): Promise<typeof ABORT_SENTINEL> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve(ABORT_SENTINEL);
        return;
      }
      signal.addEventListener('abort', () => resolve(ABORT_SENTINEL), {
        once: true,
      });
    });
  }
}

const TIMEOUT_SENTINEL = Symbol('timeout');
const ABORT_SENTINEL = Symbol('abort');
