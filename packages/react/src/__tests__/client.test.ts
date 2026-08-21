import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isSwiftAgentError } from '@swiftagent/shared';
import type { SwiftAgentError } from '@swiftagent/shared';
import { createChatSession } from '../client.js';
import type { ConnectionStatus } from '../types.js';

// Canonical API-provided URL: already tokenized `wss://<host>/v1/stream?token=`.
const CANONICAL_URL = 'wss://test.example.com/v1/stream?token=tok_abc';

// ── Mock WebSocket ──────────────────────────────────────────────────

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

  // Test helpers
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  simulateMessage(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
  }

  simulateClose(code = 1006, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code, reason }));
  }

  simulateError(): void {
    this.onerror?.(new Event('error'));
  }
}

// ── URL construction ────────────────────────────────────────────────

describe('createChatSession URL construction', () => {
  let instances: MockWebSocket[];
  let factory: (url: string) => WebSocket;

  beforeEach(() => {
    instances = [];
    factory = (url: string) => {
      const ws = new MockWebSocket(url);
      instances.push(ws);
      return ws as unknown as WebSocket;
    };
  });

  it('uses the API-provided websocketUrl verbatim (no sessionId, no second token)', () => {
    createChatSession({
      sessionId: 'ses_123',
      token: 'tok_ignored',
      websocketUrl: CANONICAL_URL,
      createWebSocket: factory,
    });

    expect(instances).toHaveLength(1);
    const ws0 = instances[0] as MockWebSocket;
    // Exactly the URL the API returned — untouched.
    expect(ws0.url).toBe(CANONICAL_URL);

    const parsed = new URL(ws0.url);
    expect(parsed.searchParams.getAll('token')).toEqual(['tok_abc']);
    expect(parsed.searchParams.has('sessionId')).toBe(false);
    // Single '?' — no double-'?' regression.
    expect(ws0.url.split('?')).toHaveLength(2);
  });

  it('safely appends token when the base URL has no query', () => {
    createChatSession({
      sessionId: 'ses_1',
      token: 'abc',
      websocketUrl: 'wss://host/v1/stream',
      createWebSocket: factory,
    });

    const ws0 = instances[0] as MockWebSocket;
    const parsed = new URL(ws0.url);
    expect(ws0.url.split('?')).toHaveLength(2); // exactly one '?'
    expect(parsed.searchParams.get('token')).toBe('abc');
    expect(parsed.searchParams.has('sessionId')).toBe(false);
  });

  it('safely appends token when the base URL already has an unrelated query param', () => {
    createChatSession({
      sessionId: 'ses_1',
      token: 'abc',
      websocketUrl: 'wss://host/v1/stream?region=us',
      createWebSocket: factory,
    });

    const ws0 = instances[0] as MockWebSocket;
    const parsed = new URL(ws0.url);
    // Params joined by '&' under a single '?', proving no double-'?'.
    expect(ws0.url.split('?')).toHaveLength(2);
    expect(ws0.url).toContain('&');
    expect(parsed.searchParams.get('region')).toBe('us');
    expect(parsed.searchParams.get('token')).toBe('abc');
    expect(parsed.searchParams.has('sessionId')).toBe(false);
  });

  it('never emits a sessionId query parameter across construction paths', () => {
    const cases = [
      CANONICAL_URL,
      'wss://host/v1/stream',
      'wss://host/v1/stream?region=us',
    ];
    for (const websocketUrl of cases) {
      instances = [];
      createChatSession({
        sessionId: 'ses_should_not_appear',
        token: 'abc',
        websocketUrl,
        createWebSocket: factory,
      });
      const ws0 = instances[0] as MockWebSocket;
      expect(new URL(ws0.url).searchParams.has('sessionId')).toBe(false);
      expect(ws0.url).not.toContain('sessionId');
    }
  });

  it('throws (no hardcoded /ws default) when websocketUrl is missing', () => {
    expect(() =>
      createChatSession({
        sessionId: 'ses_1',
        token: 'tok_1',
        createWebSocket: factory,
      }),
    ).toThrow(/requires a websocketUrl/);
    // No stray connection was opened.
    expect(instances).toHaveLength(0);
  });

  it('throws on an unparseable websocketUrl instead of passing garbage to the socket', () => {
    expect(() =>
      createChatSession({
        sessionId: 'ses_1',
        token: 'tok_1',
        websocketUrl: 'not a url',
        createWebSocket: factory,
      }),
    ).toThrow(/invalid websocketUrl/);
    expect(instances).toHaveLength(0);
  });
});

// ── Protocol compatibility at connect time (WS-37) ──────────────────

