import { fetch as undiciFetch } from 'undici';
import {
  RUNNER_PROTOCOL_VERSION,
  RUNNER_MAX_INPUT_BYTES,
  RUNNER_MAX_OUTPUT_BYTES,
  RunnerSuccessResponseSchema,
  RunnerErrorResponseSchema,
  isSwiftAgentError,
  type RunnerRequest,
} from '@swiftagent/shared';
import type {
  ToolExecutor,
  ToolCall,
  ToolCallContext,
  ToolCallResult,
} from './tool-executor.js';
import {
  resolveAllowedOutboundTarget,
  createPinnedDispatcher,
  type OutboundUrlPolicy,
} from './ssrf.js';

export interface RemoteToolExecutorOptions {
  toolRunnerUrl: string;
  /** Resolved agent id — bound into request context and (via mintToken) the signed token. */
  agentId: string;
  /** Outbound SSRF policy applied to every request (SC-09). */
  policy: OutboundUrlPolicy;
  /**
   * Mints the per-call scoped bearer token (SC-08). Closes over the resolved
   * agent/workspace and the private signing key, so the raw workspace API key is
   * never used as the runner credential. Called once per attempt-set (reused
   * across transport retries so the signed scope is stable).
   */
  mintToken: (call: ToolCall, ctx: ToolCallContext) => Promise<string>;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 1_000;

/**
 * HTTP {@link ToolExecutor} for the secure remote SDK-runner boundary (WS-22).
 *
 * Every invocation: validates the outbound target and pins the connection to the
 * validated IP (SSRF/rebinding-safe), bounds request/response payloads, sends a
 * versioned envelope with a stable idempotency key (the `tc_` call id), mints a
 * short-lived asymmetric bearer token, and validates the runner's response
 * shape. `execute` never throws — every failure maps to a structured
 * {@link ToolCallResult}.
 */
export class RemoteToolExecutor implements ToolExecutor {
  private readonly toolRunnerUrl: string;
  private readonly agentId: string;
  private readonly policy: OutboundUrlPolicy;
  private readonly mintToken: (call: ToolCall, ctx: ToolCallContext) => Promise<string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(opts: RemoteToolExecutorOptions) {
    this.toolRunnerUrl = opts.toolRunnerUrl.replace(/\/+$/, '');
    this.agentId = opts.agentId;
    this.policy = opts.policy;
    this.mintToken = opts.mintToken;
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

    // ── Bound the input BEFORE sending (SC-09) ────────────────────────────────
    const inputJson = JSON.stringify(call.arguments ?? null);
    if (Buffer.byteLength(inputJson, 'utf-8') > RUNNER_MAX_INPUT_BYTES) {
      return { ok: false, error: 'Tool input exceeds limit' };
    }

    // ── Versioned request envelope (SC-05 identity, SC-08 scope, SC-10 key) ───
    const request: RunnerRequest = {
      version: RUNNER_PROTOCOL_VERSION,
      idempotencyKey: call.callId,
      input: call.arguments,
      context: {
        sessionId: ctx.sessionId,
        agentId: this.agentId,
        runId: ctx.runId,
        callId: call.callId,
        userId: ctx.userId,
        metadata: ctx.metadata,
      },
    };
    const body = JSON.stringify(request);

    // ── SSRF validation + IP pinning (SC-09) ──────────────────────────────────
    let target: { url: URL; pinnedIp: string };
    try {
      target = await resolveAllowedOutboundTarget(
        `${this.toolRunnerUrl}/tools/${encodeURIComponent(call.toolName)}`,
        this.policy,
      );
    } catch (err) {
      return { ok: false, error: this.messageOf(err) };
    }

    // ── Per-call scoped bearer token (SC-08) ──────────────────────────────────
    let token: string;
    try {
      token = await this.mintToken(call, ctx);
    } catch (err) {
      return { ok: false, error: `Failed to mint runner credentials: ${this.messageOf(err)}` };
    }

    const dispatcher = createPinnedDispatcher(target.pinnedIp);
    try {
      return await this.sendWithRetries(target.url, body, token, dispatcher, signal);
    } finally {
      // Release the pooled socket; ignore teardown races.
      void Promise.resolve(dispatcher.close()).catch(() => dispatcher.destroy());
    }
  }

