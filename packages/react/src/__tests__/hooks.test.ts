import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgentChat } from '../hooks/use-agent-chat.js';
import type { ChatEvent } from '@swiftagent/shared';
import type { ChatMessage, ToolCallInfo } from '../types.js';

// Canonical API-provided URL (already tokenized). Required now that
// createChatSession has no hardcoded default and throws without one.
const CANONICAL_URL = 'wss://test.example.com/v1/stream?token=tok_abc';

// ── Mock WebSocket (same pattern as client tests) ───────────────────

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

  simulateClose(code = 1006, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code, reason }));
  }
}

// ── Tests ───────────────────────────────────────────────────────────

describe('useAgentChat', () => {
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

  it('starts with empty messages and disconnected status', () => {
    const { result } = renderHook(() =>
      useAgentChat({
        sessionId: 'ses_1',
        token: 'tok_1',
        websocketUrl: CANONICAL_URL,
        createWebSocket: factory,
      }),
    );

    expect(result.current.messages).toEqual([]);
    expect(result.current.isStreaming).toBe(false);
  });

  it('send() adds a user message and dispatches server events', async () => {
    const { result } = renderHook(() =>
      useAgentChat({
        sessionId: 'ses_1',
        token: 'tok_1',
        websocketUrl: CANONICAL_URL,
        createWebSocket: factory,
      }),
    );

    // Wait for connection
    act(() => {
      (instances[0] as MockWebSocket).simulateOpen();
    });

    // Send a message
    act(() => {
      result.current.send('hello');
    });

    expect(result.current.messages).toHaveLength(1);
    expect((result.current.messages[0] as ChatMessage).role).toBe('user');
    expect((result.current.messages[0] as ChatMessage).content).toBe('hello');
    expect((result.current.messages[0] as ChatMessage).status).toBe('pending');
    expect(result.current.isStreaming).toBe(true);

    // Simulate server response
    act(() => {
      (instances[0] as MockWebSocket).simulateMessage({
        type: 'message_started',
        messageId: 'msg_1',
        runId: 'run_1',
        sessionId: 'ses_1',
      } satisfies ChatEvent);
    });

    expect(result.current.messages).toHaveLength(2);
    expect((result.current.messages[1] as ChatMessage).role).toBe('assistant');
    expect((result.current.messages[1] as ChatMessage).status).toBe('streaming');

    // Stream tokens
    act(() => {
      (instances[0] as MockWebSocket).simulateMessage({
        type: 'token',
        messageId: 'msg_1',
        runId: 'run_1',
        sessionId: 'ses_1',
        text: 'Hi there!',
      } satisfies ChatEvent);
    });

    expect((result.current.messages[1] as ChatMessage).content).toBe('Hi there!');

    // Complete
    act(() => {
      (instances[0] as MockWebSocket).simulateMessage({
        type: 'message_completed',
        messageId: 'msg_1',
        runId: 'run_1',
        sessionId: 'ses_1',
      } satisfies ChatEvent);
    });

    expect((result.current.messages[1] as ChatMessage).status).toBe('complete');
    expect(result.current.isStreaming).toBe(false);
  });

  it('updates connectionStatus as WebSocket lifecycle changes', () => {
    const { result } = renderHook(() =>
      useAgentChat({
        sessionId: 'ses_1',
        token: 'tok_1',
        websocketUrl: CANONICAL_URL,
        createWebSocket: factory,
      }),
    );

    act(() => {
      (instances[0] as MockWebSocket).simulateOpen();
    });
    expect(result.current.connectionStatus).toBe('connected');

    act(() => {
      (instances[0] as MockWebSocket).simulateClose();
    });
    expect(result.current.connectionStatus).toBe('disconnected');
  });

  it('disconnects on unmount', () => {
    const { unmount } = renderHook(() =>
      useAgentChat({
        sessionId: 'ses_1',
        token: 'tok_1',
        websocketUrl: CANONICAL_URL,
        createWebSocket: factory,
      }),
    );

    act(() => {
      (instances[0] as MockWebSocket).simulateOpen();
    });

    const ws = instances[0] as MockWebSocket;
    unmount();

    // After unmount, the WebSocket should be closed
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
  });

  it('surfaces INCOMPATIBLE_VERSION via lastError and never connects on mismatch (WS-37)', () => {
    const { result } = renderHook(() =>
      useAgentChat({
        sessionId: 'ses_1',
        token: 'tok_1',
        websocketUrl: CANONICAL_URL,
        serverProtocolVersion: '2', // react speaks '1' → too new
        createWebSocket: factory,
      }),
    );

    // The synchronous assertion throw is caught inside the effect and routed to
    // lastError; the socket factory is never invoked.
    expect(instances).toHaveLength(0);
    expect(result.current.lastError).toBeTruthy();
    // The actionable message names both versions and which side to upgrade.
    expect(result.current.lastError).toContain('@swiftagent/sdk');
    expect(result.current.connectionStatus).toBe('disconnected');
  });

  it('connects normally on a compatible version through the hook (WS-37)', () => {
    const { result } = renderHook(() =>
      useAgentChat({
        sessionId: 'ses_1',
        token: 'tok_1',
        websocketUrl: CANONICAL_URL,
        serverProtocolVersion: '1',
        createWebSocket: factory,
      }),
    );

    expect(instances).toHaveLength(1);
    act(() => {
      (instances[0] as MockWebSocket).simulateOpen();
    });
    expect(result.current.connectionStatus).toBe('connected');
    expect(result.current.lastError).toBeNull();
  });

  it('sets lastError to a readable string on an auth (4001) close (WS-41)', () => {
    const { result } = renderHook(() =>
      useAgentChat({
        sessionId: 'ses_1',
        token: 'tok_1',
        websocketUrl: CANONICAL_URL,
        createWebSocket: factory,
      }),
    );

    act(() => {
      (instances[0] as MockWebSocket).simulateOpen();
    });
    act(() => {
      (instances[0] as MockWebSocket).simulateClose(4001, 'Missing token');
    });

    // A plain, readable string naming the close code — never `[object Event]`.
    expect(typeof result.current.lastError).toBe('string');
    expect(result.current.lastError).toContain('4001');
    expect(result.current.lastError).not.toContain('[object');
  });

  it('handles tool call events in messages', () => {
    const { result } = renderHook(() =>
      useAgentChat({
        sessionId: 'ses_1',
        token: 'tok_1',
        websocketUrl: CANONICAL_URL,
        createWebSocket: factory,
      }),
    );

    act(() => {
      (instances[0] as MockWebSocket).simulateOpen();
    });

    // Start assistant message
    act(() => {
      (instances[0] as MockWebSocket).simulateMessage({
        type: 'message_started',
        messageId: 'msg_1',
        runId: 'run_1',
        sessionId: 'ses_1',
      });
    });

    // Tool call started
    act(() => {
      (instances[0] as MockWebSocket).simulateMessage({
        type: 'tool_call_started',
        callId: 'tc_1',
        runId: 'run_1',
        sessionId: 'ses_1',
        toolName: 'lookupOrder',
      });
    });

    expect((result.current.messages[0] as ChatMessage).toolCalls).toEqual([
      { callId: 'tc_1', toolName: 'lookupOrder', status: 'started' },
    ]);

    // Tool call completed
    act(() => {
      (instances[0] as MockWebSocket).simulateMessage({
        type: 'tool_call_completed',
        callId: 'tc_1',
        runId: 'run_1',
        sessionId: 'ses_1',
        toolName: 'lookupOrder',
        status: 'completed',
      });
    });

    const toolCalls = (result.current.messages[0] as ChatMessage).toolCalls as ToolCallInfo[];
    expect((toolCalls[0] as ToolCallInfo).status).toBe('completed');
  });
});
