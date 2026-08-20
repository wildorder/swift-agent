import { WebSocketServer, WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { buildServer, loadDemoConfig } from '../../server.js';
import { loadMediatorConfig } from '../config.js';
import type { MediatorConfig } from '../config.js';
import type {
  LedgerReserveResult,
  LedgerTerminalStatus,
  MediatorDeps,
  SpendLedger,
  UpstreamControl,
} from '../mediator.js';

/**
 * WS-49 mediator test harness: a stub upstream WS server that speaks the
 * gateway's ping/pong handshake and scripted ChatEvent sequences, a spy
 * control client, an in-memory ledger, and a raw promise-based WS client
 * that IGNORES the UI entirely (the SC-09 requirement).
 */

// ── Stub upstream runtime ────────────────────────────────────────────

export interface StubUpstream {
  /** ws:// URL guests' websocketUrl points at. */
  url: string;
  /** Every send_message content the upstream actually received, in order. */
  received: string[];
  /** Raw frames (pre-serialized strings) the upstream sent, in order. */
  sentRaw: string[];
  /** Script the response to the n-th send_message (0-based). */
  onSend: (fn: (send: (raw: string) => void, index: number, content: string) => void) => void;
  close(): Promise<void>;
}

export function startStubUpstream(): Promise<StubUpstream> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    const received: string[] = [];
    const sentRaw: string[] = [];
    let responder: ((send: (raw: string) => void, index: number, content: string) => void) | null =
      null;

    wss.on('connection', (socket) => {
      const send = (raw: string): void => {
        sentRaw.push(raw);
        socket.send(raw);
      };
      socket.on('message', (data: Buffer | string) => {
        const text = typeof data === 'string' ? data : data.toString('utf8');
        let frame: { type?: string; content?: string };
        try {
          frame = JSON.parse(text) as { type?: string; content?: string };
        } catch {
          return;
        }
        if (frame.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong' }));
          return;
        }
        if (frame.type === 'send_message') {
          const index = received.length;
          received.push(frame.content ?? '');
          responder?.(send, index, frame.content ?? '');
        }
      });
    });

    wss.on('listening', () => {
      const { port } = wss.address() as AddressInfo;
      resolve({
        url: `ws://127.0.0.1:${port}/v1/stream`,
        received,
        sentRaw,
        onSend(fn) {
          responder = fn;
        },
        close: () =>
          new Promise<void>((res) => {
            for (const client of wss.clients) client.terminate();
            wss.close(() => res());
          }),
      });
    });
  });
}

// ── Spy control client ───────────────────────────────────────────────

export interface SpyControl extends UpstreamControl {
  cancelled: string[];
  /** runId → status returned by getRun (default 'completed'). */
  runStatuses: Map<string, string>;
  minted: number;
}

export const FAKE_CLIENT_TOKEN_PREFIX = 'tok_secret_client_jwt_';
export const FAKE_WORKSPACE_KEY = 'ak_fake_workspace_key_never_leaks';

export function makeControl(upstreamUrl: string): SpyControl {
  const control: SpyControl = {
    cancelled: [],
    runStatuses: new Map(),
    minted: 0,
    async createSession() {
      control.minted += 1;
      const n = control.minted;
      return {
        sessionId: `ses_guest_${n}`,
        clientToken: `${FAKE_CLIENT_TOKEN_PREFIX}${n}`,
        websocketUrl: `${upstreamUrl}?token=${FAKE_CLIENT_TOKEN_PREFIX}${n}`,
      };
    },
    async getRun(runId: string) {
      return { status: control.runStatuses.get(runId) ?? 'completed', tokenUsage: null };
    },
    async cancelRun(runId: string) {
      control.cancelled.push(runId);
      return {};
    },
  };
  return control;
}

// ── In-memory ledger (unit path; the Postgres path is the repo suite) ─

export interface FakeReservation {
  reservationId: string;
  day: string;
  sessionId: string;
  runId: string | null;
  reservedMicroUsd: number;
  status: 'reserved' | 'settled';
  terminalStatus: LedgerTerminalStatus | null;
  observed?: { inputTokens?: number; outputTokens?: number };
  createdAtMs: number;
}

export interface FakeLedger extends SpendLedger {
  reservations: FakeReservation[];
  dayTotals: Map<string, number>;
  /** Ordered audit of ledger calls, for reserve-before-forward assertions. */
  calls: string[];
}

