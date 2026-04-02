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
  sessionId: string;
  token: string;
  websocketUrl?: string;
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