describe('createChatSession protocol compatibility', () => {
  let instances: MockWebSocket[];
  let factory: (url: string) => WebSocket;

  beforeEach(() => {
    instances = [];
    factory = (url: string) => {
      const ws = new MockWebSocket(url);
      instances.push(ws);
      return ws as unknown as WebSocket;
    };
  });

  it('throws INCOMPATIBLE_VERSION and never opens a socket on mismatch', () => {
    // react build speaks API_PROTOCOL_VERSION '1'; server advertises '2' → too new.
    let caught: unknown;
    try {
      createChatSession({
        sessionId: 'ses_1',
        token: 'tok_1',
        websocketUrl: CANONICAL_URL,
        serverProtocolVersion: '2',
        createWebSocket: factory,
      });
    } catch (e) {
      caught = e;
    }

    expect(isSwiftAgentError(caught)).toBe(true);
    if (!isSwiftAgentError(caught)) throw new Error('unreachable');
    expect(caught.code).toBe('INCOMPATIBLE_VERSION');
    // The socket factory must NOT have been invoked — no connection was opened.
    expect(instances).toHaveLength(0);
  });

  it('connects normally on a compatible version (URL unchanged from WS-34)', () => {
    createChatSession({
      sessionId: 'ses_1',
      token: 'tok_1',
      websocketUrl: CANONICAL_URL,
      serverProtocolVersion: '1',
      createWebSocket: factory,
    });

    expect(instances).toHaveLength(1);
    expect((instances[0] as MockWebSocket).url).toBe(CANONICAL_URL);
  });

  it('connects normally when the version is absent (legacy server, fail-open)', () => {
    createChatSession({
      sessionId: 'ses_1',
      token: 'tok_1',
      websocketUrl: CANONICAL_URL,
      serverProtocolVersion: undefined,
      createWebSocket: factory,
    });

    expect(instances).toHaveLength(1);
    expect((instances[0] as MockWebSocket).url).toBe(CANONICAL_URL);
  });
});

// ── Lifecycle & messaging ───────────────────────────────────────────