export function makeFakeLedger(): FakeLedger {
  let counter = 0;
  const ledger: FakeLedger = {
    reservations: [],
    dayTotals: new Map(),
    calls: [],
    async reserve(day, amountMicroUsd, ceilingMicroUsd, sessionId): Promise<LedgerReserveResult> {
      const total = ledger.dayTotals.get(day) ?? 0;
      if (total + amountMicroUsd > ceilingMicroUsd) {
        ledger.calls.push('reserve:refused');
        return { accepted: false, reason: 'daily_ceiling', dayTotalMicroUsd: total };
      }
      ledger.dayTotals.set(day, total + amountMicroUsd);
      counter += 1;
      const reservation: FakeReservation = {
        reservationId: `psr_fake_${counter}`,
        day,
        sessionId,
        runId: null,
        reservedMicroUsd: amountMicroUsd,
        status: 'reserved',
        terminalStatus: null,
        createdAtMs: Date.now(),
      };
      ledger.reservations.push(reservation);
      ledger.calls.push(`reserve:${reservation.reservationId}`);
      return { accepted: true, reservation, dayTotalMicroUsd: total + amountMicroUsd };
    },
    async attachRun(reservationId, runId) {
      const row = ledger.reservations.find((r) => r.reservationId === reservationId);
      if (row && row.runId === null) row.runId = runId;
      ledger.calls.push(`attach:${reservationId}:${runId}`);
      return row ?? null;
    },
    async settle(reservationId, terminalStatus, observedUsage) {
      const row = ledger.reservations.find(
        (r) => r.reservationId === reservationId && r.status === 'reserved',
      );
      if (!row) return null;
      row.status = 'settled';
      row.terminalStatus = terminalStatus;
      if (observedUsage) row.observed = observedUsage;
      ledger.calls.push(`settle:${reservationId}:${terminalStatus}`);
      return row;
    },
    async sweepAbandoned(olderThanMs) {
      const cutoff = Date.now() - olderThanMs;
      const swept = ledger.reservations.filter(
        (r) => r.status === 'reserved' && r.createdAtMs < cutoff,
      );
      for (const row of swept) {
        row.status = 'settled';
        row.terminalStatus = 'abandoned';
      }
      if (swept.length > 0) ledger.calls.push(`sweep:${swept.length}`);
      return swept;
    },
    async dayTotal(day) {
      return ledger.dayTotals.get(day) ?? 0;
    },
  };
  return ledger;
}

// ── App under test ───────────────────────────────────────────────────

export interface Harness {
  server: FastifyInstance;
  baseUrl: string;
  wsBase: string;
  upstream: StubUpstream;
  control: SpyControl;
  ledger: FakeLedger;
  config: MediatorConfig;
  mint(remoteAddress?: string): Promise<{ statusCode: number; body: Record<string, unknown> }>;
  connect(guestId: string): Promise<RawWsClient>;
  close(): Promise<void>;
}

/** Fast, test-friendly defaults; override per test. */
export function testConfig(overrides?: Partial<MediatorConfig>): MediatorConfig {
  return {
    ...loadMediatorConfig({}),
    sessionTtlMs: 60_000,
    ipLimit: { max: 100, windowMs: 60_000 },
    sessionLimit: { max: 100, windowMs: 60_000 },
    messagesPerSession: 100,
    messageMaxChars: 500,
    tokensPerSession: 100_000,
    reservationMicroUsd: 1_000,
    dailyCeilingMicroUsd: 1_000_000,
    sweepIntervalMs: 60_000,
    abandonedAfterMs: 60_000,
    ...overrides,
  };
}

export async function startHarness(
  configOverrides?: Partial<MediatorConfig>,
  depOverrides?: Partial<MediatorDeps>,
): Promise<Harness> {
  const upstream = await startStubUpstream();
  const control = makeControl(upstream.url);
  const ledger = makeFakeLedger();
  const config = testConfig(configOverrides);

  const server = await buildServer({
    mediator: { control, ledger, config, agentName: 'playground-assistant', ...depOverrides },
    demoConfig: loadDemoConfig(),
  });
  await server.listen({ port: 0, host: '127.0.0.1' });
  const { port } = server.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsBase = `ws://127.0.0.1:${port}`;

  return {
    server,
    baseUrl,
    wsBase,
    upstream,
    control,
    ledger,
    config,
    async mint(remoteAddress = '198.51.100.10') {
      const res = await server.inject({
        method: 'POST',
        url: '/playground/session',
        remoteAddress,
      });
      return { statusCode: res.statusCode, body: res.json<Record<string, unknown>>() };
    },
    connect(guestId: string) {
      return connectRaw(`${wsBase}/playground/stream?gid=${encodeURIComponent(guestId)}`);
    },
    async close() {
      await server.close();
      await upstream.close();
    },
  };
}

