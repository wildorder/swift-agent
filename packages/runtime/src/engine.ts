import {
  generateRunId,
  SwiftAgentError,
  SwiftAgentErrorCode,
  type ChatEvent,
} from '@swiftagent/shared';
import { SessionLock } from './session-lock.js';
import { runAgentLoop } from './loop.js';
import type { AgentEngineDeps, AgentEngineOptions } from './types.js';

export class AgentEngine {
  private readonly deps: AgentEngineDeps;
  private readonly options: AgentEngineOptions;
  private readonly sessionLock: SessionLock;

  constructor(deps: AgentEngineDeps, options?: AgentEngineOptions) {
    this.deps = deps;
    this.options = options ?? {};
    this.sessionLock = new SessionLock();
  }

  async *run(
    sessionId: string,
    userMessage: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatEvent> {
    const runId = generateRunId();

    // Acquire session lock — throws CONFLICT if already active
    const lockController = this.sessionLock.acquire(sessionId, runId);

    try {
      // Validate session exists and is active
      const session = await this.deps.db.sessions.getById(sessionId);
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

      // Load agent config
      const agentConfig = await this.deps.db.agents.getById(session.agentId);
      if (!agentConfig) {
        throw new SwiftAgentError(
          SwiftAgentErrorCode.NOT_FOUND,
          `Agent ${session.agentId} not found`,
        );
      }

      // Merge abort signals: external signal + lock controller signal
      const mergedSignal = signal
        ? AbortSignal.any([signal, lockController.signal])
        : lockController.signal;

      // Build RunContext
      const ctx = {
        sessionId,
        runId,
        agentConfig,
        abortSignal: mergedSignal,
        iterationCount: 0,
      };

      // Delegate to runAgentLoop
      yield* runAgentLoop(ctx, this.deps, userMessage, this.options);
    } finally {
      // Always release session lock
      this.sessionLock.release(sessionId, runId);
    }
  }
}