describe('createChatSession', () => {
  let instances: MockWebSocket[];
  let factory: (url: string) => WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    instances = [];
    factory = (url: string) => {
      const ws = new MockWebSocket(url);
      instances.push(ws);
      return ws as unknown as WebSocket;
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('connects to the canonical URL verbatim', () => {
    createChatSession({
      sessionId: 'ses_123',
      token: 'tok_abc',
      websocketUrl: CANONICAL_URL,
      createWebSocket: factory,
    });

    expect(instances).toHaveLength(1);
    const ws0 = instances[0] as MockWebSocket;
    expect(ws0.url).toBe(CANONICAL_URL);
  });

  it('transitions connecting → connected on open', () => {
    const statusChanges: ConnectionStatus[] = [];
    const client = createChatSession({
      sessionId: 'ses_1',
      token: 'tok_1',
      websocketUrl: CANONICAL_URL,
      createWebSocket: factory,
    }) as ReturnType<typeof createChatSession> & {
      onStatusChange: (h: (s: ConnectionStatus) => void) => () => void;
    };

    client.onStatusChange((s) => statusChanges.push(s));

    expect(client.connectionStatus).toBe('connecting');
    (instances[0] as MockWebSocket).simulateOpen();
    expect(client.connectionStatus).toBe('connected');
    expect(statusChanges).toContain('connected');
  });

  it('parses inbound frames as ChatEvent and calls onEvent handlers', () => {
    const events: unknown[] = [];
    const client = createChatSession({
      sessionId: 'ses_1',
      token: 'tok_1',
      websocketUrl: CANONICAL_URL,
      createWebSocket: factory,
    });

    client.onEvent((e) => events.push(e));
    (instances[0] as MockWebSocket).simulateOpen();

    (instances[0] as MockWebSocket).simulateMessage({
      type: 'message_started',
      messageId: 'msg_1',
      runId: 'run_1',
      sessionId: 'ses_1',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'message_started',
      messageId: 'msg_1',
      runId: 'run_1',
      sessionId: 'ses_1',
    });
  });

  it('calls onError for malformed frames without crashing', () => {
    const errors: unknown[] = [];
    const client = createChatSession({
      sessionId: 'ses_1',
      token: 'tok_1',
      websocketUrl: CANONICAL_URL,
      createWebSocket: factory,
      onError: (err) => errors.push(err),
    });

    client.onEvent(() => {});
    (instances[0] as MockWebSocket).simulateOpen();

    // Send invalid data
    (instances[0] as MockWebSocket).simulateMessage({ type: 'unknown_event', bad: true });
    expect(errors).toHaveLength(1);
  });

  it('sendMessage emits correct JSON when connected', () => {
    const client = createChatSession({
      sessionId: 'ses_1',
      token: 'tok_1',
      websocketUrl: CANONICAL_URL,
      createWebSocket: factory,
    });

    (instances[0] as MockWebSocket).simulateOpen();
    client.sendMessage('hello');

    const ws0 = instances[0] as MockWebSocket;
    expect(ws0.sent).toHaveLength(1);
    expect(JSON.parse(ws0.sent[0] as string)).toEqual({
      type: 'send_message',
      content: 'hello',
    });
  });

  it('queues messages when disconnected and flushes on reconnect', () => {
    const client = createChatSession({
      sessionId: 'ses_1',
      token: 'tok_1',
      websocketUrl: CANONICAL_URL,
      createWebSocket: factory,
      reconnect: { maxRetries: 3, baseDelayMs: 100 },
    });

    // Send before connected
    client.sendMessage('queued msg');
    const ws0 = instances[0] as MockWebSocket;
    expect(ws0.sent).toHaveLength(0);

    ws0.simulateOpen();
    // Queue should flush
    expect(ws0.sent).toHaveLength(1);
    expect(JSON.parse(ws0.sent[0] as string)).toEqual({
      type: 'send_message',
      content: 'queued msg',
    });
  });

  it('unsubscribing from onEvent stops receiving events', () => {
    const events: unknown[] = [];
    const client = createChatSession({
      sessionId: 'ses_1',
      token: 'tok_1',
      websocketUrl: CANONICAL_URL,
      createWebSocket: factory,
    });

    const unsub = client.onEvent((e) => events.push(e));
    const ws0 = instances[0] as MockWebSocket;
    ws0.simulateOpen();

    ws0.simulateMessage({
      type: 'token',
      messageId: 'msg_1',
      runId: 'run_1',
      sessionId: 'ses_1',
      text: 'hi',
    });
    expect(events).toHaveLength(1);

    unsub();
    ws0.simulateMessage({
      type: 'token',
      messageId: 'msg_1',
      runId: 'run_1',
      sessionId: 'ses_1',
      text: 'bye',
    });
    expect(events).toHaveLength(1); // no new event
  });

  it('disconnect is idempotent and prevents reconnection', () => {
    const client = createChatSession({
      sessionId: 'ses_1',
      token: 'tok_1',
      websocketUrl: CANONICAL_URL,
      createWebSocket: factory,
    });

    (instances[0] as MockWebSocket).simulateOpen();
    client.disconnect();
    expect(client.connectionStatus).toBe('disconnected');

    // Calling disconnect again should not throw
    client.disconnect();
    expect(client.connectionStatus).toBe('disconnected');
  });
});

describe('reconnection', () => {
  let instances: MockWebSocket[];
  let factory: (url: string) => WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    instances = [];
    factory = (url: string) => {
      const ws = new MockWebSocket(url);
      instances.push(ws);
      return ws as unknown as WebSocket;
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reconnects with exponential backoff after close', () => {
    createChatSession({
      sessionId: 'ses_1',
      token: 'tok_1',
      websocketUrl: CANONICAL_URL,
      createWebSocket: factory,
      reconnect: { maxRetries: 3, baseDelayMs: 100 },
    });

    (instances[0] as MockWebSocket).simulateOpen();
    (instances[0] as MockWebSocket).simulateClose();
    expect(instances).toHaveLength(1); // not yet reconnected

    // After 100ms (baseDelay * 2^0)
    vi.advanceTimersByTime(100);
    expect(instances).toHaveLength(2); // first reconnect

    (instances[1] as MockWebSocket).simulateClose();
    // After 200ms (baseDelay * 2^1)
    vi.advanceTimersByTime(200);
    expect(instances).toHaveLength(3); // second reconnect

    (instances[2] as MockWebSocket).simulateClose();
    // After 400ms (baseDelay * 2^2)
    vi.advanceTimersByTime(400);
    expect(instances).toHaveLength(4); // third reconnect

    // After max retries, no more reconnections
    (instances[3] as MockWebSocket).simulateClose();
    vi.advanceTimersByTime(10000);
    expect(instances).toHaveLength(4); // no more
  });

  it('reconnects to the same correctly-constructed URL', () => {
    createChatSession({
      sessionId: 'ses_1',
      token: 'tok_1',
      websocketUrl: CANONICAL_URL,
      createWebSocket: factory,
      reconnect: { maxRetries: 3, baseDelayMs: 100 },
    });

    (instances[0] as MockWebSocket).simulateOpen();
    (instances[0] as MockWebSocket).simulateClose();
    vi.advanceTimersByTime(100);

    expect(instances).toHaveLength(2);
    const ws1 = instances[1] as MockWebSocket;
    // Reconnect reuses the exact same URL — no re-appended token/sessionId.
    expect(ws1.url).toBe(CANONICAL_URL);
    expect(ws1.url).toBe((instances[0] as MockWebSocket).url);
  });

  it('flushes queued messages after reconnect', () => {
    const client = createChatSession({
      sessionId: 'ses_1',
      token: 'tok_1',
      websocketUrl: CANONICAL_URL,
      createWebSocket: factory,
      reconnect: { maxRetries: 3, baseDelayMs: 100 },
    });

    (instances[0] as MockWebSocket).simulateOpen();
    (instances[0] as MockWebSocket).simulateClose();

    // Queue a message while disconnected
    client.sendMessage('offline msg');

    // Reconnect
    vi.advanceTimersByTime(100);
    expect(instances).toHaveLength(2);
    const ws1 = instances[1] as MockWebSocket;
    ws1.simulateOpen();

    // Message should be flushed to the new connection
    expect(ws1.sent).toHaveLength(1);
    expect(JSON.parse(ws1.sent[0] as string)).toEqual({
      type: 'send_message',
      content: 'offline msg',
    });
  });

  it('resets retry count after successful reconnect', () => {
    createChatSession({
      sessionId: 'ses_1',
      token: 'tok_1',
      websocketUrl: CANONICAL_URL,
      createWebSocket: factory,
      reconnect: { maxRetries: 2, baseDelayMs: 100 },
    });

    // First disconnect cycle
    (instances[0] as MockWebSocket).simulateOpen();
    (instances[0] as MockWebSocket).simulateClose();
    vi.advanceTimersByTime(100);
    (instances[1] as MockWebSocket).simulateOpen(); // successful reconnect resets count

    // Second disconnect cycle — should have full retries again
    (instances[1] as MockWebSocket).simulateClose();
    vi.advanceTimersByTime(100);
    expect(instances).toHaveLength(3); // reconnect attempt works
  });
});

