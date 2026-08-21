import { customAlphabet } from 'nanoid';
import websocket from '@fastify/websocket';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { WebSocket as WsWebSocket } from 'ws';
import type { MediatorConfig } from './config.js';
import { createSlidingWindowLimiter } from './rate-limit.js';
import { MediatorInboundSchema } from './protocol.js';
import type { RefusalFrame, RefusalReason, SessionReadyFrame } from './protocol.js';

const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 21);

/**
 * WS-49 — the trusted server-side mediator (SC-09).
 *
 * The ONLY enforcement point between the browser and the playground runtime:
 * it holds the runtime workspace API key (via the injected control client);
 * the browser holds NO credential of any kind — the upstream clientToken and
 * websocketUrl are kept server-side, keyed by an opaque guest id. Upstream
 * `ChatEvent` frames are relayed VERBATIM (byte-identical JSON); the
 * mediator's own frames (protocol.ts) are interleaved beside them.
 *
 * Per-IP/per-session rate + cap counters are in-memory on purpose: the
 * deployment is pinned to one instance and a restart resetting them is
 * acceptable, because the daily ceiling lives in the Postgres ledger — never
 * in this process (runbook §1). No provider credential or provider traffic
 * ever touches this process.
 */

// ── Injected dependencies ────────────────────────────────────────────

/** The `ControlPlaneClient` surface the mediator composes (packages/sdk). */
export interface UpstreamControl {
  createSession(body: { agentName: string; userId?: string }): Promise<{
    sessionId: string;
    clientToken: string;
    websocketUrl: string;
  }>;
  getRun(runId: string): Promise<{
    status: string;
    tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens?: number } | null;
  }>;
  cancelRun(runId: string): Promise<unknown>;
}

export type LedgerTerminalStatus = 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'abandoned';

export type LedgerReserveResult =
  | { accepted: true; reservation: { reservationId: string }; dayTotalMicroUsd: number }
  | { accepted: false; reason: 'daily_ceiling'; dayTotalMicroUsd: number };

/** Structurally satisfied by `createPlaygroundSpendRepo(db)` (@swiftagent/db). */
export interface SpendLedger {
  reserve(
    day: string,
    amountMicroUsd: number,
    ceilingMicroUsd: number,
    sessionId: string,
  ): Promise<LedgerReserveResult>;
  attachRun(reservationId: string, runId: string): Promise<unknown>;
  settle(
    reservationId: string,
    terminalStatus: LedgerTerminalStatus,
    observedUsage?: { inputTokens?: number; outputTokens?: number },
  ): Promise<unknown>;
  sweepAbandoned(olderThanMs: number): Promise<unknown[]>;
  dayTotal(day: string): Promise<number>;
}

/** Minimal upstream-socket surface ('ws' WebSocket satisfies it; tests stub it). */
export interface UpstreamSocket {
  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'close', cb: (code?: number) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  send(data: string): void;
  close(): void;
}

export interface MediatorDeps {
  control: UpstreamControl;
  ledger: SpendLedger;
  config: MediatorConfig;
  /** The runtime agent guest sessions are minted against. */
  agentName: string;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable upstream WebSocket factory (tests). */
  makeUpstreamSocket?: (url: string) => UpstreamSocket;
}

// ── Internal state ───────────────────────────────────────────────────

interface GuestSession {
  guestId: string;
  sessionId: string;
  /** Server-side only — never serialized into any browser-bound frame. */
  clientToken: string;
  /** Server-side only — never serialized into any browser-bound frame. */
  websocketUrl: string;
  expiresAtMs: number;
  messagesSent: number;
  /** Estimated output tokens: ceil(chars/4) over relayed token-frame text. */
  estOutputTokens: number;
  /** Reservations accepted but not yet attached to a runId (FIFO). */
  pendingReservationIds: string[];
  /** runId → reservationId for reservations awaiting settlement. */
  reservationByRun: Map<string, string>;
  /** runIds already attached (guards replayed message_started frames). */
  seenRuns: Set<string>;
  /** Set once the token cap fired, so cancel/refusal happen exactly once. */
  tokenCapBreached: boolean;
}

