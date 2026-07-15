import {
  generateRunId,
  SwiftAgentError,
  SwiftAgentErrorCode,
  type AgentRecord,
  type ChatEvent,
} from '@swiftagent/shared';
import { SessionLock } from './session-lock.js';
import { runAgentLoop } from './loop.js';
import { createDeadlineController } from './deadlines.js';
import type { ToolExecutor } from './tool-executor.js';
import type { AgentEngineDeps, AgentEngineOptions } from './types.js';

/**
 * Load and validate the run prerequisites shared by every execution entry
 * point: the session must exist and be `active`, its agent must exist, and the
 * per-agent tool executor is resolved once. Centralised here so the legacy
 * `AgentEngine.run`, the lock-free `executePreparedRun`, and the
 * `RunExecutionService` never drift in how they validate a run.
 */
export async function resolveRunPrereqs(
  deps: AgentEngineDeps,
  sessionId: string,
): Promise<{ agentConfig: AgentRecord; toolExecutor: ToolExecutor }> {
  const session = await deps.db.sessions.getById(sessionId);
  if (!session) {
    throw new SwiftAgentError(
      SwiftAgentErrorCode.NOT_FOUND,
      `Session ${sessionId} not found`,
    );
  }
  if (session.status !== 'active') {
    throw new SwiftAgentError(
      SwiftAgentErrorCode.VALIDATION,
      `Session ${sessionId} is ${session.status}, not active`,
    );
  }

  const agentConfig = await deps.db.agents.getById(session.agentId);
  if (!agentConfig) {
    throw new SwiftAgentError(
      SwiftAgentErrorCode.NOT_FOUND,
      `Agent ${session.agentId} not found`,
    );
  }

  // Resolve the executor for THIS run's agent. Bound to this run only —
  // two agents with different runner configs resolve independent executors,
  // so calls can never cross-route (WS-21, SC-07).
  const toolExecutor = await deps.toolExecutorResolver.resolve(agentConfig);

  return { agentConfig, toolExecutor };
}

export class AgentEngine {
  private readonly deps: AgentEngineDeps;
  private readonly options: AgentEngineOptions;
  private readonly sessionLock: SessionLock;

  constructor(deps: AgentEngineDeps, options?: AgentEngineOptions) {
    this.deps = deps;
    this.options = options ?? {};
    this.sessionLock = new SessionLock();
  }

  /**
   * Legacy lock-owning entry point. Mints its own `runId`, self-locks the
   * session, and persists the run + user message via the loop. Retained for
   * existing callers/tests — it is the ONLY place the engine self-locks. The
   * unified REST + gateway path goes through `RunExecutionService`, which owns
   * the lock and the run-id, and drives `executePreparedRun` instead.
   */
  async *run(
    sessionId: string,
    userMessage: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatEvent> {
    const runId = generateRunId();

    // Acquire session lock — throws CONFLICT if already active
    const lockController = this.sessionLock.acquire(sessionId, runId);

    try {
      const { agentConfig, toolExecutor } = await resolveRunPrereqs(
        this.deps,
        sessionId,
      );

      // Merge abort signals: external signal + lock controller signal
      const mergedSignal = signal
        ? AbortSignal.any([signal, lockController.signal])
        : lockController.signal;

      const ctx = {
        sessionId,
        runId,
        agentConfig,
        abortSignal: mergedSignal,
        iterationCount: 0,
        toolExecutor,
      };

      // Delegate to runAgentLoop — legacy path owns run + user-message creation.
      yield* runAgentLoop(ctx, this.deps, userMessage, this.options);
    } finally {
      // Always release session lock
      this.sessionLock.release(sessionId, runId);
    }
  }

  /**
   * Lock-free execution for a run whose `runId`, run row, and user message have
   * already been created by the caller (the `RunExecutionService`). Does NOT
   * acquire the session lock and does NOT generate a `runId` — the caller owns
   * both, guaranteeing exactly one lock owner and one id owner per logical run.
   */
  async *executePreparedRun(
    runId: string,
    sessionId: string,
    userMessage: string,
    userMessageId: string,
    signal: AbortSignal,
  ): AsyncGenerator<ChatEvent> {
    const { agentConfig, toolExecutor } = await resolveRunPrereqs(
      this.deps,
      sessionId,
    );

    // Compose the total-run deadline here (WS-24) — lock-free, per WS-23 the
    // RunExecutionService is the sole SessionLock owner and passes the run's
    // cancellation signal in. Merge ONLY the supplied signal (already carrying
    // cancellation + any session-lock signal) with the total-run deadline; a
    // firing deadline aborts every supported operation with a RunTimeoutError so
    // the loop classifies it as `timed_out` rather than a user cancellation.
    const totalDeadline = createDeadlineController(this.options.totalRunMs);
    const abortSignal = AbortSignal.any([signal, totalDeadline.controller.signal]);

    const ctx = {
      sessionId,
      runId,
      agentConfig,
      abortSignal,
      iterationCount: 0,
      toolExecutor,
    };

    try {
      // The run row + user message already exist — the loop skips their creation.
      yield* runAgentLoop(ctx, this.deps, userMessage, this.options, {
        userMessageId,
      });
    } finally {
      // Always clear the deadline timer, on every exit path.
      totalDeadline.dispose();
    }
  }
}
