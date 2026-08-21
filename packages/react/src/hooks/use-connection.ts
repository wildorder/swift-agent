import { useEffect, useRef, useState } from 'react';
import { createChatSession } from '../client.js';
import type {
  ChatSessionClient,
  ConnectionStatus,
  ReconnectOptions,
} from '../types.js';

export interface UseConnectionOptions {
  /**
   * Server-advertised control-plane protocol version (WS-37). Forwarded to
   * `createChatSession`, which asserts compatibility before opening the socket;
   * a mismatch throws synchronously inside the effect and is surfaced via
   * `lastError` (never rethrown out of the effect).
   */
  serverProtocolVersion?: string;
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

    const handleError = (err: unknown): void => {
      setLastError(err instanceof Error ? err.message : String(err));
      options?.onError?.(err);
    };

    let client:
      | (ChatSessionClient & {
          onStatusChange: (h: (s: ConnectionStatus) => void) => () => void;
        })
      | null;
    try {
      client = createChatSession({
        sessionId,
        token,
        websocketUrl,
        serverProtocolVersion: options?.serverProtocolVersion,
        reconnect: options?.reconnect,
        createWebSocket: options?.createWebSocket,
        onError: handleError,
      }) as ChatSessionClient & {
        onStatusChange: (h: (s: ConnectionStatus) => void) => () => void;
      };
    } catch (err) {
      // A pre-connect assertion (e.g. INCOMPATIBLE_VERSION, WS-37) throws
      // synchronously from createChatSession before any socket opens. Surface it
      // through the same lastError path and leave the connection unopened — the
      // throw must NOT escape the effect.
      handleError(err);
      setConnectionStatus('disconnected');
      return;
    }

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
  }, [sessionId, token, websocketUrl, options?.serverProtocolVersion]);

  return {
    client: clientRef.current,
    connectionStatus,
    lastError,
    reconnectAttempt,
  };
}