// ── Raw WS client (ignores the UI entirely) ──────────────────────────

export interface RawWsClient {
  socket: WebSocket;
  /** Raw frame strings, exactly as received. */
  raw: string[];
  /** Parsed frames, in order. */
  frames: Array<Record<string, unknown>>;
  closed: Promise<{ code: number }>;
  isClosed: boolean;
  send(frame: unknown): void;
  sendRaw(raw: string): void;
  waitFor(
    pred: (frame: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
  waitForType(type: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export function connectRaw(url: string, openTimeoutMs = 5_000): Promise<RawWsClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const raw: string[] = [];
    const frames: Array<Record<string, unknown>> = [];
    const waiters: Array<{
      pred: (frame: Record<string, unknown>) => boolean;
      resolve: (frame: Record<string, unknown>) => void;
      timer: NodeJS.Timeout;
    }> = [];

    let markClosed: (info: { code: number }) => void = () => {};
    const closed = new Promise<{ code: number }>((res) => {
      markClosed = res;
    });

    const openTimer = setTimeout(() => {
      reject(new Error(`WS did not open within ${openTimeoutMs}ms`));
      socket.terminate();
    }, openTimeoutMs);

    const client: RawWsClient = {
      socket,
      raw,
      frames,
      closed,
      isClosed: false,
      send(frame) {
        socket.send(JSON.stringify(frame));
      },
      sendRaw(text) {
        socket.send(text);
      },
      waitFor(pred, timeoutMs = 5_000) {
        const existing = frames.find(pred);
        if (existing) return Promise.resolve(existing);
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            const idx = waiters.findIndex((w) => w.timer === timer);
            if (idx >= 0) waiters.splice(idx, 1);
            rej(
              new Error(
                `Timed out after ${timeoutMs}ms waiting for a frame; got: ${raw.join(' | ')}`,
              ),
            );
          }, timeoutMs);
          waiters.push({ pred, resolve: res, timer });
        });
      },
      waitForType(type, timeoutMs) {
        return client.waitFor((f) => f['type'] === type, timeoutMs);
      },
      close() {
        return new Promise<void>((res) => {
          if (socket.readyState === WebSocket.CLOSED) {
            res();
            return;
          }
          socket.once('close', () => res());
          socket.close();
        });
      },
    };

    socket.on('message', (data: Buffer | string) => {
      const text = typeof data === 'string' ? data : data.toString('utf8');
      raw.push(text);
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return;
      }
      frames.push(frame);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i];
        if (w && w.pred(frame)) {
          clearTimeout(w.timer);
          waiters.splice(i, 1);
          w.resolve(frame);
        }
      }
    });
    socket.on('close', (code: number) => {
      client.isClosed = true;
      markClosed({ code });
    });
    socket.on('error', () => {
      /* surfaced via timeouts */
    });
    socket.on('open', () => {
      clearTimeout(openTimer);
      resolve(client);
    });
  });
}

/** A well-formed scripted ChatEvent sequence for run `runId`. */
export function chatEventScript(runId: string, opts?: { tokenText?: string; tokens?: number }) {
  const base = { runId, sessionId: 'ses_guest_1' };
  const msg = { ...base, messageId: `msg_${runId}` };
  const tokenText = opts?.tokenText ?? 'hello from the stub';
  const tokenCount = opts?.tokens ?? 1;
  const frames: string[] = [JSON.stringify({ type: 'message_started', ...msg })];
  for (let i = 0; i < tokenCount; i++) {
    frames.push(JSON.stringify({ type: 'token', ...msg, text: tokenText }));
  }
  frames.push(
    JSON.stringify({ type: 'tool_call_started', ...base, callId: `tc_${runId}`, toolName: 'get_weather' }),
    JSON.stringify({
      type: 'tool_call_completed',
      ...base,
      callId: `tc_${runId}`,
      toolName: 'get_weather',
      status: 'completed',
    }),
    JSON.stringify({ type: 'message_completed', ...msg }),
  );
  return frames;
}
