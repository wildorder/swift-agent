// Vanilla JS client
export { createChatSession } from './client.js';

// React hooks
export { useAgentChat } from './hooks/use-agent-chat.js';

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
