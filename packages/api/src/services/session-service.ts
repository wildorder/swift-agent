import type { SessionRepo, MessageRepo, RunRepo } from '@swiftagent/db';
import type { RunExecutionService } from '@swiftagent/runtime';
import type { SessionRecord, MessageRecord, RunRecord, SessionStatus } from '@swiftagent/shared';
import { generateSessionId, SwiftAgentError } from '@swiftagent/shared';
import type { AgentService } from './agent-service.js';

export interface SessionService {
  createSession(params: {
    workspaceId: string;
    agentName: string;
    userId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ session: SessionRecord; agentId: string }>;
  getSession(workspaceId: string, sessionId: string): Promise<SessionRecord>;
  updateSession(workspaceId: string, sessionId: string, updates: { status?: SessionStatus }): Promise<SessionRecord>;
  listMessages(sessionId: string, opts: { limit: number; cursor?: string }): Promise<MessageRecord[]>;
  /**
   * Create + start a run via the unified execution service. Returns the runId
   * once the run row exists; execution proceeds process-bound (SC-11/SC-12).
   */
  createRun(params: {
    workspaceId: string;
    sessionId: string;
    content: string;
  }): Promise<{ runId: string }>;
  getRun(workspaceId: string, runId: string): Promise<RunRecord>;
  getRunToolCalls(workspaceId: string, runId: string): Promise<unknown[]>;
  /** Idempotent cancellation request for an owned run. */
  requestCancel(workspaceId: string, runId: string): Promise<{ requested: boolean }>;
}

export function createSessionService(deps: {
  sessionRepo: SessionRepo;
  messageRepo: MessageRepo;
  runRepo: RunRepo;
  toolCallRepo: { listByRun(runId: string): Promise<unknown[]> };
  agentService: AgentService;
  runExecutionService: RunExecutionService;
}): SessionService {
  const { sessionRepo, messageRepo, runRepo, toolCallRepo, agentService, runExecutionService } = deps;

  /**
   * Resolve a run and assert it belongs to `workspaceId` via
   * run → session → agent → workspace. Throws `NOT_FOUND` if the run is missing
   * OR owned by another workspace — the two are never distinguished, so run
   * existence is not leaked across tenants.
   */
  async function assertRunOwnership(
    workspaceId: string,
    runId: string,
  ): Promise<RunRecord> {
    const run = await runRepo.getById(runId);
    if (!run) {
      throw new SwiftAgentError('NOT_FOUND', `Run ${runId} not found`);
    }
    const session = await sessionRepo.getById(run.sessionId);
    if (!session) {
      throw new SwiftAgentError('NOT_FOUND', `Run ${runId} not found`);
    }
    try {
      await agentService.getById(workspaceId, session.agentId);
    } catch {
      throw new SwiftAgentError('NOT_FOUND', `Run ${runId} not found`);
    }
    return run;
  }

  return {
    async createSession({ workspaceId, agentName, userId, metadata }) {
      const agent = await agentService.getByName(workspaceId, agentName);

      const session = await sessionRepo.create({
        sessionId: generateSessionId(),
        agentId: agent.agentId,
        userId: userId ?? null,
        metadata: metadata ?? {},
      });

      return { session, agentId: agent.agentId };
    },

    async getSession(workspaceId, sessionId) {
      const session = await sessionRepo.getById(sessionId);
      if (!session) {
        throw new SwiftAgentError('NOT_FOUND', `Session ${sessionId} not found`);
      }
      // Verify the session belongs to this workspace via the agent
      try {
        await agentService.getById(workspaceId, session.agentId);
      } catch {
        throw new SwiftAgentError('NOT_FOUND', `Session ${sessionId} not found`);
      }
      return session;
    },

    async updateSession(workspaceId, sessionId, updates) {
      // Verify ownership first
      await this.getSession(workspaceId, sessionId);

      if (updates.status) {
        const updated = await sessionRepo.updateStatus(sessionId, updates.status);
        if (!updated) {
          throw new SwiftAgentError('INTERNAL', 'Failed to update session');
        }
        return updated;
      }

      // No actual update requested, return current
      return this.getSession(workspaceId, sessionId);
    },

    async listMessages(sessionId, opts) {
      const allMessages = await messageRepo.listBySession(sessionId);

      // Cursor-based pagination: cursor is a messageId, return messages after it
      let startIdx = 0;
      if (opts.cursor) {
        const cursorIdx = allMessages.findIndex((m) => m.messageId === opts.cursor);
        if (cursorIdx === -1) {
          throw new SwiftAgentError('VALIDATION', 'Invalid cursor');
        }
        startIdx = cursorIdx + 1;
      }

      return allMessages.slice(startIdx, startIdx + opts.limit);
    },

    async createRun({ workspaceId, sessionId, content }) {
      // Verify session ownership before touching the runtime. The execution
      // service owns run-id + user-message persistence and starts execution.
      await this.getSession(workspaceId, sessionId);
      return runExecutionService.start({ sessionId, content });
    },

    async getRun(workspaceId, runId) {
      return assertRunOwnership(workspaceId, runId);
    },

    async getRunToolCalls(workspaceId, runId) {
      await assertRunOwnership(workspaceId, runId);
      return toolCallRepo.listByRun(runId);
    },

    async requestCancel(workspaceId, runId) {
      await assertRunOwnership(workspaceId, runId);
      return runExecutionService.requestCancel(runId);
    },
  };
}
