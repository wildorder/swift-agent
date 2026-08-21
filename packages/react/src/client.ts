import {
  ChatEventSchema,
  assertProtocolCompatible,
  SwiftAgentError,
  SwiftAgentErrorCode,
} from '@swiftagent/shared';
import type { ChatEvent } from '@swiftagent/shared';
import type {
  ChatSessionClient,
  ConnectionStatus,
  CreateChatSessionOptions,
} from './types.js';

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_DELAY_MS = 1000;

/**
 * Resolve the canonical WebSocket URL the socket factory should connect to.
 *
 * The source of truth is the `websocketUrl` returned by `POST /v1/sessions`,
 * which is already the fully-tokenized canonical form
 * `wss://<host>/v1/stream?token=<jwt>`. When present, it is used verbatim.
 *
 * The gateway reads ONLY `?token=` from the query and derives `sessionId` from
 * the JWT claims — so we never append `sessionId` (it would be dead weight and
 * leak the id into logs/proxies). When a bare base URL is supplied without a
 * token, the `token` option is appended via the `URL`/`URLSearchParams` API,
 * which handles encoding and the `?`-vs-`&` separator correctly (no double-`?`).
 *
 * There is deliberately no hardcoded default: a wrong production-looking default
 * (the old `wss://api.swiftagent.dev/ws`) silently masks misconfiguration. A
 * missing/empty `websocketUrl` fails loudly instead — the real flow always
 * supplies it from session creation.
 */
function resolveConnectionUrl(
  websocketUrl: string | undefined,
  token: string,
): string {
  if (!websocketUrl) {
    throw new Error(
      'createChatSession requires a websocketUrl (the value returned by POST /v1/sessions)',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(websocketUrl);
  } catch {
    throw new Error(
      `createChatSession received an invalid websocketUrl: ${websocketUrl}`,
    );
  }

  // API-provided happy path: already tokenized → connect to it unchanged.
  if (parsed.searchParams.has('token')) {
    return websocketUrl;
  }

  // Fallback: bare base URL + separate token option → append safely.
  if (token) {
    parsed.searchParams.set('token', token);
  }
  return parsed.toString();
}

export function createChatSession(
  opts: CreateChatSessionOptions,
): ChatSessionClient {
  const { token, websocketUrl, reconnect, onError } = opts;

  // Refuse to connect against an incompatible server (WS-37). This runs BEFORE
  // resolveConnectionUrl and before any socket is opened, mirroring how an
  // invalid websocketUrl already fails loudly at construction. A mismatch throws
  // a typed SwiftAgentError(INCOMPATIBLE_VERSION); an absent version (legacy
  // server) fails open and connects normally. This is a pure pre-check — it does
  // NOT touch WS-34's URL-resolution/reconnect logic below.
  //
  // Note the argument order: `assertProtocolCompatible(remote, local)` takes the
  // server-advertised version as `remote`; the default `local` pair already
  // carries this build's `API_PROTOCOL_VERSION` as its `current`, so the check is
  // "server `serverProtocolVersion` vs. this SDK's API_PROTOCOL_VERSION".
  assertProtocolCompatible(opts.serverProtocolVersion);

  // Resolve the connection URL up front so misconfiguration (missing/invalid
  // URL) fails loudly at construction time, before any socket is opened. The
  // URL is constant across reconnects, so we compute it once here.
  const url = resolveConnectionUrl(websocketUrl, token);

  const maxRetries = reconnect?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = reconnect?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const factory =
    opts.createWebSocket ?? ((wsUrl: string) => new WebSocket(wsUrl));

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

    ws.onclose = (event: CloseEvent): void => {
      ws = null;
      setStatus('disconnected');
      if (!intentionalClose) {
        // Surface an abnormal/auth close as a typed, human-readable error before
        // reconnecting (WS-41). A normal close (1000) is silent. The raw DOM
        // CloseEvent is NEVER forwarded to onError — we translate its code/reason
        // into a SwiftAgentError so `lastError` is a clean string, not
        // `[object Event]`. Reconnect/backoff below is WS-34's contract, untouched.
        if (event.code !== 1000) {
          emitCloseError(event);
        }
        scheduleReconnect();
      }
    };

    ws.onerror = (): void => {
      // onclose will fire after onerror — reconnection AND error surfacing happen
      // there. The raw DOM Event handed to onerror is intentionally NOT forwarded
      // to onError (it stringifies to `[object Event]`); onclose has the code/reason.
    };
  }

  /** Translate an abnormal/auth WebSocket close into a typed, readable error. */
  function emitCloseError(event: CloseEvent): void {
    const reason = event.reason ? `: ${event.reason}` : '';
    if (event.code === 4001) {
      onError?.(
        new SwiftAgentError(
          SwiftAgentErrorCode.UNAUTHORIZED,
          `Connection closed (4001)${reason} — authentication failed; check the client token / websocketUrl.`,
        ),
      );
      return;
    }
    onError?.(
      new SwiftAgentError(
        SwiftAgentErrorCode.CONNECTION_ERROR,
        `Connection closed (${event.code})${reason} — the stream dropped; check the server / network. Reconnecting…`,
      ),
    );
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
