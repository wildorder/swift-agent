import type { WebSocket } from 'ws';
import type { ChatEvent, ErrorEvent } from './types.js';
import { serializeChatEvent } from './events.js';

/**
 * Manages WebSocket connections grouped by sessionId.
 * Multiple connections per session are first-class (e.g. multiple browser tabs).
 */
export class ConnectionManager {
  private readonly sessions = new Map<string, Set<WebSocket>>();

  /** Register a socket for a session. */
  add(sessionId: string, ws: WebSocket): void {
    let sockets = this.sessions.get(sessionId);
    if (!sockets) {
      sockets = new Set();
      this.sessions.set(sessionId, sockets);
    }
    sockets.add(ws);
  }

  /** Unregister a socket from a session. Cleans up empty sets. */
  remove(sessionId: string, ws: WebSocket): void {
    const sockets = this.sessions.get(sessionId);
    if (!sockets) return;
    sockets.delete(ws);
    if (sockets.size === 0) {
      this.sessions.delete(sessionId);
    }
  }

  /**
   * Broadcast a ChatEvent to all connections for a session.
   * Dead sockets (send errors) are silently removed.
   */
  broadcast(sessionId: string, event: ChatEvent): void {
    const sockets = this.sessions.get(sessionId);
    if (!sockets) return;

    const data = serializeChatEvent(event);
    for (const ws of sockets) {
      this.safeSend(sessionId, ws, data);
    }
  }

  /** Send a message to a single socket. Removes on error. */
  sendTo(sessionId: string, ws: WebSocket, data: string): void {
    this.safeSend(sessionId, ws, data);
  }

  /** Send an error event to a single socket. */
  sendError(sessionId: string, ws: WebSocket, error: ErrorEvent): void {
    this.safeSend(sessionId, ws, JSON.stringify(error));
  }

  /** Get all connections for a session (read-only view). */
  getConnections(sessionId: string): ReadonlySet<WebSocket> {
    return this.sessions.get(sessionId) ?? new Set();
  }

  /** Whether any connections exist for a session. */
  isConnected(sessionId: string): boolean {
    const sockets = this.sessions.get(sessionId);
    return sockets !== undefined && sockets.size > 0;
  }

  /** Total number of active connections across all sessions. */
  connectionCount(): number {
    let count = 0;
    for (const sockets of this.sessions.values()) {
      count += sockets.size;
    }
    return count;
  }

  /** Total number of active sessions. */
  sessionCount(): number {
    return this.sessions.size;
  }

  /** Get all session IDs with active connections. */
  allSessionIds(): IterableIterator<string> {
    return this.sessions.keys();
  }

  /** Close all connections (used during graceful shutdown). */
  closeAll(code: number, reason: string): void {
    for (const [, sockets] of this.sessions) {
      for (const ws of sockets) {
        try {
          ws.close(code, reason);
        } catch {
          // Swallow close errors during shutdown
        }
      }
      sockets.clear();
    }
    this.sessions.clear();
  }

  private safeSend(sessionId: string, ws: WebSocket, data: string): void {
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      } else {
        this.remove(sessionId, ws);
      }
    } catch {
      this.remove(sessionId, ws);
    }
  }
}
