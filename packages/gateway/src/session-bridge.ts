import type { WebSocket } from 'ws';
import type { ChatEvent } from '@swiftagent/shared';
import { isSwiftAgentError, SwiftAgentErrorCode } from '@swiftagent/shared';
import type { ConnectionManager } from './connection-manager.js';
import { ChannelRegistry } from './channel-registry.js';
import type { RuntimeDelegate } from './types.js';
import { DEFAULT_MAX_REPLAY_BUFFER_SIZE } from './types.js';
import { toErrorEvent } from './events.js';

// ── Redis pub/sub stub ─────────────────────────────────────────────────

export type RedisMessageHandler = (channel: string, message: string) => void;

/**
 * Redis pub/sub interface for horizontal scaling.
 * When disabled (MVP default), all methods are no-ops.
 * When enabled, uses a real ioredis client.
 */
export interface RedisPubSubStub {
  publish(channel: string, payload: string): Promise<void>;
  subscribe(channel: string, handler: RedisMessageHandler): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  /**
   * Best-effort Redis liveness for the health check. Resolves `true` iff Redis
   * answers a `PING` with `PONG`; resolves `false` on any error or timeout —
   * it never throws, so a hung or down Redis cannot hang `/health`. The no-op
   * returns `true` (it is only ever consulted when Redis is disabled).
   */
  ping(): Promise<boolean>;
  disconnect(): Promise<void>;
}

/**
 * No-op implementation of Redis pub/sub.
 * Call sites exist so horizontal scaling is a config flip.
 */
export function createNoopRedisPubSub(): RedisPubSubStub {
  return {
    async publish() {},
    async subscribe() {},
    async unsubscribe() {},
    async ping() {
      return true;
    },
    async disconnect() {},
  };
}

/**
 * Create a real ioredis-backed pub/sub stub.
 * Lazily imported so ioredis is not required when disabled.
 */
export async function createRedisPubSub(redisUrl: string): Promise<RedisPubSubStub> {
  const { Redis } = await import('ioredis');
  const pub = new Redis(redisUrl);
  const sub = new Redis(redisUrl);
  const handlers = new Map<string, RedisMessageHandler>();

  sub.on('message', (channel: string, message: string) => {
    const handler = handlers.get(channel);
    if (handler) handler(channel, message);
  });

  return {
    async publish(channel, payload) {
      await pub.publish(channel, payload);
    },
    async subscribe(channel, handler) {
      handlers.set(channel, handler);
      await sub.subscribe(channel);
    },
    async unsubscribe(channel) {
      handlers.delete(channel);
      await sub.unsubscribe(channel);
    },
    async ping() {
      // Reuse the existing `pub` connection — do NOT open a third socket just
      // for health (it can report healthy while pub/sub are down). Race the
      // real PING against a ~1s timeout so a hung Redis cannot hang `/health`,
      // and swallow every error into `false`.
      try {
        const pong = await Promise.race([
          pub.ping(),
          new Promise<string>((resolve) => setTimeout(() => resolve('TIMEOUT'), 1000)),
        ]);
        return pong === 'PONG';
      } catch {
        return false;
      }
    },
    async disconnect() {
      handlers.clear();
      await sub.quit();
      await pub.quit();
    },
  };
}

// ── Replay buffer ──────────────────────────────────────────────────────

interface ReplayBuffer {
  runId: string;
  events: ChatEvent[];
}

// ── Session bridge ─────────────────────────────────────────────────────

export interface SessionBridgeDeps {
  connectionManager: ConnectionManager;
  runtime: RuntimeDelegate;
  redis?: RedisPubSubStub;
  /**
   * Ref-counted per-session fanout channel registry. When omitted, one is
   * created over `redis` — so a bare `{ connectionManager, runtime }` bridge
   * (unit tests) publishes through a no-op registry.
   */
  channels?: ChannelRegistry;
  maxReplayBufferSize?: number;
}

export class SessionBridge {
  private readonly connectionManager: ConnectionManager;
  private readonly runtime: RuntimeDelegate;
  private readonly redis: RedisPubSubStub;
  private readonly channels: ChannelRegistry;
  private readonly maxReplayBufferSize: number;

  /** Active run replay buffers keyed by sessionId. */
  private readonly replayBuffers = new Map<string, ReplayBuffer>();

  constructor(deps: SessionBridgeDeps) {
    this.connectionManager = deps.connectionManager;
    this.runtime = deps.runtime;
    this.redis = deps.redis ?? createNoopRedisPubSub();
    this.channels =
      deps.channels ??
      new ChannelRegistry({ redis: this.redis, connectionManager: this.connectionManager });
    this.maxReplayBufferSize = deps.maxReplayBufferSize ?? DEFAULT_MAX_REPLAY_BUFFER_SIZE;
  }

