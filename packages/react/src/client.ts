import { ChatEventSchema } from '@swiftagent/shared';
import type { ChatEvent } from '@swiftagent/shared';
import type {
  ChatSessionClient,
  ConnectionStatus,
  CreateChatSessionOptions,
} from './types.js';

const DEFAULT_WS_URL = 'wss://api.swiftagent.dev/ws';
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_DELAY_MS = 1000;

export function createChatSession(
  opts: CreateChatSessionOptions,
): ChatSessionClient {
  const {
    sessionId,
    token,
    websocketUrl = DEFAULT_WS_URL,
    reconnect,
    onError,
  } = opts;

  const maxRetries = reconnect?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = reconnect?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const factory =
    opts.createWebSocket ?? ((url: string) => new WebSocket(url));

  let ws: WebSocket | null = null;
  let status: ConnectionStatus = 'disconnected';
  let retryCount = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let intentionalClose = false;

  const eventHandlers = new Set<(event: ChatEvent) => void>();
  const statusHandlers = new Set<(status: ConnectionStatus) => void>();
  const messageQueue: string[] = [];

  function setStatus(newStatus: ConnectionStatus): void {
    status = newStatus;
    for (const handler of statusHandlers) handler(newStatus);
  }

  function connect(): void {
    if (intentionalClose) return;

    setStatus('connecting');
    const url = `${websocketUrl}?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}`;
    ws = factory(url);

    ws.onopen = (): void => {
      setStatus('connected');
      retryCount = 0;
      flushQueue();
    };

    ws.onmessage = (event: MessageEvent): void => {
      try {
        const data: unknown = JSON.parse(String(event.data));
        const parsed = ChatEventSchema.parse(data);
        for (const handler of eventHandlers) handler(parsed);
      } catch (err) {
        onError?.(err);
      }
    };

    ws.onclose = (): void => {
      ws = null;
      setStatus('disconnected');
      if (!intentionalClose) {
        scheduleReconnect();
      }
    };

    ws.onerror = (): void => {
      // onclose will fire after onerror — reconnection handled there
    };
  }

  function scheduleReconnect(): void {
    if (retryCount >= maxRetries || intentionalClose) return;
    const delay = baseDelayMs * Math.pow(2, retryCount);
    retryCount++;
    retryTimer = setTimeout(connect, delay);
  }

  function flushQueue(): void {
    while (messageQueue.length > 0 && ws?.readyState === WebSocket.OPEN) {
      const msg = messageQueue.shift();
      if (msg) ws.send(msg);
    }
  }

  function sendMessage(content: string): void {
    const payload = JSON.stringify({ type: 'send_message', content });
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(payload);
    } else {
      messageQueue.push(payload);
    }
  }

  function onEvent(handler: (event: ChatEvent) => void): () => void {
    eventHandlers.add(handler);
    return () => {
      eventHandlers.delete(handler);
    };
  }

  function onStatusChange(handler: (s: ConnectionStatus) => void): () => void {
    statusHandlers.add(handler);
    return () => {
      statusHandlers.delete(handler);
    };
  }

  function disconnect(): void {
    intentionalClose = true;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onopen = null;
      ws.close();
      ws = null;
    }
    setStatus('disconnected');
  }

  // Start connection
  connect();

  return {
    sendMessage,
    onEvent,
    disconnect,
    get connectionStatus(): ConnectionStatus {
      return status;
    },
    // Expose for internal hook use
    onStatusChange,
  } as ChatSessionClient & {
    onStatusChange: typeof onStatusChange;
  };
}
