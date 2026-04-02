import type { SessionRepo, MessageRepo, RunRepo } from '@swiftagent/db';
import type { SessionRecord, MessageRecord, RunRecord, SessionStatus } from '@swiftagent/shared';
import { generateSessionId, generateRunId, generateMessageId, SwiftAgentError } from '@swiftagent/shared';
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
  createRun(params: {
    workspaceId: string;
    sessionId: string;
    content: string;
  }): Promise<{ run: RunRecord; message: MessageRecord }>;
  getRun(runId: string): Promise<RunRecord>;
  getRunToolCalls(runId: string): Promise<unknown[]>;
}

export function createSessionService(deps: {
  sessionRepo: SessionRepo;
  messageRepo: MessageRepo;
  runRepo: RunRepo;
  toolCallRepo: { listByRun(runId: string): Promise<unknown[]> };
  agentService: AgentService;
}): SessionService {
  const { sessionRepo, messageRepo, runRepo, toolCallRepo, agentService } = deps;

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
      const session = await this.getSession(workspaceId, sessionId);

      // Resolve the agent to get the model
      const agent = await agentService.getById(workspaceId, session.agentId);

      const run = await runRepo.create({
        runId: generateRunId(),
        sessionId,
        model: agent.modelConfig.model,
      });

      const message = await messageRepo.create({
        messageId: generateMessageId(),
        sessionId,
        runId: run.runId,
        role: 'user',
        content,
      });

      return { run, message };
    },

    async getRun(runId) {
      const run = await runRepo.getById(runId);
      if (!run) {
        throw new SwiftAgentError('NOT_FOUND', `Run ${runId} not found`);
      }
      return run;
    },

    async getRunToolCalls(runId) {
      // Ensure run exists
      await this.getRun(runId);
      return toolCallRepo.listByRun(runId);
    },
  };
}
