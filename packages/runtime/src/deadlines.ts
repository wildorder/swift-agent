import { SwiftAgentError, SwiftAgentErrorCode } from '@swiftagent/shared';

/**
 * Deadline composition for run lifecycle hardening (WS-24, SC-14).
 *
 * A run has three deadline scopes, and — per the definitive deadline policy —
 * ANY of them terminates the whole run as `timed_out`:
 *   - `total`  — the entire run may not exceed `totalRunMs`.
 *   - `model`  — a single model call may not exceed `modelTimeoutMs`.
 *   - `tool`   — a single tool call may not exceed `toolTimeoutMs`.
 *
 * Every deadline controller aborts with a {@link RunTimeoutError} as its
 * `reason` (never a bare `AbortSignal.timeout()`), so downstream code can
 * distinguish a timeout from a user cancellation purely by inspecting
 * `signal.reason instanceof RunTimeoutError`. A user `requestCancel` aborts
 * WITHOUT a `RunTimeoutError`, which is how the loop tells cancel from timeout.
 */

export type DeadlineScope = 'model' | 'tool' | 'total';

/**
 * The abort `reason` attached to every deadline controller. Extends
 * `SwiftAgentError` with code `TIMEOUT` and carries the `scope` that fired so
 * the loop can report which boundary the run exceeded.
 */
export class RunTimeoutError extends SwiftAgentError {
  readonly scope: DeadlineScope;

  constructor(scope: DeadlineScope, timeoutMs: number) {
    super(
      SwiftAgentErrorCode.TIMEOUT,
      `Run exceeded the ${scope} deadline of ${timeoutMs}ms`,
    );
    this.name = 'RunTimeoutError';
    this.scope = scope;
  }
}

export interface DisposableController {
  controller: AbortController;
  /** Clear the underlying timer. Idempotent; safe to call on every exit path. */
  dispose(): void;
}

export interface DisposableSignal {
  signal: AbortSignal;
  /** Clear the underlying timer. Idempotent; safe to call on every exit path. */
  dispose(): void;
}

/**
 * Arm an `AbortController` that aborts with `RunTimeoutError(scope, timeoutMs)`
 * after `timeoutMs`. A missing/zero/negative timeout yields a never-firing
 * controller (no timer) so callers can treat "unset" uniformly.
 */
function armController(scope: DeadlineScope, timeoutMs?: number): DisposableController {
  const controller = new AbortController();
  if (!timeoutMs || timeoutMs <= 0) {
    return { controller, dispose() {} };
  }
  const timer = setTimeout(() => {
    controller.abort(new RunTimeoutError(scope, timeoutMs));
  }, timeoutMs);
  // Never keep the process alive purely for a deadline timer.
  (timer as { unref?: () => void }).unref?.();
  let disposed = false;
  return {
    controller,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
    },
  };
}

/**
 * Create the total-run deadline controller. Its signal is merged with the
 * run/cancellation signal in `executePreparedRun` so a total-run timeout aborts
 * every supported operation and classifies as `timed_out`.
 */
export function createDeadlineController(totalRunMs?: number): DisposableController {
  return armController('total', totalRunMs);
}

/**
 * Derive a per-call deadline signal by merging `baseSignal` (the run signal,
 * already carrying cancellation + total-run deadline) with a fresh per-call
 * deadline. When `timeoutMs` is unset the base signal is returned unchanged
 * (no extra timer). Callers MUST `dispose()` on completion to clear the timer.
 */
export function deriveCallDeadline(
  baseSignal: AbortSignal,
  scope: 'model' | 'tool',
  timeoutMs?: number,
): DisposableSignal {
  if (!timeoutMs || timeoutMs <= 0) {
    return { signal: baseSignal, dispose() {} };
  }
  const { controller, dispose } = armController(scope, timeoutMs);
  return { signal: AbortSignal.any([baseSignal, controller.signal]), dispose };
}

/**
 * Resolve the `RunTimeoutError` a signal aborted with, if any. Returns
 * `undefined` for a non-aborted signal or one aborted for a non-timeout reason
 * (e.g. a user cancellation).
 */
export function timeoutReason(signal: AbortSignal): RunTimeoutError | undefined {
  return signal.reason instanceof RunTimeoutError ? signal.reason : undefined;
}
