// Vanilla JS client
export { createChatSession } from './client.js';

// React hooks
export { useAgentChat } from './hooks/use-agent-chat.js';
export { useConnection } from './hooks/use-connection.js';

// State
export { chatReducer, initialChatState } from './state.js';
export type { ChatState, ChatAction, InternalAction } from './state.js';

// Types
export type {
  ChatEvent,
  ChatMessage,
  ChatSessionClient,
  ConnectionStatus,
  CreateChatSessionOptions,
  ReconnectOptions,
  ToolCallInfo,
  UseAgentChatArgs,
  UseAgentChatResult,
} from './types.js';
export type { UseConnectionOptions, UseConnectionResult } from './hooks/use-connection.js';