  /**
   * Handle an inbound send_message from a client.
   * Starts an agent run and broadcasts events to all session connections.
   * If a run is already in progress, sends an error to the sending socket only.
   */
  async handleSendMessage(
    sessionId: string,
    content: string,
    senderWs: WebSocket,
  ): Promise<void> {
    // Whether any event was forwarded before an error surfaced. Distinguishes a
    // setup failure (sender-only RUNTIME_ERROR) from a mid-run failure
    // (broadcast RUN_FAILED to all connections).
    let emitted = false;

    try {
      await this.runtime.start(
        { sessionId, content },
        {
          onEvent: (event) => {
            emitted = true;

            // Track runId for the reconnection replay buffer.
            if ('runId' in event && event.runId) {
              let buffer = this.replayBuffers.get(sessionId);
              if (!buffer || buffer.runId !== event.runId) {
                buffer = { runId: event.runId, events: [] };
                this.replayBuffers.set(sessionId, buffer);
              }
              if (buffer.events.length < this.maxReplayBufferSize) {
                buffer.events.push(event);
              }
            }

            // Broadcast to all connections for this session. This is the
            // AUTHORITATIVE delivery path for locally-connected sockets: each
            // local socket receives the event exactly once, synchronously,
            // in-process. The Redis path below never re-delivers to these
            // sockets (see ChannelRegistry.forward).
            this.connectionManager.broadcast(sessionId, event);

            // Also publish to Redis for horizontal scaling (fire-and-forget:
            // onEvent is synchronous; the no-op default never rejects). Tagged
            // with this instance's id so a subscribing instance drops the echo
            // of its own publish — only a *peer* instance forwards it to its
            // sockets (Phase 2). On a single instance this has no local consumer.
            void this.channels.publish(sessionId, event);
          },
        },
      );

      // Run drained to a terminal state — clear replay buffer.
      this.replayBuffers.delete(sessionId);
    } catch (err) {
      this.replayBuffers.delete(sessionId);

      // RUN_IN_PROGRESS: send error to sender only, not all session connections.
      if (isSwiftAgentError(err) && err.code === SwiftAgentErrorCode.CONFLICT) {
        const errorEvent = toErrorEvent('RUN_IN_PROGRESS', err.message);
        this.connectionManager.sendError(sessionId, senderWs, errorEvent);
        return;
      }

      const message = err instanceof Error ? err.message : 'Agent run failed';

      if (!emitted) {
        // Setup failure before any event streamed — sender only.
        const errorEvent = toErrorEvent('RUNTIME_ERROR', message);
        this.connectionManager.sendError(sessionId, senderWs, errorEvent);
        return;
      }

      // Mid-run failure — broadcast to all session connections.
      const errorEvent = toErrorEvent('RUN_FAILED', message);
      for (const ws of this.connectionManager.getConnections(sessionId)) {
        this.connectionManager.sendError(sessionId, ws, errorEvent);
      }
    }
  }

  /**
   * Handle an explicit inbound `cancel` from a client (WS-24). Resolves the
   * session's active run (tracked in the replay buffer) and forwards an
   * idempotent cancellation to the execution service. A no-op when the session
   * has no active run. Cancellation is process-owned: the resulting terminal
   * `run_failed` (code `CANCELLED`) event is broadcast through the normal
   * `handleSendMessage` stream, not from here.
   */
  async handleCancel(sessionId: string): Promise<void> {
    const runId = this.replayBuffers.get(sessionId)?.runId;
    if (!runId) return;
    await this.runtime.requestCancel(runId);
  }

  /**
   * Replay buffered events for a session on reconnection.
   * Returns the number of events replayed, or 0 if no active run.
   */
  replayEvents(sessionId: string, ws: WebSocket): number {
    const buffer = this.replayBuffers.get(sessionId);
    if (!buffer || buffer.events.length === 0) return 0;

    for (const event of buffer.events) {
      const data = JSON.stringify(event);
      this.connectionManager.sendTo(sessionId, ws, data);
    }

    return buffer.events.length;
  }

  /** Clean up replay buffer for a session. */
  clearReplayBuffer(sessionId: string): void {
    this.replayBuffers.delete(sessionId);
  }

  /** Whether a replay buffer exists for a session (active run). */
  hasActiveRun(sessionId: string): boolean {
    return this.replayBuffers.has(sessionId);
  }

  /** Disconnect Redis (for graceful shutdown). */
  async shutdown(): Promise<void> {
    await this.redis.disconnect();
    this.replayBuffers.clear();
  }
}

export function createSessionBridge(deps: SessionBridgeDeps): SessionBridge {
  return new SessionBridge(deps);
}