// ── Typed close/error surfacing (WS-41) ─────────────────────────────

describe('abnormal / auth close surfacing', () => {
  let instances: MockWebSocket[];
  let factory: (url: string) => WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    instances = [];
    factory = (url: string) => {
      const ws = new MockWebSocket(url);
      instances.push(ws);
      return ws as unknown as WebSocket;
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('surfaces a typed UNAUTHORIZED error on a 4001 close and still reconnects (WS-34 intact)', () => {
    const errors: unknown[] = [];
    createChatSession({
      sessionId: 'ses_1',
      token: 'tok_1',
      websocketUrl: CANONICAL_URL,
      createWebSocket: factory,
      reconnect: { maxRetries: 3, baseDelayMs: 100 },
      onError: (e) => errors.push(e),
    });

    const ws0 = instances[0] as MockWebSocket;
    ws0.simulateOpen();
    ws0.simulateClose(4001, 'Missing token');

    // onError got a real (Swift Agent) Error — never a raw DOM Event.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(isSwiftAgentError(errors[0])).toBe(true);
    expect((errors[0] as SwiftAgentError).code).toBe('UNAUTHORIZED');
    const message = (errors[0] as Error).message;
    expect(message).toContain('4001');
    expect(message).not.toContain('[object');

    // Reconnect/backoff (WS-34) is unbroken — the factory is re-invoked after the delay.
    vi.advanceTimersByTime(100);
    expect(instances).toHaveLength(2);
  });

  it('surfaces a typed CONNECTION_ERROR on a non-1000 abnormal close', () => {
    const errors: unknown[] = [];
    createChatSession({
      sessionId: 'ses_1',
      token: 'tok_1',
      websocketUrl: CANONICAL_URL,
      createWebSocket: factory,
      reconnect: { maxRetries: 3, baseDelayMs: 100 },
      onError: (e) => errors.push(e),
    });

    const ws0 = instances[0] as MockWebSocket;
    ws0.simulateOpen();
    ws0.simulateClose(1006, 'Abnormal');

    expect(errors).toHaveLength(1);
    expect(isSwiftAgentError(errors[0])).toBe(true);
    expect((errors[0] as SwiftAgentError).code).toBe('CONNECTION_ERROR');
  });

  it('does NOT surface an error on a normal 1000 close', () => {
    const errors: unknown[] = [];
    createChatSession({
      sessionId: 'ses_1',
      token: 'tok_1',
      websocketUrl: CANONICAL_URL,
      createWebSocket: factory,
      reconnect: { maxRetries: 3, baseDelayMs: 100 },
      onError: (e) => errors.push(e),
    });

    const ws0 = instances[0] as MockWebSocket;
    ws0.simulateOpen();
    ws0.simulateClose(1000, 'Normal');

    expect(errors).toHaveLength(0);
  });
});
