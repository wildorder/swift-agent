import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionBridge, createSessionBridge, createNoopRedisPubSub } from '../session-bridge.js';
import { ConnectionManager } from '../connection-manager.js';
import type { RuntimeDelegate } from '../types.js';
import type { ChatEvent } from '@swiftagent/shared';
import { SwiftAgentError, SwiftAgentErrorCode } from '@swiftagent/shared';
import type { WebSocket } from 'ws';

/** Create a minimal mock WebSocket. */
function createMockWs(): WebSocket {
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    CONNECTING: 0,
    CLOSING: 2,
    CLOSED: 3,
    send: (data: string) => { sent.push(data); },
    close: vi.fn(),
    terminate: vi.fn(),
    ping: vi.fn(),
    on: vi.fn().mockReturnThis(),
    __sent: sent,
  };
  return ws as unknown as WebSocket;
}

function getSent(ws: WebSocket): string[] {
  return (ws as unknown as { __sent: string[] }).__sent;
}

/** Create a mock async runtime that forwards a preset event sequence. */
function createAsyncMockRuntime(events: ChatEvent[]): RuntimeDelegate {
  return {
    start: vi.fn(async (_input, opts?: { onEvent?: (e: ChatEvent) => void }) => {
      for (const event of events) {
        opts?.onEvent?.(event);
      }
      return { runId: 'run_1' };
    }) as unknown as RuntimeDelegate['start'],
    requestCancel: vi.fn(async () => ({ requested: true })) as RuntimeDelegate['requestCancel'],
  };
}

/** Create a runtime that rejects from start(). */
function createThrowingRuntime(error: Error): RuntimeDelegate {
  return {
    start: vi.fn(async () => {
      throw error;
    }) as unknown as RuntimeDelegate['start'],
    requestCancel: vi.fn(async () => ({ requested: true })) as RuntimeDelegate['requestCancel'],
  };
}

const SESSION_ID = 'ses_test123';

function makeTokenEvent(text: string): ChatEvent {
  return {
    type: 'token',
    runId: 'run_1',
    sessionId: SESSION_ID,
    messageId: 'msg_1',
    text,
  };
}

function makeStartEvent(): ChatEvent {
  return {
    type: 'message_started',
    messageId: 'msg_1',
    runId: 'run_1',
    sessionId: SESSION_ID,
  };
}

function makeCompletedEvent(): ChatEvent {
  return {
    type: 'message_completed',
    messageId: 'msg_1',
    runId: 'run_1',
    sessionId: SESSION_ID,
  };
}

