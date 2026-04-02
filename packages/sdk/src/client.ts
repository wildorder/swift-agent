import {
  AgentRecordSchema,
  SessionRecordSchema,
  MessageRecordSchema,
  RunRecordSchema,
} from '@swiftagent/shared';
import type {
  AgentRecord,
  SessionRecord,
  MessageRecord,
  RunRecord,
} from '@swiftagent/shared';
import { SdkHttpError } from './types.js';
import type {
  CreateSessionResult,
  ListMessagesResult,
} from './types.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';

interface RegisterAgentBody {
  name: string;
  modelConfig: {
    model: string;
    temperature?: number;
    maxTokens?: number;
  };
  systemPrompt: string;
  memoryConfig?: {
    strategy: 'last_n' | 'summary';
    maxMessages?: number;
  };
  toolRunnerUrl?: string | null;
}

interface CreateSessionBody {
  agentName: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

interface CreateRunBody {
  content: string;
}

interface ListMessagesParams {
  limit?: number;
  cursor?: string;
}

export class ControlPlaneClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  // ── Agent ───────────────────────────────────────────────────────

  async registerAgent(body: RegisterAgentBody): Promise<AgentRecord> {
    const res = await this.request('POST', '/v1/agents', body);
    return AgentRecordSchema.parse(res);
  }

  async getAgent(agentId: string): Promise<AgentRecord> {
    const res = await this.request('GET', `/v1/agents/${encodeURIComponent(agentId)}`);
    return AgentRecordSchema.parse(res);
  }

  async getAgentByName(name: string): Promise<AgentRecord> {
    const res = await this.request('GET', `/v1/agents?name=${encodeURIComponent(name)}`);
    return AgentRecordSchema.parse(res);
  }

  // ── Session ─────────────────────────────────────────────────────

  async createSession(body: CreateSessionBody): Promise<CreateSessionResult> {
    const res = await this.request('POST', '/v1/sessions', body);
    return res as CreateSessionResult;
  }

  async getSession(sessionId: string): Promise<SessionRecord> {
    const res = await this.request('GET', `/v1/sessions/${encodeURIComponent(sessionId)}`);
    return SessionRecordSchema.parse(res);
  }

  // ── Messages ────────────────────────────────────────────────────

  async listMessages(sessionId: string, params?: ListMessagesParams): Promise<ListMessagesResult> {
    const qs = new URLSearchParams();
    if (params?.limit !== undefined) qs.set('limit', String(params.limit));
    if (params?.cursor) qs.set('cursor', params.cursor);

    const query = qs.toString();
    const path = `/v1/sessions/${encodeURIComponent(sessionId)}/messages${query ? `?${query}` : ''}`;
    const res = await this.request('GET', path);

    const body = res as { data: unknown[]; hasMore: boolean };
    return {
      data: body.data.map((m) => MessageRecordSchema.parse(m)),
      hasMore: body.hasMore,
    };
  }

  // ── Runs ────────────────────────────────────────────────────────

  async createRun(sessionId: string, body: CreateRunBody): Promise<RunRecord> {
    const res = await this.request(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/runs`,
      body,
    );
    return RunRecordSchema.parse(res);
  }

  async getRun(runId: string): Promise<RunRecord> {
    const res = await this.request('GET', `/v1/runs/${encodeURIComponent(runId)}`);
    return RunRecordSchema.parse(res);
  }

  // ── Internal ────────────────────────────────────────────────────

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Accept': 'application/json',
    };

    const init: RequestInit = { method, headers };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);
    const responseBody: unknown = await res.json().catch(() => null);

    if (!res.ok) {
      throw new SdkHttpError(
        `HTTP ${res.status} ${res.statusText}: ${method} ${path}`,
        res.status,
        responseBody,
      );
    }

    return responseBody;
  }
}
