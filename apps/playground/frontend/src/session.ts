import type { ChatEvent, ConnectionStatus } from '@swiftagent/react';
import {
  MediatorFrameSchema,
  SessionReadyFrameSchema,
} from '../../backend/src/mediator/protocol';
import type { RefusalFrame, SessionReadyFrame } from '../../backend/src/mediator/protocol';

/**
 * WS-49 — the mediator-backed session controller.
 *
 * The browser talks ONLY to the mediator: it fetches a credential-free guest
 * session from `POST /playground/session` (opaque guest id + limits — no
 * workspace key, no client JWT, no upstream websocketUrl) and opens the single
 * WebSocket `/playground/stream?gid=…`. Relayed `ChatEvent` frames flow into
 * the same raw feed WS-48's beats render; the mediator's own typed frames
 * (session_ready / refusal) are split off to their handlers. Browser-side
 * code plays NO enforcement role — every limit lives in the mediator.
 */

export type { RefusalFrame, SessionReadyFrame };

/** The credential-free session payload minted by `POST /playground/session`. */
export type SessionInfo = SessionReadyFrame;

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

const CHAT_EVENT_TYPES = new Set([
  'message_started',
  'token',
  'tool_call_started',
  'tool_call_completed',
  'message_completed',
  'run_failed',
]);

export interface PlaygroundControllerOptions {
  /** Injectable WebSocket factory (tests). */
  createWebSocket?: (url: string) => WebSocket;
  /** Mediator stream URL override (tests); defaults to same-origin /playground/stream. */
  streamUrl?: string;
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
  /** Every mediator refusal frame received, in arrival order. */
  readonly refusals: readonly RefusalFrame[];
  readonly status: ConnectionStatus;
  send(text: string): void;
  /** Drop the mediator socket. Nothing reconnects automatically. */
  drop(): void;
  /**
   * Recover by opening a NEW mediator socket for the SAME guest session — the
   * mediator re-attaches upstream against the same runtime session, which
   * replays the active run. The session — not the socket — is durable.
   */
  recover(): void;
}

function defaultStreamUrl(guestId: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/playground/stream?gid=${encodeURIComponent(guestId)}`;
}

/**
 * The composed session controller (Beats 1–3) over the mediator transport.
 * Inbound `send` frames are the mediator's own protocol; the feed still
 * carries the untouched relayed `ChatEvent`s.
 */
export function createPlaygroundController(
  info: SessionInfo,
  opts: PlaygroundControllerOptions = {},
): PlaygroundController {
  const now = opts.now ?? (() => Date.now());
  const makeSocket = opts.createWebSocket ?? ((url: string) => new WebSocket(url));
  const url = opts.streamUrl ?? defaultStreamUrl(info.guestId);

  const log: LoggedEvent[] = [];
  const refusals: RefusalFrame[] = [];
  let seq = 0;
  let socket: WebSocket | null = null;
  let status: ConnectionStatus = 'disconnected';

  function notify(): void {
    opts.onChange?.();
  }

  function handleFrame(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      opts.onError?.(err);
      return;
    }
    const type = (parsed as { type?: unknown }).type;

    // Relayed ChatEvents feed WS-48's beats unchanged.
    if (typeof type === 'string' && CHAT_EVENT_TYPES.has(type)) {
      log.push({ seq: seq++, at: now(), event: parsed as ChatEvent });
      notify();
      return;
    }

    // The mediator's own frames.
    const frame = MediatorFrameSchema.safeParse(parsed);
    if (!frame.success) return; // unknown frame — ignore, never crash the feed
    if (frame.data.type === 'refusal') {
      refusals.push(frame.data);
      notify();
    }
    // session_ready re-confirms the limits on (re)attach — nothing to store.
  }

  function attach(): void {
    const ws = makeSocket(url);
    socket = ws;
    status = 'connecting';
    ws.onopen = () => {
      status = 'connected';
      notify();
    };
    ws.onclose = () => {
      if (socket === ws) {
        status = 'disconnected';
        notify();
      }
    };
    ws.onerror = (event) => {
      opts.onError?.(event);
    };
    ws.onmessage = (event: MessageEvent) => {
      handleFrame(typeof event.data === 'string' ? event.data : String(event.data));
    };
    notify();
  }

  attach();

  return {
    info,
    get events(): readonly LoggedEvent[] {
      return log;
    },
    get refusals(): readonly RefusalFrame[] {
      return refusals;
    },
    get status(): ConnectionStatus {
      return status;
    },
    send(text: string): void {
      // No browser-side gating — enforcement is the mediator's alone (SC-09).
      socket?.send(JSON.stringify({ type: 'send', content: text }));
    },
    drop(): void {
      const ws = socket;
      socket = null; // suppress this socket's late events
      status = 'disconnected';
      ws?.close();
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

/** Mint a credential-free guest session from the mediator (browser path; tests inject). */
export async function fetchSessionInfo(): Promise<SessionInfo> {
  const res = await fetch('/playground/session', { method: 'POST' });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'message' in body
        ? String((body as { message: unknown }).message)
        : `POST /playground/session failed: ${res.status}`;
    throw new Error(message);
  }
  return SessionReadyFrameSchema.parse(body);
}
