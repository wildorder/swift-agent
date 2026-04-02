import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HeartbeatManager } from '../heartbeat.js';
import type { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';

/** Create a mock WebSocket that supports event listeners (for pong). */
function createMockWs(): WebSocket & EventEmitter & { __terminated: boolean; __pinged: boolean } {
  const emitter = new EventEmitter();
  const ws = Object.assign(emitter, {
    readyState: 1,
    OPEN: 1,
    CONNECTING: 0,
    CLOSING: 2,
    CLOSED: 3,
    send: vi.fn(),
    close: vi.fn(),
    terminate: vi.fn(() => {
      ws.__terminated = true;
    }),
    ping: vi.fn(() => {
      ws.__pinged = true;
    }),
    __terminated: false,
    __pinged: false,
  });
  return ws as unknown as WebSocket & EventEmitter & { __terminated: boolean; __pinged: boolean };
}

describe('HeartbeatManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends ping at half the timeout interval', () => {
    const hb = new HeartbeatManager(10_000); // timeout=10s, interval=5s
    const ws = createMockWs();

    hb.attach(ws);

    // Advance to first ping (5s)
    vi.advanceTimersByTime(5_000);
    expect(ws.ping).toHaveBeenCalledTimes(1);

    hb.clear();
  });

  it('keeps socket alive when pong is received', () => {
    const hb = new HeartbeatManager(10_000);
    const ws = createMockWs();

    hb.attach(ws);

    // First ping at 5s
    vi.advanceTimersByTime(5_000);
    expect(ws.ping).toHaveBeenCalledTimes(1);

    // Simulate pong response
    ws.emit('pong');

    // Second ping at 10s
    vi.advanceTimersByTime(5_000);
    expect(ws.ping).toHaveBeenCalledTimes(2);
    expect(ws.terminate).not.toHaveBeenCalled();

    hb.clear();
  });

  it('terminates socket when no pong received before next ping', () => {
    const hb = new HeartbeatManager(10_000);
    const ws = createMockWs();

    hb.attach(ws);

    // First ping at 5s — sets alive=false, sends ping
    vi.advanceTimersByTime(5_000);
    expect(ws.ping).toHaveBeenCalledTimes(1);

    // No pong. Second ping at 10s — alive is still false, so terminate
    vi.advanceTimersByTime(5_000);
    expect(ws.terminate).toHaveBeenCalledTimes(1);

    hb.clear();
  });

  it('terminates socket on hard timeout when no pong arrives', () => {
    const hb = new HeartbeatManager(10_000);
    const ws = createMockWs();

    hb.attach(ws);

    // First ping at 5s
    vi.advanceTimersByTime(5_000);
    expect(ws.ping).toHaveBeenCalledTimes(1);

    // Simulate pong so we don't terminate at next interval check
    ws.emit('pong');

    // Second ping at 10s
    vi.advanceTimersByTime(5_000);
    expect(ws.ping).toHaveBeenCalledTimes(2);

    // No pong this time. Hard timeout is 10s after second ping → at 20s
    vi.advanceTimersByTime(10_000);
    expect(ws.terminate).toHaveBeenCalled();

    hb.clear();
  });

  it('detach stops all timers for a socket', () => {
    const hb = new HeartbeatManager(10_000);
    const ws = createMockWs();

    hb.attach(ws);
    hb.detach(ws);

    // Advance past multiple intervals
    vi.advanceTimersByTime(30_000);
    expect(ws.ping).not.toHaveBeenCalled();
    expect(ws.terminate).not.toHaveBeenCalled();
  });

  it('clear stops all timers for all sockets', () => {
    const hb = new HeartbeatManager(10_000);
    const ws1 = createMockWs();
    const ws2 = createMockWs();

    hb.attach(ws1);
    hb.attach(ws2);
    hb.clear();

    vi.advanceTimersByTime(30_000);
    expect(ws1.ping).not.toHaveBeenCalled();
    expect(ws2.ping).not.toHaveBeenCalled();
  });

  it('terminates socket when ping() throws', () => {
    const hb = new HeartbeatManager(10_000);
    const ws = createMockWs();
    ws.ping = vi.fn(() => { throw new Error('socket dead'); });

    hb.attach(ws);

    // First ping at 5s should catch the error and terminate
    vi.advanceTimersByTime(5_000);
    expect(ws.terminate).toHaveBeenCalled();

    hb.clear();
  });
});
