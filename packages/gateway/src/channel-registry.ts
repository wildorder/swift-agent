import { randomUUID } from 'node:crypto';
import type { ChatEvent } from '@swiftagent/shared';
import type { ConnectionManager } from './connection-manager.js';
import type { RedisPubSubStub } from './session-bridge.js';

// ── Fanout envelope ────────────────────────────────────────────────────

/**
 * Wire envelope for an event published to `session:${sessionId}`. It carries
 * the originating instance's id alongside the `ChatEvent` so a *subscribing*
 * instance can tell two cases apart:
 *
 *  - **Its own publish echoed back** (`origin === this.instanceId`) — the event
 *    was already delivered to local sockets by the authoritative local
 *    `broadcast`; the Redis path MUST drop it, or every socket receives it
 *    twice (the double-delivery bug WS-33 fixes).
 *  - **A peer instance's event** (`origin !== this.instanceId`) — the only case
 *    that reaches local sockets over Redis. This is the Phase 2 cross-instance
 *    (A publishes → B forwards to B's sockets) path; on the single-task MVP no
 *    peer exists, so this branch is dormant-but-wired.
 *
 * This envelope is the Redis-internal wire format only — the bytes clients
 * receive are still `serializeChatEvent(event)` (via `broadcast`), so no client
 * stream-event protocol changes.
 */
interface FanoutEnvelope {
  origin: string;
  event: ChatEvent;
}

interface ChannelRef {
  /** Number of local sockets that acquired this session's subscription. */
  count: number;
}

export interface ChannelRegistryDeps {
  redis: RedisPubSubStub;
  connectionManager: ConnectionManager;
  /** Override the per-process instance id (tests only). */
  instanceId?: string;
}

/**
 * Ref-counted, per-session Redis subscription manager and the fanout publish
 * point. Fixes three defects in the previous per-socket subscription model:
 *
 *  1. **Double-delivery** — the originating instance forwarded its own publish
 *     back to its own sockets on top of the local `broadcast`. The `forward`
 *     handler now drops self-originated events (see {@link FanoutEnvelope}).
 *  2. **Last-subscribe-wins / missed delivery** — `handlers` is keyed by
 *     channel, so N per-socket `subscribe`s overwrote one another and only the
 *     last socket got Redis-forwarded messages. There is now exactly ONE
 *     subscription per session per instance, forwarding to ALL local sockets.
 *  3. **Premature unsubscribe** — the first socket's `close` tore the channel
 *     down for still-open siblings. Teardown is ref-counted: `unsubscribe` runs
 *     only when the LAST socket for the session releases.
 *
 * Local broadcast (`ConnectionManager.broadcast` in `SessionBridge`) stays the
 * authoritative delivery path for locally-connected sockets; the Redis path is
 * reserved for the Phase 2 cross-instance case.
 */
export class ChannelRegistry {
  private readonly redis: RedisPubSubStub;
  private readonly connectionManager: ConnectionManager;
  /** Per-process id; distinguishes this instance's own publishes from peers'. */
  private readonly instanceId: string;
  /** Ref-counted subscriptions keyed by channel (`session:${sessionId}`). */
  private readonly refs = new Map<string, ChannelRef>();

  constructor(deps: ChannelRegistryDeps) {
    this.redis = deps.redis;
    this.connectionManager = deps.connectionManager;
    this.instanceId = deps.instanceId ?? randomUUID();
  }

  private channel(sessionId: string): string {
    return `session:${sessionId}`;
  }

  /**
   * Publish an event to the session channel, tagged with this instance's id so
   * subscribers can drop the echo of their own publish. Awaitable, but callers
   * on the hot path fire-and-forget (`void`) since local delivery already
   * happened via `broadcast`.
   */
  async publish(sessionId: string, event: ChatEvent): Promise<void> {
    const envelope: FanoutEnvelope = { origin: this.instanceId, event };
    await this.redis.publish(this.channel(sessionId), JSON.stringify(envelope));
  }

  /**
   * Acquire the session's subscription for one socket. Subscribes to Redis on
   * the FIRST socket for the session; later sockets only bump the refcount.
   */
  async acquire(sessionId: string): Promise<void> {
    const channel = this.channel(sessionId);
    const existing = this.refs.get(channel);
    if (existing) {
      existing.count += 1;
      return;
    }

    this.refs.set(channel, { count: 1 });
    await this.redis.subscribe(channel, (_channel, message) =>
      this.forward(sessionId, message),
    );
  }

  /**
   * Release the session's subscription for one socket. Unsubscribes from Redis
   * only when the LAST socket for the session releases (refcount → 0). A
   * release with no live ref is a safe no-op.
   */
  async release(sessionId: string): Promise<void> {
    const channel = this.channel(sessionId);
    const existing = this.refs.get(channel);
    if (!existing) return;

    existing.count -= 1;
    if (existing.count > 0) return;

    this.refs.delete(channel);
    await this.redis.unsubscribe(channel);
  }

  /** Live refcount for a session's channel (0 when no subscription). Test aid. */
  refCount(sessionId: string): number {
    return this.refs.get(this.channel(sessionId))?.count ?? 0;
  }

  /**
   * Redis message handler for a session subscription. Forwards a peer
   * instance's event to this instance's local sockets; drops this instance's
   * own publish (already delivered via `broadcast`) so single-instance delivery
   * is exactly-once. On the single-task MVP there are no peers, so in practice
   * this is a no-op — the cross-instance forward is the Phase 2 activation of
   * this path (see {@link FanoutEnvelope}).
   */
  private forward(sessionId: string, message: string): void {
    let envelope: FanoutEnvelope;
    try {
      envelope = JSON.parse(message) as FanoutEnvelope;
    } catch {
      return;
    }
    if (!envelope || envelope.origin === this.instanceId) return;
    this.connectionManager.broadcast(sessionId, envelope.event);
  }
}

export function createChannelRegistry(deps: ChannelRegistryDeps): ChannelRegistry {
  return new ChannelRegistry(deps);
}