  private async sendWithRetries(
    url: URL,
    body: string,
    token: string,
    dispatcher: ReturnType<typeof createPinnedDispatcher>,
    signal: AbortSignal,
  ): Promise<ToolCallResult> {
    const totalAttempts = 1 + this.maxRetries;
    let lastError = '';

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      // Per-attempt deadline so a retry (reusing the same idempotency key) gets a
      // fresh window; the runner de-dups so replay cannot double-execute (SC-10).
      const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);

      let terminal: ToolCallResult | null = null;
      try {
        const response = await undiciFetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body,
          signal: attemptSignal,
          dispatcher,
        });

        const text = await this.readBoundedText(
          response.body as ReadableStream<Uint8Array> | null,
          RUNNER_MAX_OUTPUT_BYTES,
        );
        if (text === null) {
          return { ok: false, error: 'Tool runner response exceeds limit' };
        }

        const outcome = this.interpret(response.status, text);
        if (outcome.kind === 'done') return outcome.result;
        // Retryable 5xx / malformed-5xx — remember and fall through to retry.
        lastError = outcome.error;
      } catch (err) {
        if (this.isAbortError(err)) {
          if (signal.aborted) {
            terminal = { ok: false, error: 'Aborted' };
          } else {
            lastError = 'Tool execution timed out'; // per-attempt timeout — retryable
          }
        } else {
          lastError = `Connection error: ${this.messageOf(err)}`;
        }
      }
      if (terminal) return terminal;

      if (attempt < totalAttempts) {
        await this.delay(this.retryDelayMs);
        if (signal.aborted) return { ok: false, error: 'Aborted' };
      }
    }

    return {
      ok: false,
      error: `Tool runner unreachable after ${totalAttempts} attempts: ${lastError}`,
    };
  }

  /**
   * Map an HTTP status + raw body to either a terminal result or a retryable
   * error string. 2xx and 4xx are terminal; 5xx (and unparseable 5xx) retry.
   */
  private interpret(
    status: number,
    text: string,
  ): { kind: 'done'; result: ToolCallResult } | { kind: 'retry'; error: string } {
    let json: unknown;
    try {
      json = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      if (status >= 500) return { kind: 'retry', error: `HTTP ${status}: malformed response` };
      return { kind: 'done', result: { ok: false, error: 'Invalid runner response' } };
    }

    if (status >= 200 && status < 300) {
      const ok = RunnerSuccessResponseSchema.safeParse(json);
      if (ok.success) return { kind: 'done', result: { ok: true, output: ok.data.result } };
      const asError = RunnerErrorResponseSchema.safeParse(json);
      if (asError.success) {
        return { kind: 'done', result: { ok: false, error: asError.data.error.message } };
      }
      return { kind: 'done', result: { ok: false, error: 'Invalid runner response' } };
    }

    // Non-2xx — surface the runner's structured error message if present.
    const parsed = RunnerErrorResponseSchema.safeParse(json);
    const message = parsed.success
      ? parsed.data.error.message
      : `Tool runner returned ${status}`;

    if (status >= 400 && status < 500) {
      return { kind: 'done', result: { ok: false, error: message } };
    }
    return { kind: 'retry', error: message };
  }

  /** Read a web stream into text, returning null if it exceeds `maxBytes`. */
  private async readBoundedText(
    body: ReadableStream<Uint8Array> | null,
    maxBytes: number,
  ): Promise<string | null> {
    if (!body) return '';
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            return null;
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks).toString('utf-8');
  }

  private isAbortError(err: unknown): boolean {
    return (
      (err instanceof DOMException &&
        (err.name === 'AbortError' || err.name === 'TimeoutError')) ||
      (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'))
    );
  }

  private messageOf(err: unknown): string {
    if (isSwiftAgentError(err)) return err.message;
    if (err instanceof Error) {
      // undici wraps low-level socket errors in a `cause`.
      const cause = (err as { cause?: unknown }).cause;
      if (cause instanceof Error && cause.message) return cause.message;
      return err.message;
    }
    return String(err);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
