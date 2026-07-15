import {
  generateRunId,
  generateMessageId,
  type ChatEvent,
} from '@swiftagent/shared';
import { AgentEngine, resolveRunPrereqs } from './engine.js';
import { SessionLock } from './session-lock.js';
import type { AgentEngineDeps, AgentEngineOptions } from './types.js';

/**
 * ── Execution model ──────────────────────────────────────────────────────
 * Execution is PROCESS-BOUND. A run lives entirely in the memory of the
 * process that started it: its `AbortController` sits in the in-process
 * `activeRuns` registry and its session lock is held by this service instance.
 * A process restart therefore ABANDONS every in-flight run — its run row is
 * left in whatever non-terminal state it reached and no recovery is attempted.
 * Durable execution + restart recovery is explicitly deferred to Phase 2.
 */

export interface StartRunInput {
  sessionId: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface StartRunOptions {
  /** Streaming sink (gateway). When provided, `start` drives the run to a
   *  terminal state, forwarding every event; when omitted (REST), execution is
   *  fire-and-forget and observed through persisted state. */
  onEvent?: (event: ChatEvent) => void;
  /** External abort signal, merged with the service-owned cancel signal. */
  signal?: AbortSignal;
}

export interface RunExecutionService {
  /**
   * Create the run + user message eagerly, return the `runId`, and start
   * process-bound execution. The run row exists before this resolves so REST
   * callers can `202` and immediately poll. Throws `SwiftAgentError(CONFLICT)`
   * if the session already has an active run.
   */
  start(input: StartRunInput, opts?: StartRunOptions): Promise<{ runId: string }>;
  /** Idempotent cancellation request for an in-flight run. */
  requestCancel(runId: string): Promise<{ requested: boolean }>;
}

/**
 * The single authority for run execution across REST and the gateway. It owns
 * the `runId`, the session lock, and the `activeRuns` registry, so concurrent
 * runs on one session conflict regardless of entry point and cancellation can
 * always locate the in-flight run.
 */
export function createRunExecutionService(
  deps: AgentEngineDeps,
  options?: AgentEngineOptions,
): RunExecutionService {
  const engine = new AgentEngine(deps, options);
  const sessionLock = new SessionLock();
  const activeRuns = new Map<string, AbortController>();

  async function drive(
    runId: string,
    input: StartRunInput,
    userMessageId: string,
    abort: AbortController,
    opts: StartRunOptions | undefined,
  ): Promise<void> {
    const signal = opts?.signal
      ? AbortSignal.any([opts.signal, abort.signal])
      : abort.signal;

    try {
      for await (const event of engine.executePreparedRun(
        runId,
        input.sessionId,
        input.content,
        userMessageId,
        signal,
      )) {
        opts?.onEvent?.(event);
      }
    } finally {
      // Always release the lock + registry slot, on every exit path, so a
      // failed/cancelled run never wedges the session.
      activeRuns.delete(runId);
      sessionLock.release(input.sessionId, runId);
    }
  }

  return {
    async start(input, opts) {
      const runId = generateRunId();
      // Acquire the lock BEFORE any persistence so a losing concurrent starter
      // throws CONFLICT without creating an orphan run row.
      sessionLock.acquire(input.sessionId, runId);

      const abort = new AbortController();
      activeRuns.set(runId, abort);

      let userMessageId: string;
      try {
        // Validate + resolve the model, then create the run row and user
        // message ONCE (this service is the sole owner). The loop skips both.
        const { agentConfig } = await resolveRunPrereqs(deps, input.sessionId);
        await deps.db.runs.create({
          runId,
          sessionId: input.sessionId,
          model: agentConfig.modelConfig.model,
        });
        userMessageId = generateMessageId();
        await deps.db.messages.create({
          messageId: userMessageId,
          sessionId: input.sessionId,
          runId,
          role: 'user',
          content: input.content,
        });
      } catch (err) {
        // Setup failed before execution began — free the lock/registry so the
        // session is not wedged, then surface the error to the caller.
        activeRuns.delete(runId);
        sessionLock.release(input.sessionId, runId);
        throw err;
      }

      const running = drive(runId, input, userMessageId, abort, opts);
      if (opts?.onEvent) {
        // Streaming caller (gateway): await terminal state so it can finalize
        // its replay buffer once the run is fully drained.
        await running;
      } else {
        // REST: fire-and-forget. Swallow rejections — terminal state is
        // persisted by the loop and observed via GET /runs/:runId.
        void running.catch(() => {});
      }

      return { runId };
    },

    async requestCancel(runId) {
      const abort = activeRuns.get(runId);
      if (abort) {
        abort.abort();
      }
      // Idempotent: an unknown or already-terminal run (not in this process's
      // registry) still reports the request as accepted. Terminal `cancelled`
      // status is finalized in WS-24.
      return { requested: true };
    },
  };
}
