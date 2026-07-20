import { z } from 'zod';
import {
  AgentRecordSchema,
  SessionRecordSchema,
  MessageRecordSchema,
  RunRecordSchema,
  assertProtocolCompatible,
  PROTOCOL_HEADER,
} from '@swiftagent/shared';
import type {
  AgentRecord,
  SessionRecord,
  RunRecord,
} from '@swiftagent/shared';
import { SdkHttpError } from './types.js';
import type {
  AcceptedRun,
  CreateSessionResult,
  ListMessagesResult,
} from './types.js';

// The async run-creation / cancel endpoints return `{ runId, status }` (202),
// not a full RunRecord. Kept in lockstep with the API's AcceptedRunResponseSchema.
const AcceptedRunSchema = z.object({
  runId: z.string(),
  status: z.string(),
});

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
  tools?: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
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
    const { body: resBody, headers } = await this.request('POST', '/v1/agents', body);
    // Assert protocol compatibility BEFORE parsing the body so a version mismatch
    // is reported ahead of any body-shape error (the clearest "SDK/server disagree"
    // signal at the first authenticated control-plane call). Fails open when the
    // server advertises no version (legacy server → header absent).
    assertProtocolCompatible(headers.get(PROTOCOL_HEADER));
    return AgentRecordSchema.parse(resBody);
  }

  async getAgent(agentId: string): Promise<AgentRecord> {
    const { body } = await this.request('GET', `/v1/agents/${encodeURIComponent(agentId)}`);
    return AgentRecordSchema.parse(body);
  }

  async getAgentByName(name: string): Promise<AgentRecord> {
    const { body } = await this.request('GET', `/v1/agents?name=${encodeURIComponent(name)}`);
    return AgentRecordSchema.parse(body);
  }

  // ── Session ─────────────────────────────────────────────────────

  async createSession(body: CreateSessionBody): Promise<CreateSessionResult> {
    const { body: resBody, headers } = await this.request('POST', '/v1/sessions', body);
    // Surface the server-advertised protocol version (same `x-swiftagent-protocol`
    // header the onSend hook sets on every response) so the connect-time check in
    // @swiftagent/react can assert compatibility before opening the socket. The SDK
    // does NOT assert here — it stays a thin transport; `undefined` on a legacy server.
    return {
      ...(resBody as CreateSessionResult),
      serverProtocolVersion: headers.get(PROTOCOL_HEADER) ?? undefined,
    };
  }

  async getSession(sessionId: string): Promise<SessionRecord> {
    const { body } = await this.request('GET', `/v1/sessions/${encodeURIComponent(sessionId)}`);
    return SessionRecordSchema.parse(body);
  }

  // ── Messages ────────────────────────────────────────────────────

  async listMessages(sessionId: string, params?: ListMessagesParams): Promise<ListMessagesResult> {
    const qs = new URLSearchParams();
    if (params?.limit !== undefined) qs.set('limit', String(params.limit));
    if (params?.cursor) qs.set('cursor', params.cursor);

    const query = qs.toString();
    const path = `/v1/sessions/${encodeURIComponent(sessionId)}/messages${query ? `?${query}` : ''}`;
    const { body } = await this.request('GET', path);

    const parsed = body as { data: unknown[]; hasMore: boolean };
    return {
      data: parsed.data.map((m) => MessageRecordSchema.parse(m)),
      hasMore: parsed.hasMore,
    };
  }

  // ── Runs ────────────────────────────────────────────────────────

  async createRun(sessionId: string, body: CreateRunBody): Promise<AcceptedRun> {
    const { body: resBody } = await this.request(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/runs`,
      body,
    );
    return AcceptedRunSchema.parse(resBody);
  }

  async getRun(runId: string): Promise<RunRecord> {
    const { body } = await this.request('GET', `/v1/runs/${encodeURIComponent(runId)}`);
    return RunRecordSchema.parse(body);
  }

  async cancelRun(runId: string): Promise<AcceptedRun> {
    const { body } = await this.request(
      'POST',
      `/v1/runs/${encodeURIComponent(runId)}/cancel`,
    );
    return AcceptedRunSchema.parse(body);
  }

  // ── Internal ────────────────────────────────────────────────────

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ body: unknown; headers: Headers }> {
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

    // Response headers are returned alongside the body so control-plane version
    // advertisement (the additive `x-swiftagent-protocol` header) is reachable by
    // `registerAgent`/`createSession` without a second request (WS-37).
    return { body: responseBody, headers: res.headers };
  }
}
