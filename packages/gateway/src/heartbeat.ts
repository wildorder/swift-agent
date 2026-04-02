import type { WebSocket } from 'ws';
import { DEFAULT_HEARTBEAT_TIMEOUT_MS } from './types.js';

interface HeartbeatEntry {
  alive: boolean;
  pingTimer: ReturnType<typeof setInterval>;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Manages WebSocket heartbeat (ping/pong) for connection liveness detection.
 *
 * Strategy:
 * - Send ws-level ping at half the timeout interval.
 * - If no pong is received within the full timeout, terminate the socket.
 * - On pong, reset the alive flag.
 */
export class HeartbeatManager {
  private readonly sockets = new Map<WebSocket, HeartbeatEntry>();
  private readonly timeoutMs: number;
  private readonly intervalMs: number;

  constructor(timeoutMs: number = DEFAULT_HEARTBEAT_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
    this.intervalMs = Math.floor(timeoutMs / 2);
  }

  /** Start heartbeat monitoring for a socket. */
  attach(ws: WebSocket): void {
    const entry: HeartbeatEntry = {
      alive: true,
      pingTimer: setInterval(() => this.sendPing(ws), this.intervalMs),
      timeoutTimer: null,
    };

    // Listen for pong frames
    ws.on('pong', () => {
      entry.alive = true;
      if (entry.timeoutTimer !== null) {
        clearTimeout(entry.timeoutTimer);
        entry.timeoutTimer = null;
      }
    });

    this.sockets.set(ws, entry);
  }

  /** Stop heartbeat monitoring for a socket. */
  detach(ws: WebSocket): void {
    const entry = this.sockets.get(ws);
    if (!entry) return;

    clearInterval(entry.pingTimer);
    if (entry.timeoutTimer !== null) {
      clearTimeout(entry.timeoutTimer);
    }
    this.sockets.delete(ws);
  }

  /** Stop all heartbeat timers (for graceful shutdown). */
  clear(): void {
    for (const [, entry] of this.sockets) {
      clearInterval(entry.pingTimer);
      if (entry.timeoutTimer !== null) {
        clearTimeout(entry.timeoutTimer);
      }
    }
    this.sockets.clear();
  }

  private sendPing(ws: WebSocket): void {
    const entry = this.sockets.get(ws);
    if (!entry) return;

    if (!entry.alive) {
      // No pong received since last ping — terminate
      this.detach(ws);
      ws.terminate();
      return;
    }

    entry.alive = false;
    try {
      ws.ping();
    } catch {
      // Socket is dead
      this.detach(ws);
      ws.terminate();
      return;
    }

    // Set a hard timeout — if no pong arrives within timeoutMs, kill it
    entry.timeoutTimer = setTimeout(() => {
      if (!entry.alive) {
        this.detach(ws);
        ws.terminate();
      }
    }, this.timeoutMs);
  }
}
