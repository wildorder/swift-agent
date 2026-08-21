import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ChatEvent } from '@swiftagent/shared';
import { SessionBridge } from '../session-bridge.js';
import { ConnectionManager } from '../connection-manager.js';
import { parseInboundMessage, ParseError } from '../events.js';
import type { RuntimeDelegate } from '../types.js';
import type { WebSocket } from 'ws';

const SESSION_ID = 'ses_cancel123';
const RUN_ID = 'run_cancel123';

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

/**
 * A runtime whose run hangs after emitting `message_started` until an explicit
 * cancel is requested, at which point it emits a terminal `run_failed`
 * (code `CANCELLED`) — mirroring the real RunExecutionService.
 */
function createCancellableRuntime() {
  let onCancel: (() => void) | undefined;
  const requestCancel = vi.fn(async (_runId: string) => {
    onCancel?.();
    return { requested: true };
  });
  const start = vi.fn(async (
    input: { sessionId: string; content: string },
    opts?: { onEvent?: (e: ChatEvent) => void },
  ) => {
    opts?.onEvent?.({
      type: 'message_started',
      messageId: 'msg_1',
      runId: RUN_ID,
      sessionId: input.sessionId,
    });
    await new Promise<void>((resolve) => { onCancel = resolve; });
    opts?.onEvent?.({
      type: 'run_failed',
      runId: RUN_ID,
      sessionId: input.sessionId,
      code: 'CANCELLED',
      message: 'Run was cancelled',
    });
    return { runId: RUN_ID };
  });
  return { start, requestCancel } as unknown as RuntimeDelegate & {
    start: ReturnType<typeof vi.fn>;
    requestCancel: ReturnType<typeof vi.fn>;
  };
}

describe('gateway cancel protocol (WS-24)', () => {
  let cm: ConnectionManager;

  beforeEach(() => {
    cm = new ConnectionManager();
  });

  describe('parseInboundMessage', () => {
    it('parses an explicit cancel message', () => {
      expect(parseInboundMessage('{"type":"cancel"}')).toEqual({ type: 'cancel' });
    });

    it('rejects a cancel message carrying extra fields (strict)', () => {
      expect(() => parseInboundMessage('{"type":"cancel","runId":"run_1"}')).toThrow(ParseError);
    });
  });

  describe('handleCancel', () => {
    it('routes an explicit cancel to the active run and broadcasts the terminal event', async () => {
      const runtime = createCancellableRuntime();
      const bridge = new SessionBridge({ connectionManager: cm, runtime });

      const ws = createMockWs();
      cm.add(SESSION_ID, ws);

      // Start the run — hangs after message_started until cancelled.
      const runPromise = bridge.handleSendMessage(SESSION_ID, 'do work', ws);
      await vi.waitFor(() => expect(bridge.hasActiveRun(SESSION_ID)).toBe(true));

      await bridge.handleCancel(SESSION_ID);

      expect(runtime.requestCancel).toHaveBeenCalledWith(RUN_ID);

      await runPromise;

      // The terminal CANCELLED event was broadcast to the session's socket.
      const events = getSent(ws).map((raw) => JSON.parse(raw) as ChatEvent & { code?: string });
      const terminal = events.at(-1);
      expect(terminal?.type).toBe('run_failed');
      expect(terminal?.code).toBe('CANCELLED');
    });

    it('is a no-op when the session has no active run', async () => {
      const runtime = createCancellableRuntime();
      const bridge = new SessionBridge({ connectionManager: cm, runtime });

      await bridge.handleCancel(SESSION_ID);

      expect(runtime.requestCancel).not.toHaveBeenCalled();
    });
  });

  describe('disconnect policy', () => {
    it('a socket disconnect does NOT cancel a server-owned run (disconnect ≠ cancel)', async () => {
      const runtime = createCancellableRuntime();
      const bridge = new SessionBridge({ connectionManager: cm, runtime });

      const ws = createMockWs();
      cm.add(SESSION_ID, ws);

      const runPromise = bridge.handleSendMessage(SESSION_ID, 'do work', ws);
      await vi.waitFor(() => expect(bridge.hasActiveRun(SESSION_ID)).toBe(true));

      // Simulate the server's socket 'close' handler: remove the connection.
      // Crucially, this path must NOT invoke cancellation.
      cm.remove(SESSION_ID, ws);
      expect(runtime.requestCancel).not.toHaveBeenCalled();

      // The run is still in flight; only an explicit cancel ends it.
      expect(bridge.hasActiveRun(SESSION_ID)).toBe(true);

      // Drive it to a terminal state via an explicit cancel so the test settles.
      await bridge.handleCancel(SESSION_ID);
      await runPromise;
      expect(runtime.requestCancel).toHaveBeenCalledTimes(1);
    });
  });
});
