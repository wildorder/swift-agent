import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { ChatEvent } from '@swiftagent/shared';
import { useConnection } from './use-connection.js';
import { chatReducer, initialChatState } from '../state.js';
import type { UseAgentChatArgs, UseAgentChatResult } from '../types.js';

let nextUserMsgId = 0;
function generateUserMsgId(): string {
  return `user_${Date.now()}_${++nextUserMsgId}`;
}

export function useAgentChat(args: UseAgentChatArgs): UseAgentChatResult {
  const { sessionId, token, websocketUrl, reconnect, createWebSocket, onError } = args;

  const [state, dispatch] = useReducer(chatReducer, initialChatState);

  const { client, connectionStatus, lastError } = useConnection(
    sessionId,
    token,
    websocketUrl,
    { reconnect, createWebSocket, onError },
  );

  const clientRef = useRef(client);
  clientRef.current = client;

  // Subscribe to chat events
  useEffect(() => {
    if (!client) return;

    const unsub = client.onEvent((event: ChatEvent) => {
      dispatch(event);
    });

    return unsub;
  }, [client]);

  // Sync connection status into reducer state
  useEffect(() => {
    dispatch({ type: 'CONNECTION_STATUS', status: connectionStatus });
  }, [connectionStatus]);

  // Sync lastError into reducer state
  useEffect(() => {
    if (lastError) {
      // lastError from connection is already in useConnection state,
      // we just expose it directly rather than duplicating into reducer
    }
  }, [lastError]);

  const send = useCallback((content: string) => {
    const id = generateUserMsgId();
    dispatch({ type: 'SEND_USER', id, content });
    clientRef.current?.sendMessage(content);
  }, []);

  return {
    messages: state.messages,
    send,
    isStreaming: state.isStreaming,
    connectionStatus,
    lastError,
  };
}
