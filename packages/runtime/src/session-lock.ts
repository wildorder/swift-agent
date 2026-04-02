import { SwiftAgentError, SwiftAgentErrorCode } from '@swiftagent/shared';

type LockEntry = {
  runId: string;
  abort: AbortController;
};

export const RUN_IN_PROGRESS = 'RUN_IN_PROGRESS';

export class SessionLock {
  private readonly locks = new Map<string, LockEntry>();

  acquire(sessionId: string, runId: string): AbortController {
    const existing = this.locks.get(sessionId);
    if (existing) {
      throw new SwiftAgentError(
        SwiftAgentErrorCode.CONFLICT,
        `Session ${sessionId} already has an active run: ${existing.runId}`,
      );
    }

    const abort = new AbortController();
    this.locks.set(sessionId, { runId, abort });
    return abort;
  }

  release(sessionId: string, runId: string): void {
    const existing = this.locks.get(sessionId);
    if (existing && existing.runId === runId) {
      this.locks.delete(sessionId);
    }
  }

  isActive(sessionId: string): boolean {
    return this.locks.has(sessionId);
  }
}
