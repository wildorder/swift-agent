// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPlaygroundController, deriveToolCalls } from '../session';
import type { SessionInfo } from '../session';

// Canonical API-provided URL (already tokenized) — used verbatim by the client.
const CANONICAL_URL = 'wss://demo.example.com/v1/stream?token=tok_abc';

const INFO: SessionInfo = {
  sessionId: 'ses_demo',
  token: 'tok_abc',
  websocketUrl: CANONICAL_URL,
};

// ── Mock WebSocket (same pattern as packages/react's own tests) ─────

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  url: string;

  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  simulateMessage(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
  }
}

let instances: MockWebSocket[];
let factory: (url: string) => WebSocket;
let clock: number;

function makeController() {
  return createPlaygroundController(INFO, {
    createWebSocket: factory,
    now: () => clock,
  });
}

beforeEach(() => {
  instances = [];
  clock = 1_000;
  factory = (url: string) => {
    const ws = new MockWebSocket(url);
    instances.push(ws);
    return ws as unknown as WebSocket;
  };
});

afterEach(() => {
  vi.useRealTimers();
});

function ws(index: number): MockWebSocket {
  const socket = instances[index];
  if (!socket) throw new Error(`no socket at index ${index}`);
  return socket;
}

// ── Spec test 7 — raw feed order + timestamps (Beat 1) ──────────────

describe('raw event feed', () => {
  it('records every parsed event in arrival order with arrival timestamps', () => {
    const controller = makeController();
    ws(0).simulateOpen();

    clock = 1_000;
    ws(0).simulateMessage({
      type: 'message_started',
      messageId: 'msg_1',
      runId: 'run_1',
      sessionId: 'ses_demo',
    });
    clock = 1_015;
    ws(0).simulateMessage({
      type: 'token',
      messageId: 'msg_1',
      runId: 'run_1',
      sessionId: 'ses_demo',
      text: 'hello',
    });
    clock = 1_030;
    ws(0).simulateMessage({
      type: 'message_completed',
      messageId: 'msg_1',
      runId: 'run_1',
      sessionId: 'ses_demo',
    });

    expect(controller.events).toHaveLength(3);
    expect(controller.events.map((e) => e.event.type)).toEqual([
      'message_started',
      'token',
      'message_completed',
    ]);
    expect(controller.events.map((e) => e.at)).toEqual([1_000, 1_015, 1_030]);
    // Events are the parsed objects, not strings.
    expect(controller.events[0]?.event).toEqual({
      type: 'message_started',
      messageId: 'msg_1',
      runId: 'run_1',
      sessionId: 'ses_demo',
    });
  });
});

// ── Spec test 8 — duration correlation by callId (Beat 2) ───────────

describe('tool-call duration correlation', () => {
  it('computes durations from the arrival-timestamp delta, correlates interleaved callIds independently, and exposes failed completions', () => {
    const controller = makeController();
    ws(0).simulateOpen();

    clock = 2_000;
    ws(0).simulateMessage({
      type: 'tool_call_started',
      callId: 'tc_a',
      runId: 'run_1',
      sessionId: 'ses_demo',
      toolName: 'get_weather',
    });
    clock = 2_040;
    ws(0).simulateMessage({
      type: 'tool_call_started',
      callId: 'tc_b',
      runId: 'run_1',
      sessionId: 'ses_demo',
      toolName: 'unreliable_service',
    });
    // Interleaved: tc_b completes (failed) before tc_a completes.
    clock = 2_140;
    ws(0).simulateMessage({
      type: 'tool_call_completed',
      callId: 'tc_b',
      runId: 'run_1',
      sessionId: 'ses_demo',
      toolName: 'unreliable_service',
      status: 'failed',
    });
    clock = 2_350;
    ws(0).simulateMessage({
      type: 'tool_call_completed',
      callId: 'tc_a',
      runId: 'run_1',
      sessionId: 'ses_demo',
      toolName: 'get_weather',
      status: 'completed',
    });

    const calls = deriveToolCalls(controller.events);
    expect(calls).toHaveLength(2);

    const a = calls.find((c) => c.callId === 'tc_a');
    const b = calls.find((c) => c.callId === 'tc_b');
    expect(a).toMatchObject({
      toolName: 'get_weather',
      status: 'completed',
      startedAt: 2_000,
      completedAt: 2_350,
      durationMs: 350,
    });
    expect(b).toMatchObject({
      toolName: 'unreliable_service',
      status: 'failed',
      startedAt: 2_040,
      completedAt: 2_140,
      durationMs: 100,
    });
  });
});

// ── Spec test 9 — drop suppresses reconnection (Beat 3) ─────────────

describe('drop', () => {
  it('calls disconnect(): the factory is never invoked again and status stays disconnected', () => {
    vi.useFakeTimers();
    const controller = makeController();
    ws(0).simulateOpen();
    expect(controller.status).toBe('connected');

    controller.drop();
    expect(controller.status).toBe('disconnected');
    expect(instances).toHaveLength(1);

    // intentionalClose semantics: no reconnect attempt ever fires.
    vi.advanceTimersByTime(60_000);
    expect(instances).toHaveLength(1);
    expect(controller.status).toBe('disconnected');
  });
});

// ── Spec test 10 — recover: a NEW client against the SAME session ───

describe('recover', () => {
  it('invokes the factory exactly once more with the same resolved URL and appends the replayed backlog to the same feed', () => {
    const controller = makeController();
    ws(0).simulateOpen();

    clock = 3_000;
    ws(0).simulateMessage({
      type: 'message_started',
      messageId: 'msg_1',
      runId: 'run_1',
      sessionId: 'ses_demo',
    });
    expect(controller.events).toHaveLength(1);

    controller.drop();
    expect(instances).toHaveLength(1);

    controller.recover();
    // Exactly one more factory invocation — a new client, same resolved URL
    // (same websocketUrl/token → same session).
    expect(instances).toHaveLength(2);
    expect(ws(1).url).toBe(CANONICAL_URL);
    expect(ws(1).url).toBe(ws(0).url);

    ws(1).simulateOpen();
    expect(controller.status).toBe('connected');

    // The server replays the active run's buffered events to the new socket;
    // they append to the SAME feed, after the pre-drop events.
    clock = 3_500;
    ws(1).simulateMessage({
      type: 'message_started',
      messageId: 'msg_1',
      runId: 'run_1',
      sessionId: 'ses_demo',
    });
    clock = 3_510;
    ws(1).simulateMessage({
      type: 'token',
      messageId: 'msg_1',
      runId: 'run_1',
      sessionId: 'ses_demo',
      text: 'resumed',
    });

    expect(controller.events).toHaveLength(3);
    expect(controller.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(controller.events.map((e) => e.at)).toEqual([3_000, 3_500, 3_510]);
    expect(controller.events[2]?.event).toMatchObject({ type: 'token', text: 'resumed' });
  });
});
