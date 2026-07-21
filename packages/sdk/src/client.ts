import { z } from 'zod';
import {
  AgentRecordSchema,
  SessionRecordSchema,
  MessageRecordSchema,
  RunRecordSchema,
  assertProtocolCompatible,
  PROTOCOL_HEADER,
  SwiftAgentError,
  SwiftAgentErrorCode,
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

/** Request context threaded into the actionable HTTP-error message. */
interface RequestContext {
  method: string;
  path: string;
  baseUrl: string;
}

/**
 * Inverse of `CODE_TO_STATUS` for the ranges the control plane returns (WS-41).
 * An unlisted status falls back to VALIDATION (<500) or INTERNAL (>=500).
 */
function statusToCode(status: number): SwiftAgentErrorCode {
  switch (status) {
    case 400:
      return SwiftAgentErrorCode.VALIDATION;
    case 401:
      return SwiftAgentErrorCode.UNAUTHORIZED;
    case 403:
      return SwiftAgentErrorCode.FORBIDDEN;
    case 404:
      return SwiftAgentErrorCode.NOT_FOUND;
    case 409:
      return SwiftAgentErrorCode.CONFLICT;
    case 429:
      return SwiftAgentErrorCode.RATE_LIMIT;
    case 502:
      return SwiftAgentErrorCode.PROVIDER_ERROR;
    case 503:
      return SwiftAgentErrorCode.CONNECTION_ERROR;
    case 504:
      return SwiftAgentErrorCode.TIMEOUT;
    default:
      return status >= 500 ? SwiftAgentErrorCode.INTERNAL : SwiftAgentErrorCode.VALIDATION;
  }
}

/** Per-code, one-sentence remediation hint. Keeps the raw status/path in `.cause`. */
function remediation(code: SwiftAgentErrorCode, where: string, status: number): string {
  switch (code) {
    case SwiftAgentErrorCode.UNAUTHORIZED:
      return `Authentication failed for ${where} — check the workspace API key passed to createAgentApp({ apiKey }) (e.g. SWIFT_AGENT_API_KEY).`;
    case SwiftAgentErrorCode.FORBIDDEN:
      return `The API key lacks permission for ${where} — check the key's workspace scope.`;
    case SwiftAgentErrorCode.NOT_FOUND:
      return `${where} not found — verify the session/agent/run id.`;
    case SwiftAgentErrorCode.CONFLICT:
      return `${where} conflicts with existing state — the resource already exists or is in a conflicting state.`;
    case SwiftAgentErrorCode.RATE_LIMIT:
      return `Rate limited on ${where} — retry after backing off.`;
    case SwiftAgentErrorCode.VALIDATION:
      return `The Swift Agent server rejected ${where} (HTTP ${status}) — check the request payload.`;
    case SwiftAgentErrorCode.PROVIDER_ERROR:
      return `The model provider or an upstream dependency failed for ${where} (HTTP ${status}) — retry.`;
    case SwiftAgentErrorCode.CONNECTION_ERROR:
      return `An upstream dependency was unavailable for ${where} (HTTP ${status}) — retry.`;
    case SwiftAgentErrorCode.TIMEOUT:
      return `${where} timed out upstream (HTTP ${status}) — retry.`;
    default:
      return `The Swift Agent server encountered an internal error on ${where} (HTTP ${status}) — retry; if persistent, contact support.`;
  }
}

/** Extract a structured `{ code, message }` from a server error body, if present. */
function readServerError(body: unknown): { code?: string; message?: string } {
  if (!body || typeof body !== 'object') return {};
  // The API/runner emit either `{ code, message }` or `{ error: { code, message } }`.
  const record = body as Record<string, unknown>;
  const nested = record.error;
  const source = (nested && typeof nested === 'object' ? nested : record) as Record<string, unknown>;
  return {
    code: typeof source.code === 'string' ? source.code : undefined,
    message: typeof source.message === 'string' ? source.message : undefined,
  };
}

/**
 * Map a non-2xx `SdkHttpError` to a typed, actionable `SwiftAgentError` (WS-41).
 *
 * Honors a known server `code` over the status-derived one, folds in the server
 * `message` when present, and preserves the original `SdkHttpError` (which still
 * carries `.status`/`.body`) as `.cause` so no wire context is lost.
 */
function httpErrorToSwiftAgentError(err: SdkHttpError, ctx: RequestContext): SwiftAgentError {
  const where = `${ctx.method} ${ctx.path}`;
  const { code: serverCode, message: serverMessage } = readServerError(err.body);
  const knownServerCode =
    serverCode && serverCode in SwiftAgentErrorCode
      ? (serverCode as SwiftAgentErrorCode)
      : undefined;
  const code = knownServerCode ?? statusToCode(err.status);

  let message = remediation(code, where, err.status);
  if (serverMessage) message += ` Server said: "${serverMessage}".`;

  // statusCode reflects the actual HTTP status the server returned (wire truth).
  return new SwiftAgentError(code, message, { cause: err, statusCode: err.status });
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

    // A rejected fetch is a transport failure (DNS / ECONNREFUSED / abort), not
    // an HTTP status. Surface it as a typed CONNECTION_ERROR/TIMEOUT naming the
    // baseUrl, preserving the raw rejection as `.cause` (WS-41).
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      const aborted =
        err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
      if (aborted) {
        throw new SwiftAgentError(
          SwiftAgentErrorCode.TIMEOUT,
          `The request to ${url} timed out.`,
          { cause: err },
        );
      }
      throw new SwiftAgentError(
        SwiftAgentErrorCode.CONNECTION_ERROR,
        `Could not reach the Swift Agent server at ${this.baseUrl} — is it running and is baseUrl correct?`,
        { cause: err },
      );
    }

    const responseBody: unknown = await res.json().catch(() => null);

    if (!res.ok) {
      // Build the internal wire error, then immediately map it to a typed,
      // actionable SwiftAgentError. The SdkHttpError is preserved as `.cause`
      // (it still carries `.status`/`.body` for advanced callers).
      const httpError = new SdkHttpError(
        `HTTP ${res.status} ${res.statusText}: ${method} ${path}`,
        res.status,
        responseBody,
      );
      throw httpErrorToSwiftAgentError(httpError, { method, path, baseUrl: this.baseUrl });
    }

    // Response headers are returned alongside the body so control-plane version
    // advertisement (the additive `x-swiftagent-protocol` header) is reachable by
    // `registerAgent`/`createSession` without a second request (WS-37).
    return { body: responseBody, headers: res.headers };
  }
}
