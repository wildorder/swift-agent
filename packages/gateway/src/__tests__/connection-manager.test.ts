import { describe, it, expect, beforeEach } from 'vitest';
import { ConnectionManager } from '../connection-manager.js';
import type { WebSocket } from 'ws';
import type { ChatEvent } from '@swiftagent/shared';

/** Create a minimal mock WebSocket for testing. */
function createMockWs(readyState = 1): WebSocket {
  const sent: string[] = [];
  const ws = {
    readyState,
    OPEN: 1,
    CONNECTING: 0,
    CLOSING: 2,
    CLOSED: 3,
    send: (data: string) => { sent.push(data); },
    close: (_code?: number, _reason?: string) => { ws.readyState = 3; },
    terminate: () => { ws.readyState = 3; },
    ping: () => {},
    on: () => ws,
    // expose captured sends for assertions
    __sent: sent,
  };
  return ws as unknown as WebSocket;
}

function getSent(ws: WebSocket): string[] {
  return (ws as unknown as { __sent: string[] }).__sent;
}

describe('ConnectionManager', () => {
  let cm: ConnectionManager;

  beforeEach(() => {
    cm = new ConnectionManager();
  });

  describe('add / remove', () => {
    it('registers a socket and reports isConnected', () => {
      const ws = createMockWs();
      cm.add('ses_1', ws);

      expect(cm.isConnected('ses_1')).toBe(true);
      expect(cm.connectionCount()).toBe(1);
      expect(cm.sessionCount()).toBe(1);
    });

    it('allows multiple sockets per session', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      cm.add('ses_1', ws1);
      cm.add('ses_1', ws2);

      expect(cm.connectionCount()).toBe(2);
      expect(cm.sessionCount()).toBe(1);
    });

    it('removing one socket leaves the other', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      cm.add('ses_1', ws1);
      cm.add('ses_1', ws2);

      cm.remove('ses_1', ws1);

      expect(cm.isConnected('ses_1')).toBe(true);
      expect(cm.connectionCount()).toBe(1);
    });

    it('removing the last socket makes isConnected false and cleans up session', () => {
      const ws = createMockWs();
      cm.add('ses_1', ws);
      cm.remove('ses_1', ws);

      expect(cm.isConnected('ses_1')).toBe(false);
      expect(cm.sessionCount()).toBe(0);
    });

    it('removing from unknown session is a no-op', () => {
      const ws = createMockWs();
      expect(() => cm.remove('ses_unknown', ws)).not.toThrow();
    });

    it('adding the same socket twice does not duplicate', () => {
      const ws = createMockWs();
      cm.add('ses_1', ws);
      cm.add('ses_1', ws);

      // Set stores unique values, so count should still be 1
      expect(cm.connectionCount()).toBe(1);
    });
  });

  describe('broadcast', () => {
    it('delivers serialized event to all sockets in session', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      cm.add('ses_1', ws1);
      cm.add('ses_1', ws2);

      const event: ChatEvent = {
        type: 'token',
        runId: 'run_1',
        sessionId: 'ses_1',
        messageId: 'msg_1',
        text: 'hello',
      };

      cm.broadcast('ses_1', event);

      const expected = JSON.stringify(event);
      expect(getSent(ws1)).toEqual([expected]);
      expect(getSent(ws2)).toEqual([expected]);
    });

    it('does not deliver to sockets in other sessions', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      cm.add('ses_1', ws1);
      cm.add('ses_2', ws2);

      const event: ChatEvent = {
        type: 'message_started',
        messageId: 'msg_1',
        runId: 'run_1',
        sessionId: 'ses_1',
      };

      cm.broadcast('ses_1', event);

      expect(getSent(ws1).length).toBe(1);
      expect(getSent(ws2).length).toBe(0);
    });

    it('broadcasting to unknown session is a no-op', () => {
      const event: ChatEvent = {
        type: 'token',
        runId: 'run_1',
        sessionId: 'ses_x',
        messageId: 'msg_1',
        text: 'hello',
      };
      expect(() => cm.broadcast('ses_x', event)).not.toThrow();
    });

    it('removes sockets with non-OPEN readyState during broadcast', () => {
      const ws1 = createMockWs(1); // OPEN
      const ws2 = createMockWs(3); // CLOSED
      cm.add('ses_1', ws1);
      cm.add('ses_1', ws2);

      const event: ChatEvent = {
        type: 'token',
        runId: 'run_1',
        sessionId: 'ses_1',
        messageId: 'msg_1',
        text: 'hello',
      };

      cm.broadcast('ses_1', event);

      // ws2 should have been removed
      expect(cm.connectionCount()).toBe(1);
      expect(getSent(ws1).length).toBe(1);
      expect(getSent(ws2).length).toBe(0);
    });
  });

  describe('sendTo', () => {
    it('sends data to a specific socket', () => {
      const ws = createMockWs();
      cm.add('ses_1', ws);
      cm.sendTo('ses_1', ws, '{"type":"pong"}');
      expect(getSent(ws)).toEqual(['{"type":"pong"}']);
    });
  });

  describe('sendError', () => {
    it('sends a JSON-serialized error event', () => {
      const ws = createMockWs();
      cm.add('ses_1', ws);
      cm.sendError('ses_1', ws, { type: 'error', code: 'TEST', message: 'oops' });
      expect(getSent(ws)).toEqual([JSON.stringify({ type: 'error', code: 'TEST', message: 'oops' })]);
    });
  });

  describe('getConnections', () => {
    it('returns empty set for unknown session', () => {
      const conns = cm.getConnections('ses_unknown');
      expect(conns.size).toBe(0);
    });

    it('returns all connections for a session', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      cm.add('ses_1', ws1);
      cm.add('ses_1', ws2);

      const conns = cm.getConnections('ses_1');
      expect(conns.size).toBe(2);
      expect(conns.has(ws1)).toBe(true);
      expect(conns.has(ws2)).toBe(true);
    });
  });

  describe('closeAll', () => {
    it('closes all sockets and clears state', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      cm.add('ses_1', ws1);
      cm.add('ses_2', ws2);

      cm.closeAll(1001, 'Server shutting down');

      expect(cm.connectionCount()).toBe(0);
      expect(cm.sessionCount()).toBe(0);
      expect(cm.isConnected('ses_1')).toBe(false);
      expect(cm.isConnected('ses_2')).toBe(false);
    });
  });
});
