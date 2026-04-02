import { useEffect, useRef, useState } from 'react';
import { createChatSession } from '../client.js';
import type {
  ChatSessionClient,
  ConnectionStatus,
  ReconnectOptions,
} from '../types.js';

export interface UseConnectionOptions {
  reconnect?: ReconnectOptions;
  createWebSocket?: (url: string) => WebSocket;
  onError?: (error: unknown) => void;
}

export interface UseConnectionResult {
  client: ChatSessionClient | null;
  connectionStatus: ConnectionStatus;
  lastError: string | null;
  reconnectAttempt: number;
}

export function useConnection(
  sessionId: string | undefined,
  token: string | undefined,
  websocketUrl?: string,
  options?: UseConnectionOptions,
): UseConnectionResult {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>('disconnected');
  const [lastError, setLastError] = useState<string | null>(null);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const clientRef = useRef<
    (ChatSessionClient & { onStatusChange?: (h: (s: ConnectionStatus) => void) => () => void }) | null
  >(null);

  useEffect(() => {
    if (!sessionId || !token) {
      setConnectionStatus('disconnected');
      return;
    }

    const client = createChatSession({
      sessionId,
      token,
      websocketUrl,
      reconnect: options?.reconnect,
      createWebSocket: options?.createWebSocket,
      onError: (err) => {
        setLastError(err instanceof Error ? err.message : String(err));
        options?.onError?.(err);
      },
    }) as ChatSessionClient & {
      onStatusChange: (h: (s: ConnectionStatus) => void) => () => void;
    };

    clientRef.current = client;

    const unsubStatus = client.onStatusChange((s) => {
      setConnectionStatus(s);
      if (s === 'connecting') {
        setReconnectAttempt((prev) => prev + 1);
      } else if (s === 'connected') {
        setReconnectAttempt(0);
      }
    });

    // Set initial status
    setConnectionStatus(client.connectionStatus);

    return () => {
      unsubStatus();
      client.disconnect();
      clientRef.current = null;
    };
  }, [sessionId, token, websocketUrl]);

  return {
    client: clientRef.current,
    connectionStatus,
    lastError,
    reconnectAttempt,
  };
}