describe('SessionBridge', () => {
  let cm: ConnectionManager;

  beforeEach(() => {
    cm = new ConnectionManager();
  });

  describe('handleSendMessage', () => {
    it('broadcasts all events from runtime to session connections', async () => {
      const events: ChatEvent[] = [
        makeStartEvent(),
        makeTokenEvent('Hello'),
        makeTokenEvent(' world'),
        makeCompletedEvent(),
      ];

      const runtime = createAsyncMockRuntime(events);
      const bridge = createSessionBridge({ connectionManager: cm, runtime });

      const ws1 = createMockWs();
      const ws2 = createMockWs();
      cm.add(SESSION_ID, ws1);
      cm.add(SESSION_ID, ws2);

      await bridge.handleSendMessage(SESSION_ID, 'Hi', ws1);

      // Both sockets should have received all 4 events
      expect(getSent(ws1).length).toBe(4);
      expect(getSent(ws2).length).toBe(4);

      // Verify event content
      const firstEvent = JSON.parse(getSent(ws1)[0]);
      expect(firstEvent.type).toBe('message_started');

      const tokenEvent = JSON.parse(getSent(ws1)[1]);
      expect(tokenEvent.type).toBe('token');
      expect(tokenEvent.text).toBe('Hello');
    });

    it('sends error to sender only on CONFLICT (RUN_IN_PROGRESS)', async () => {
      const conflictError = new SwiftAgentError(
        SwiftAgentErrorCode.CONFLICT,
        'A run is already in progress',
      );
      const runtime = createThrowingRuntime(conflictError);
      const bridge = createSessionBridge({ connectionManager: cm, runtime });

      const senderWs = createMockWs();
      const otherWs = createMockWs();
      cm.add(SESSION_ID, senderWs);
      cm.add(SESSION_ID, otherWs);

      await bridge.handleSendMessage(SESSION_ID, 'Hi', senderWs);

      // Only the sender should get the error
      expect(getSent(senderWs).length).toBe(1);
      const errorEvent = JSON.parse(getSent(senderWs)[0]);
      expect(errorEvent.type).toBe('error');
      expect(errorEvent.code).toBe('RUN_IN_PROGRESS');

      // Other socket should not receive anything
      expect(getSent(otherWs).length).toBe(0);
    });

    it('sends RUNTIME_ERROR to sender for non-conflict errors', async () => {
      const runtime = createThrowingRuntime(new Error('Something broke'));
      const bridge = createSessionBridge({ connectionManager: cm, runtime });

      const ws = createMockWs();
      cm.add(SESSION_ID, ws);

      await bridge.handleSendMessage(SESSION_ID, 'Hi', ws);

      expect(getSent(ws).length).toBe(1);
      const errorEvent = JSON.parse(getSent(ws)[0]);
      expect(errorEvent.type).toBe('error');
      expect(errorEvent.code).toBe('RUNTIME_ERROR');
    });

    it('clears replay buffer after successful run', async () => {
      const events: ChatEvent[] = [makeStartEvent(), makeCompletedEvent()];
      const runtime = createAsyncMockRuntime(events);
      const bridge = createSessionBridge({ connectionManager: cm, runtime });

      const ws = createMockWs();
      cm.add(SESSION_ID, ws);

      await bridge.handleSendMessage(SESSION_ID, 'Hi', ws);

      expect(bridge.hasActiveRun(SESSION_ID)).toBe(false);
    });
  });

  describe('replayEvents', () => {
    it('replays buffered events to a reconnecting socket', async () => {
      // We need a runtime that doesn't complete immediately so the buffer persists.
      // Instead, we'll create a bridge and inject a buffer via handleSendMessage
      // with a generator that never completes.
      let resolveGenerator: (() => void) | undefined;

      const runtime: RuntimeDelegate = {
        start: vi.fn(async (_input, opts?: { onEvent?: (e: ChatEvent) => void }) => {
          opts?.onEvent?.(makeStartEvent());
          opts?.onEvent?.(makeTokenEvent('Hello'));
          // Hang here to simulate an in-progress run
          await new Promise<void>((resolve) => {
            resolveGenerator = resolve;
          });
          opts?.onEvent?.(makeCompletedEvent());
          return { runId: 'run_1' };
        }) as unknown as RuntimeDelegate['start'],
        requestCancel: vi.fn(async () => ({ requested: true })) as RuntimeDelegate['requestCancel'],
      };

      const bridge = createSessionBridge({ connectionManager: cm, runtime });

      const ws1 = createMockWs();
      cm.add(SESSION_ID, ws1);

      // Start the run (will hang at the await)
      const runPromise = bridge.handleSendMessage(SESSION_ID, 'Hi', ws1);

      // Wait a tick for the generator to yield the first two events
      await new Promise((r) => setTimeout(r, 10));

      expect(bridge.hasActiveRun(SESSION_ID)).toBe(true);

      // Now simulate a reconnect with a new socket
      const ws2 = createMockWs();
      cm.add(SESSION_ID, ws2);
      const replayedCount = bridge.replayEvents(SESSION_ID, ws2);

      expect(replayedCount).toBe(2);
      expect(getSent(ws2).length).toBe(2);

      const replayed1 = JSON.parse(getSent(ws2)[0]);
      expect(replayed1.type).toBe('message_started');

      const replayed2 = JSON.parse(getSent(ws2)[1]);
      expect(replayed2.type).toBe('token');
      expect(replayed2.text).toBe('Hello');

      // Let the generator finish
      if (resolveGenerator) resolveGenerator();
      await runPromise;
    });

    it('returns 0 when no active run', () => {
      const runtime = createAsyncMockRuntime([]);
      const bridge = createSessionBridge({ connectionManager: cm, runtime });

      const ws = createMockWs();
      cm.add(SESSION_ID, ws);

      expect(bridge.replayEvents(SESSION_ID, ws)).toBe(0);
    });
  });

  describe('clearReplayBuffer', () => {
    it('removes the replay buffer for a session', async () => {
      let resolveGenerator: (() => void) | undefined;
      const runtime: RuntimeDelegate = {
        start: vi.fn(async (_input, opts?: { onEvent?: (e: ChatEvent) => void }) => {
          opts?.onEvent?.(makeStartEvent());
          await new Promise<void>((resolve) => { resolveGenerator = resolve; });
          return { runId: 'run_1' };
        }) as unknown as RuntimeDelegate['start'],
        requestCancel: vi.fn(async () => ({ requested: true })) as RuntimeDelegate['requestCancel'],
      };

      const bridge = createSessionBridge({ connectionManager: cm, runtime });
      const ws = createMockWs();
      cm.add(SESSION_ID, ws);

      const runPromise = bridge.handleSendMessage(SESSION_ID, 'Hi', ws);
      await new Promise((r) => setTimeout(r, 10));

      expect(bridge.hasActiveRun(SESSION_ID)).toBe(true);
      bridge.clearReplayBuffer(SESSION_ID);
      expect(bridge.hasActiveRun(SESSION_ID)).toBe(false);

      if (resolveGenerator) resolveGenerator();
      await runPromise;
    });
  });

  describe('shutdown', () => {
    it('clears replay buffers', async () => {
      const runtime = createAsyncMockRuntime([]);
      const bridge = createSessionBridge({ connectionManager: cm, runtime });

      await bridge.shutdown();
      // Should not throw
      expect(bridge.hasActiveRun(SESSION_ID)).toBe(false);
    });
  });

  describe('createNoopRedisPubSub', () => {
    it('returns a stub where all methods are no-ops', async () => {
      const redis = createNoopRedisPubSub();
      await expect(redis.publish('ch', 'msg')).resolves.toBeUndefined();
      await expect(redis.subscribe('ch', () => {})).resolves.toBeUndefined();
      await expect(redis.unsubscribe('ch')).resolves.toBeUndefined();
      await expect(redis.disconnect()).resolves.toBeUndefined();
    });
  });

  describe('createSessionBridge factory', () => {
    it('returns a SessionBridge instance', () => {
      const runtime = createAsyncMockRuntime([]);
      const bridge = createSessionBridge({ connectionManager: cm, runtime });
      expect(bridge).toBeInstanceOf(SessionBridge);
    });
  });
});
