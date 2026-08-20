import { createChatSession } from '@swiftagent/react';
import type {
  ChatEvent,
  ChatSessionClient,
  ConnectionStatus,
  ReconnectOptions,
} from '@swiftagent/react';

/** The session payload minted by the backend's `/api/session` route. */
export interface SessionInfo {
  sessionId: string;
  token: string;
  websocketUrl: string;
}

/** One raw ChatEvent as it arrived, with its arrival timestamp (Beat 1). */
export interface LoggedEvent {
  seq: number;
  /** Arrival timestamp (ms since epoch) recorded when the event was received. */
  at: number;
  event: ChatEvent;
}

/** A per-callId tool-call view derived from the real event pair (Beat 2). */
export interface ToolCallView {
  callId: string;
  toolName: string;
  status: 'started' | 'completed' | 'failed';
  startedAt: number;
  completedAt?: number;
  /** completed-arrival minus started-arrival, correlated by callId. */
  durationMs?: number;
}

export interface PlaygroundControllerOptions {
  /** Injectable WebSocket factory (tests). Passed through to createChatSession. */
  createWebSocket?: (url: string) => WebSocket;
  reconnect?: ReconnectOptions;
  /** Injectable clock for deterministic arrival timestamps in tests. */
  now?: () => number;
  /** Called whenever the log or connection state changes (UI re-render hook). */
  onChange?: () => void;
  onError?: (error: unknown) => void;
}

export interface PlaygroundController {
  readonly info: SessionInfo;
  /** Ordered raw event log — the real feed, not a reconstruction. */
  readonly events: readonly LoggedEvent[];
  readonly status: ConnectionStatus;
  send(text: string): void;
  /**
   * Drop the connection by calling the client's `disconnect()`. This is the
   * client's real, documented behavior: `disconnect()` sets `intentionalClose`,
   * which permanently suppresses reconnection for that client instance.
   */
  drop(): void;
  /**
   * Recover by constructing a NEW `createChatSession` client against the SAME
   * `sessionId`/`token`/`websocketUrl`, re-attaching handlers, and appending
   * its events to the same feed. The session — not the socket — is durable.
   */
  recover(): void;
}

/**
 * The composed vanilla-client session controller (Beats 1–3). This module
 * composes the PUBLIC `createChatSession` export of `@swiftagent/react` — no
 * new hook, export, endpoint, or event field anywhere.
 */
export function createPlaygroundController(
  info: SessionInfo,
  opts: PlaygroundControllerOptions = {},
): PlaygroundController {
  const now = opts.now ?? (() => Date.now());
  const log: LoggedEvent[] = [];
  let seq = 0;
  let client: ChatSessionClient | null = null;

  function notify(): void {
    opts.onChange?.();
  }

  function attach(): void {
    const created = createChatSession({
      sessionId: info.sessionId,
      token: info.token,
      websocketUrl: info.websocketUrl,
      ...(opts.createWebSocket ? { createWebSocket: opts.createWebSocket } : {}),
      ...(opts.reconnect ? { reconnect: opts.reconnect } : {}),
      ...(opts.onError ? { onError: opts.onError } : {}),
    });
    created.onEvent((event) => {
      log.push({ seq: seq++, at: now(), event });
      notify();
    });
    client = created;
    notify();
  }

  attach();

  return {
    info,
    get events(): readonly LoggedEvent[] {
      return log;
    },
    get status(): ConnectionStatus {
      return client?.connectionStatus ?? 'disconnected';
    },
    send(text: string): void {
      client?.sendMessage(text);
    },
    drop(): void {
      client?.disconnect();
      notify();
    },
    recover(): void {
      attach();
    },
  };
}

/**
 * Derive per-call tool views from the raw feed: correlation is by `callId` —
 * the real identity the events carry — and the measured duration is the
 * arrival-timestamp delta of the real started/completed event pair.
 */
export function deriveToolCalls(events: readonly LoggedEvent[]): ToolCallView[] {
  const byId = new Map<string, ToolCallView>();
  const order: string[] = [];

  for (const { at, event } of events) {
    if (event.type === 'tool_call_started') {
      if (!byId.has(event.callId)) {
        byId.set(event.callId, {
          callId: event.callId,
          toolName: event.toolName,
          status: 'started',
          startedAt: at,
        });
        order.push(event.callId);
      }
    } else if (event.type === 'tool_call_completed') {
      const existing = byId.get(event.callId);
      if (existing) {
        existing.completedAt = at;
        existing.durationMs = at - existing.startedAt;
        existing.status = event.status === 'failed' ? 'failed' : 'completed';
      } else {
        // Completion without a visible start (e.g. partial replay): still show it.
        byId.set(event.callId, {
          callId: event.callId,
          toolName: event.toolName,
          status: event.status === 'failed' ? 'failed' : 'completed',
          startedAt: at,
          completedAt: at,
        });
        order.push(event.callId);
      }
    }
  }

  const views: ToolCallView[] = [];
  for (const callId of order) {
    const view = byId.get(callId);
    if (view) views.push(view);
  }
  return views;
}

/** Fetch the session payload from the backend (browser path; tests inject). */
export async function fetchSessionInfo(): Promise<SessionInfo> {
  const res = await fetch('/api/session');
  if (!res.ok) {
    throw new Error(`GET /api/session failed: ${res.status}`);
  }
  return (await res.json()) as SessionInfo;
}
