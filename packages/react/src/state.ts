import type { ChatEvent } from '@swiftagent/shared';
import type { ChatMessage, ConnectionStatus } from './types.js';

// ── Internal actions ────────────────────────────────────────────────

export type InternalAction =
  | { type: 'SEND_USER'; id: string; content: string }
  | { type: 'RESET_ERROR' }
  | { type: 'CONNECTION_STATUS'; status: ConnectionStatus };

export type ChatAction = ChatEvent | InternalAction;

// ── State ───────────────────────────────────────────────────────────

export interface ChatState {
  messages: ChatMessage[];
  isStreaming: boolean;
  lastError: string | null;
  connectionStatus: ConnectionStatus;
}

export const initialChatState: ChatState = {
  messages: [],
  isStreaming: false,
  lastError: null,
  connectionStatus: 'disconnected',
};

// ── Reducer ─────────────────────────────────────────────────────────

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    // --- Internal actions ---

    case 'SEND_USER': {
      return {
        ...state,
        isStreaming: true,
        lastError: null,
        messages: [
          ...state.messages,
          {
            id: action.id,
            role: 'user',
            content: action.content,
            status: 'pending',
          },
        ],
      };
    }

    case 'RESET_ERROR': {
      return { ...state, lastError: null };
    }

    case 'CONNECTION_STATUS': {
      return { ...state, connectionStatus: action.status };
    }

    // --- Server events ---

    case 'message_started': {
      return {
        ...state,
        isStreaming: true,
        // Mark any pending user messages as complete
        messages: [
          ...state.messages.map((m) =>
            m.role === 'user' && m.status === 'pending'
              ? { ...m, status: 'complete' as const }
              : m,
          ),
          {
            id: action.messageId,
            role: 'assistant',
            content: '',
            status: 'streaming',
          },
        ],
      };
    }

    case 'token': {
      const messages = state.messages.map((m) =>
        m.id === action.messageId && m.status === 'streaming'
          ? { ...m, content: m.content + action.text }
          : m,
      );
      return { ...state, messages };
    }

    case 'tool_call_started': {
      const messages = state.messages.map((m) => {
        if (m.role !== 'assistant' || m.status !== 'streaming') return m;
        const toolCalls = [
          ...(m.toolCalls ?? []),
          {
            callId: action.callId,
            toolName: action.toolName,
            status: 'started' as const,
          },
        ];
        return { ...m, toolCalls };
      });
      return { ...state, messages };
    }

    case 'tool_call_completed': {
      const messages = state.messages.map((m) => {
        if (m.role !== 'assistant' || !m.toolCalls) return m;
        const toolCalls = m.toolCalls.map((tc) =>
          tc.callId === action.callId
            ? { ...tc, status: action.status as 'completed' | 'failed' }
            : tc,
        );
        return { ...m, toolCalls };
      });
      return { ...state, messages };
    }

    case 'message_completed': {
      const messages = state.messages.map((m) =>
        m.id === action.messageId
          ? { ...m, status: 'complete' as const }
          : m,
      );
      return { ...state, messages, isStreaming: false };
    }

    case 'run_failed': {
      return {
        ...state,
        isStreaming: false,
        // Prefix the server code for a readable, self-describing lastError
        // (WS-41), e.g. `[MODEL_ERROR] upstream provider failed`. Always a
        // plain string — never a raw event/object.
        lastError: `[${action.code}] ${action.message}`,
        // Mark any streaming messages as complete
        messages: state.messages.map((m) =>
          m.status === 'streaming'
            ? { ...m, status: 'complete' as const }
            : m,
        ),
      };
    }

    default:
      return state;
  }
}