const CHAT_EVENT_TYPES = new Set([
  'message_started',
  'token',
  'tool_call_started',
  'tool_call_completed',
  'message_completed',
  'run_failed',
]);

/** getRun confirmation retries before leaving settlement to the sweep. */
const SETTLE_CONFIRM_ATTEMPTS = 3;
const SETTLE_CONFIRM_DELAY_MS = 300;

/** Bounded gateway attach-race ping handshake (mirrors realtime-smoke.ts). */
const PING_HANDSHAKE_ATTEMPTS = 20;
const PING_HANDSHAKE_INTERVAL_MS = 300;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function refusal(
  reason: RefusalReason,
  message: string,
  extras?: Partial<Pick<RefusalFrame, 'retryAfterSeconds' | 'remaining'>>,
): RefusalFrame {
  return { type: 'refusal', reason, message, ...extras };
}

// ── The plugin ───────────────────────────────────────────────────────

export async function registerMediator(server: FastifyInstance, deps: MediatorDeps): Promise<void> {
  const { control, ledger, config, agentName } = deps;
  const now = deps.now ?? (() => Date.now());
  const makeUpstreamSocket =
    deps.makeUpstreamSocket ?? ((url: string) => new WsWebSocket(url) as unknown as UpstreamSocket);

  const guests = new Map<string, GuestSession>();
  const ipLimiter = createSlidingWindowLimiter(config.ipLimit);
  const sessionLimiter = createSlidingWindowLimiter(config.sessionLimit);
  /** day → alert already emitted (once per day per threshold). */
  const alertedDays = new Set<string>();

  await server.register(websocket);

  // ── Abandoned-reservation sweep: once at startup + on an interval ──
  const sweep = (): void => {
    void ledger
      .sweepAbandoned(config.abandonedAfterMs)
      .then((settled) => {
        if (settled.length > 0) {
          server.log.warn(
            { settledCount: settled.length },
            'playground ledger sweep settled abandoned reservations at full reserved amount',
          );
        }
      })
      .catch((err: unknown) => {
        server.log.error({ err }, 'playground ledger sweep failed');
      });
    // Evict long-expired guests (grace = one TTL past expiry).
    const cutoff = now() - config.sessionTtlMs;
    for (const [gid, guest] of guests) {
      if (guest.expiresAtMs < cutoff) {
        guests.delete(gid);
        sessionLimiter.forget(gid);
      }
    }
  };
  sweep();
  const sweepTimer = setInterval(sweep, config.sweepIntervalMs);
  sweepTimer.unref?.();
  server.addHook('onClose', async () => {
    clearInterval(sweepTimer);
  });

  // ── Session mint: POST /playground/session (per-IP rate limited) ──
  const mintGuest = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<SessionReadyFrame | RefusalFrame> => {
    const verdict = ipLimiter.check(request.ip, now());
    if (!verdict.allowed) {
      reply.code(429);
      return refusal(
        'rate_limit_ip',
        'Too many playground sessions from this address — try again shortly.',
        { retryAfterSeconds: verdict.retryAfterSeconds },
      );
    }

    const session = await control.createSession({ agentName, userId: 'playground-guest' });
    const guestId = `pg_${nanoid()}`;
    const expiresAtMs = now() + config.sessionTtlMs;
    guests.set(guestId, {
      guestId,
      sessionId: session.sessionId,
      clientToken: session.clientToken,
      websocketUrl: session.websocketUrl,
      expiresAtMs,
      messagesSent: 0,
      estOutputTokens: 0,
      pendingReservationIds: [],
      reservationByRun: new Map(),
      seenRuns: new Set(),
      tokenCapBreached: false,
    });

    // Deliberately credential-free: guest id + limits only (SC-09).
    return {
      type: 'session_ready',
      guestId,
      sessionId: session.sessionId,
      expiresAt: new Date(expiresAtMs).toISOString(),
      limits: {
        messagesPerSession: config.messagesPerSession,
        tokensPerSession: config.tokensPerSession,
        messageMaxChars: config.messageMaxChars,
      },
    };
  };

  server.options('/playground/session', async (_request, reply) => {
    reply.code(204).send();
  });
  server.post('/playground/session', mintGuest);

  // ── The proxied stream: /playground/stream?gid=… ──────────────────
  server.get('/playground/stream', { websocket: true }, (socket, request) => {
    const send = (frame: SessionReadyFrame | RefusalFrame): void => {
      socket.send(JSON.stringify(frame));
    };

    const gid = (request.query as Record<string, unknown>)['gid'];
    const guest = typeof gid === 'string' ? guests.get(gid) : undefined;
    if (!guest || now() > guest.expiresAtMs) {
      // Unknown gid (e.g. mediator restart) or elapsed TTL: the typed frame is
      // delivered BEFORE the close — never a silent drop.
      send(
        refusal('session_expired', 'This guest session has expired — reload to start a new one.'),
      );
      socket.close(1000, 'session expired');
      return;
    }

    // The mediator — not the browser — opens the upstream socket, using the
    // server-side clientToken-bearing websocketUrl the browser never sees.
    const upstream = makeUpstreamSocket(guest.websocketUrl);
    let upstreamReady = false;
    const outQueue: string[] = [];
    const flush = (): void => {
      while (outQueue.length > 0) {
        const frame = outQueue.shift();
        if (frame !== undefined) upstream.send(frame);
      }
    };
    const forwardUpstream = (frame: string): void => {
      if (upstreamReady) upstream.send(frame);
      else outQueue.push(frame);
    };

    let pingTimer: NodeJS.Timeout | null = null;
    const stopPinging = (): void => {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
    };
    upstream.on('open', () => {
      // Gateway attach-race handshake (see test/smoke/realtime-smoke.ts): a
      // frame sent immediately after 'open' can be dropped before the gateway
      // attaches its message listener; a pong proves it is listening. Retry
      // the ping on a bounded interval, and fail OPEN after the budget —
      // the normal per-frame flow then surfaces any real problem loudly.
      let attempts = 0;
      const ping = (): void => {
        attempts += 1;
        if (upstreamReady) {
          stopPinging();
          return;
        }
        if (attempts > PING_HANDSHAKE_ATTEMPTS) {
          stopPinging();
          upstreamReady = true;
          flush();
          return;
        }
        upstream.send(JSON.stringify({ type: 'ping' }));
      };
      ping();
      pingTimer = setInterval(ping, PING_HANDSHAKE_INTERVAL_MS);
      pingTimer.unref?.();
    });
    upstream.on('error', (err) => {
      server.log.warn({ err, guestId: guest.guestId }, 'playground upstream socket error');
    });
    upstream.on('close', () => {
      stopPinging();
      upstreamReady = false;
    });
    upstream.on('message', (data) => {
      const raw =
        typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        server.log.warn({ guestId: guest.guestId }, 'playground upstream sent non-JSON frame');
        return;
      }
      const frame = parsed as { type?: string };

      if (frame.type === 'pong') {
        // Handshake answered — the gateway listener is attached; safe to flush.
        if (!upstreamReady) {
          upstreamReady = true;
          flush();
        }
        return;
      }

      if (typeof frame.type === 'string' && CHAT_EVENT_TYPES.has(frame.type)) {
        // Relay VERBATIM — the exact upstream bytes, so Beat 1's raw feed stays real.
        socket.send(raw);
        observeChatEvent(guest, frame as Record<string, unknown>);
        return;
      }

      // Gateway control frames (e.g. `error`) are not ChatEvents and are not
      // part of the browser protocol — log, never relay, never drop the socket.
      server.log.warn({ frameType: frame.type, guestId: guest.guestId }, 'unrelayed upstream frame');
    });

    // Tell the browser its guarded session is attached (same shape as the mint body).
    send({
      type: 'session_ready',
      guestId: guest.guestId,
      sessionId: guest.sessionId,
      expiresAt: new Date(guest.expiresAtMs).toISOString(),
      limits: {
        messagesPerSession: config.messagesPerSession,
        tokensPerSession: config.tokensPerSession,
        messageMaxChars: config.messageMaxChars,
      },
    });

    // Inbound frames are processed strictly in order: the enforcement chain
    // awaits the ledger, and a concurrent burst must not race past the caps
    // between the check and the increment.
    let inboundChain: Promise<void> = Promise.resolve();
    socket.on('message', (data: Buffer | string) => {
      const raw = typeof data === 'string' ? data : data.toString('utf8');
      inboundChain = inboundChain.then(
        () => handleInbound(raw),
        () => handleInbound(raw),
      );
    });
    socket.on('close', () => {
      upstream.close();
    });
    socket.on('error', () => {
      upstream.close();
    });

    /** The enforcement chain: TTL → rate → message cap → token cap → ledger. */
    async function handleInbound(raw: string): Promise<void> {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        send(refusal('bad_frame', 'Could not parse that frame — the playground accepts JSON {"type":"send","content":…}.'));
        return;
      }
      const inbound = MediatorInboundSchema.safeParse(parsed);
      if (!inbound.success) {
        send(refusal('bad_frame', 'Unknown or malformed frame — the playground accepts only {"type":"send","content":…}.'));
        return;
      }
      if (!guest) return; // unreachable; narrows for TS

      // 1. TTL — the typed frame is delivered, THEN the socket closes.
      if (now() > guest.expiresAtMs) {
        send(refusal('session_expired', 'This guest session has expired — reload to start a new one.'));
        socket.close(1000, 'session expired');
        return;
      }

      // 2. Per-session rate limit — socket stays open; pacing resumes service.
      const verdict = sessionLimiter.check(guest.guestId, now());
      if (!verdict.allowed) {
        send(
          refusal('rate_limit_session', 'Sending too fast — wait a moment and try again.', {
            retryAfterSeconds: verdict.retryAfterSeconds,
          }),
        );
        return;
      }

      // 3a. Per-message length cap (the input-token bound).
      if (inbound.data.content.length > config.messageMaxChars) {
        send(
          refusal(
            'message_cap',
            `Messages are capped at ${config.messageMaxChars} characters in the playground.`,
            { remaining: { messages: Math.max(0, config.messagesPerSession - guest.messagesSent) } },
          ),
        );
        return;
      }

      // 3b. Per-session message cap.
      if (guest.messagesSent >= config.messagesPerSession) {
        send(
          refusal(
            'message_cap',
            `This session reached its ${config.messagesPerSession}-message cap — reload for a fresh session.`,
            { remaining: { messages: 0 } },
          ),
        );
        return;
      }

      // 4. Per-session token cap (pre-send check; mid-stream breach is below).
      if (guest.estOutputTokens >= config.tokensPerSession) {
        send(
          refusal(
            'token_cap',
            `This session reached its ${config.tokensPerSession}-token cap — reload for a fresh session.`,
            { remaining: { tokens: 0 } },
          ),
        );
        return;
      }

      // 5. The global daily ledger — reserve BEFORE any upstream forward.
      const day = utcDay(now());
      const reserved = await ledger.reserve(
        day,
        config.reservationMicroUsd,
        config.dailyCeilingMicroUsd,
        guest.sessionId,
      );
      if (!reserved.accepted) {
        send(
          refusal(
            'daily_ceiling',
            "The playground's daily spend ceiling has been reached — try again tomorrow, or run the stack yourself with `docker compose up`.",
          ),
        );
        return;
      }
      maybeAlert(day, reserved.dayTotalMicroUsd);

      guest.pendingReservationIds.push(reserved.reservation.reservationId);
      guest.messagesSent += 1;
      forwardUpstream(JSON.stringify({ type: 'send_message', content: inbound.data.content }));
    }

    /** Attach/settle bookkeeping + token-cap accounting on relayed frames. */
    function observeChatEvent(g: GuestSession, frame: Record<string, unknown>): void {
      const type = frame['type'];
      const runId = typeof frame['runId'] === 'string' ? frame['runId'] : undefined;

      if (type === 'message_started' && runId && !g.seenRuns.has(runId)) {
        g.seenRuns.add(runId);
        const reservationId = g.pendingReservationIds.shift();
        if (reservationId) {
          g.reservationByRun.set(runId, reservationId);
          void ledger.attachRun(reservationId, runId).catch((err: unknown) => {
            server.log.error({ err, reservationId, runId }, 'playground attachRun failed');
          });
        }
        return;
      }

      if (type === 'token') {
        const text = typeof frame['text'] === 'string' ? frame['text'] : '';
        g.estOutputTokens += Math.ceil(text.length / 4);
        if (g.estOutputTokens > config.tokensPerSession && !g.tokenCapBreached) {
          g.tokenCapBreached = true;
          send(
            refusal(
              'token_cap',
              `This session crossed its ${config.tokensPerSession}-token cap — the current run is being cancelled.`,
              { remaining: { tokens: 0 } },
            ),
          );
          if (runId) {
            // Cancellation terminates the run as 'cancelled' — which settles
            // at the FULL reserved amount like every other terminal status.
            void control.cancelRun(runId).catch((err: unknown) => {
              server.log.error({ err, runId }, 'playground cancelRun failed after token-cap breach');
            });
          }
        }
        return;
      }

      if ((type === 'message_completed' || type === 'run_failed') && runId) {
        void settleRun(g, runId);
      }
    }

    /** Observed terminal event → getRun confirmation → settle at FULL amount. */
    async function settleRun(g: GuestSession, runId: string): Promise<void> {
      const reservationId = g.reservationByRun.get(runId);
      if (!reservationId) return;
      g.reservationByRun.delete(runId);

      for (let attempt = 1; attempt <= SETTLE_CONFIRM_ATTEMPTS; attempt++) {
        let status: string;
        let usage: { inputTokens: number; outputTokens: number } | null | undefined;
        try {
          const run = await control.getRun(runId);
          status = run.status;
          usage = run.tokenUsage;
        } catch (err) {
          server.log.error({ err, runId, reservationId }, 'playground getRun confirmation failed — sweep will settle');
          return;
        }
        if (status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'timed_out') {
          try {
            // Observed usage is recorded for observability ONLY — it never
            // adjusts the charge (loop.ts under-counts multi-round runs).
            await ledger.settle(reservationId, status, usage ?? undefined);
          } catch (err) {
            server.log.error({ err, runId, reservationId }, 'playground settle failed — sweep will settle');
          }
          return;
        }
        if (attempt < SETTLE_CONFIRM_ATTEMPTS) await delay(SETTLE_CONFIRM_DELAY_MS);
      }
      // Never confirmed terminal — the abandoned sweep settles it in full.
      server.log.warn({ runId, reservationId }, 'playground run not terminal after confirmation attempts — leaving for sweep');
    }
  });

  /** Once-per-day structured warn when a reservation crosses the threshold. */
  function maybeAlert(day: string, dayTotalMicroUsd: number): void {
    const thresholdMicroUsd = Math.floor(config.dailyCeilingMicroUsd * config.alertThresholdFraction);
    if (dayTotalMicroUsd >= thresholdMicroUsd && !alertedDays.has(day)) {
      alertedDays.add(day);
      server.log.warn(
        {
          alert: 'playground_spend_threshold',
          day,
          dayTotalMicroUsd,
          thresholdFraction: config.alertThresholdFraction,
          dailyCeilingMicroUsd: config.dailyCeilingMicroUsd,
        },
        'playground daily spend crossed the alert threshold',
      );
    }
  }
}
