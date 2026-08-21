import type { ChatEvent } from '@swiftagent/shared';

// Re-export ChatEvent for consumers
export type { ChatEvent } from '@swiftagent/shared';

/** Connection lifecycle state */
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

/** Information about a single tool call within an assistant message */
export interface ToolCallInfo {
  callId: string;
  toolName: string;
  status: 'started' | 'completed' | 'failed';
}

/** A single chat message with streaming status */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  status: 'pending' | 'streaming' | 'complete';
  toolCalls?: ToolCallInfo[];
}

/** Configuration for reconnection behavior */
export interface ReconnectOptions {
  maxRetries: number;
  baseDelayMs: number;
}

/** Options for creating a vanilla JS chat session */
export interface CreateChatSessionOptions {
  /**
   * Session identifier used for message-id correlation only. It is NOT used for
   * URL construction — the gateway derives `sessionId` from the JWT claims, so
   * do not restore it as a query parameter.
   */
  sessionId: string;
  /**
   * Fallback client JWT. Only appended when `websocketUrl` is a bare base URL
   * without a `token` query param. When `websocketUrl` is the canonical
   * API-provided URL (which already embeds the token), this is ignored for URL
   * construction.
   */
  token: string;
  /**
   * The canonical WebSocket URL and source of truth for the connection: the
   * `wss://<host>/v1/stream?token=<jwt>` value returned by `POST /v1/sessions`.
   * Used verbatim when it already carries a `token` param. Optional at the type
   * level for backward compatibility, but effectively required: a missing/empty
   * value throws at runtime (there is no hardcoded default).
   */
  websocketUrl?: string;
  /**
   * Server-advertised control-plane protocol version, sourced from the SDK's
   * `CreateSessionResult.serverProtocolVersion` (WS-37). When present it is
   * asserted against the react build's `API_PROTOCOL_VERSION` BEFORE the socket
   * opens — a mismatch throws a typed `SwiftAgentError(INCOMPATIBLE_VERSION)`.
   * `undefined` (legacy server) fails open and connects normally.
   */
  serverProtocolVersion?: string;
  reconnect?: ReconnectOptions;
  /** Injectable WebSocket factory for testing */
  createWebSocket?: (url: string) => WebSocket;
  /** Error handler for malformed frames or connection errors */
  onError?: (error: unknown) => void;
}

/** The vanilla JS chat session client */
export interface ChatSessionClient {
  sendMessage(content: string): void;
  onEvent(handler: (event: ChatEvent) => void): () => void;
  disconnect(): void;
  readonly connectionStatus: ConnectionStatus;
}

/** Arguments for the useAgentChat hook */
export interface UseAgentChatArgs {
  sessionId: string;
  token: string;
  websocketUrl?: string;
  /**
   * Server-advertised control-plane protocol version from the SDK's
   * `CreateSessionResult.serverProtocolVersion` (WS-37). Asserted before connect;
   * a mismatch surfaces the actionable `INCOMPATIBLE_VERSION` message via `lastError`.
   */
  serverProtocolVersion?: string;
  reconnect?: ReconnectOptions;
  createWebSocket?: (url: string) => WebSocket;
  onError?: (error: unknown) => void;
}

/** Return type of the useAgentChat hook */
export interface UseAgentChatResult {
  messages: ChatMessage[];
  send: (content: string) => void;
  isStreaming: boolean;
  connectionStatus: ConnectionStatus;
  lastError: string | null;
}
