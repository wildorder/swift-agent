import type {
  ToolExecutor,
  ToolCall,
  ToolCallContext,
  ToolCallResult,
} from './tool-executor.js';

export interface RemoteToolExecutorOptions {
  toolRunnerUrl: string;
  authToken: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 1_000;

export class RemoteToolExecutor implements ToolExecutor {
  private readonly toolRunnerUrl: string;
  private readonly authToken: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(opts: RemoteToolExecutorOptions) {
    this.toolRunnerUrl = opts.toolRunnerUrl.replace(/\/+$/, '');
    this.authToken = opts.authToken;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  async execute(
    call: ToolCall,
    ctx: ToolCallContext,
    signal: AbortSignal,
  ): Promise<ToolCallResult> {
    if (signal.aborted) {
      return { ok: false, error: 'Aborted' };
    }

    const url = `${this.toolRunnerUrl}/tools/${call.toolName}`;
    const body = JSON.stringify({ input: call.arguments, context: ctx });

    const combinedSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(this.timeoutMs),
    ]);

    let lastError: string = '';
    const totalAttempts = 1 + this.maxRetries;

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.authToken}`,
          },
          body,
          signal: combinedSignal,
        });

        if (response.ok) {
          return this.parseSuccessResponse(await response.json());
        }

        // 4xx — client error, no retry
        if (response.status >= 400 && response.status < 500) {
          const text = await response.text().catch(() => '');
          return {
            ok: false,
            error: `Tool runner returned ${response.status}: ${text}`,
          };
        }

        // 5xx — server error, may retry
        const text = await response.text().catch(() => '');
        lastError = `HTTP ${response.status}: ${text}`;
      } catch (err: unknown) {
        if (this.isAbortError(err)) {
          if (signal.aborted) {
            return { ok: false, error: 'Aborted' };
          }
          return { ok: false, error: 'Tool execution timed out' };
        }
        lastError =
          err instanceof Error ? err.message : String(err);
      }

      // Delay before retry (but not after last attempt)
      if (attempt < totalAttempts) {
        await this.delay(this.retryDelayMs);
        if (combinedSignal.aborted) {
          if (signal.aborted) {
            return { ok: false, error: 'Aborted' };
          }
          return { ok: false, error: 'Tool execution timed out' };
        }
      }
    }

    return {
      ok: false,
      error: `Tool runner unreachable after ${totalAttempts} attempts: ${lastError}`,
    };
  }

  private parseSuccessResponse(json: unknown): ToolCallResult {
    const obj = json as Record<string, unknown>;
    if ('error' in obj && obj.error != null) {
      const errVal = obj.error;
      const message =
        typeof errVal === 'object' &&
        errVal !== null &&
        'message' in errVal
          ? String((errVal as Record<string, unknown>).message)
          : String(errVal);
      return { ok: false, error: message };
    }
    if ('result' in obj) {
      return { ok: true, output: obj.result };
    }
    // No result or error field — return body as output
    return { ok: true, output: json };
  }

  private isAbortError(err: unknown): boolean {
    return (
      err instanceof DOMException && err.name === 'AbortError' ||
      err instanceof DOMException && err.name === 'TimeoutError'
    );
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
