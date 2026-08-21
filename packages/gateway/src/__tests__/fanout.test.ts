import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { ChatEvent } from '@swiftagent/shared';
import { ConnectionManager } from '../connection-manager.js';
import { ChannelRegistry } from '../channel-registry.js';
import { SessionBridge } from '../session-bridge.js';
import type { RedisPubSubStub, RedisMessageHandler } from '../session-bridge.js';
import type { RuntimeDelegate } from '../types.js';

// ── Fakes ──────────────────────────────────────────────────────────────

/** Minimal open WebSocket that records everything sent to it. */
function createMockWs(): WebSocket {
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: (data: string) => {
      sent.push(data);
    },
    close: vi.fn(),
    on: vi.fn().mockReturnThis(),
    __sent: sent,
  };
  return ws as unknown as WebSocket;
}

function getSent(ws: WebSocket): string[] {
  return (ws as unknown as { __sent: string[] }).__sent;
}

/**
 * In-memory Redis pub/sub double: `publish` synchronously invokes the handler
 * registered for the channel — exactly the behaviour of the real `sub.on('message')`
 * loop on the SAME instance (self-echo), which is what the fanout fix must tame.
 */
function createInMemoryRedis() {
  const handlers = new Map<string, RedisMessageHandler>();
  const subscribeSpy = vi.fn<(channel: string) => void>();
  const unsubscribeSpy = vi.fn<(channel: string) => void>();

  const stub: RedisPubSubStub = {
    async publish(channel, payload) {
      handlers.get(channel)?.(channel, payload);
    },
    async subscribe(channel, handler) {
      subscribeSpy(channel);
      handlers.set(channel, handler);
    },
    async unsubscribe(channel) {
      unsubscribeSpy(channel);
      handlers.delete(channel);
    },
    async ping() {
      return true;
    },
    async disconnect() {
      handlers.clear();
    },
  };

  return { stub, handlers, subscribeSpy, unsubscribeSpy };
}

const SESSION_ID = 'ses_fanout';

function makeTokenEvent(text: string): ChatEvent {
  return {
    type: 'token',
    runId: 'run_1',
    sessionId: SESSION_ID,
    messageId: 'msg_1',
    text,
  };
}

/** Runtime that forwards a preset event sequence through `onEvent`. */
function createMockRuntime(events: ChatEvent[]): RuntimeDelegate {
  return {
    start: vi.fn(async (_input, opts?: { onEvent?: (e: ChatEvent) => void }) => {
      for (const event of events) opts?.onEvent?.(event);
      return { runId: 'run_1' };
    }) as unknown as RuntimeDelegate['start'],
    requestCancel: vi.fn(async () => ({ requested: true })) as RuntimeDelegate['requestCancel'],
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('Redis fanout correctness (single instance)', () => {
  let cm: ConnectionManager;
  let redis: ReturnType<typeof createInMemoryRedis>;
  let channels: ChannelRegistry;

  beforeEach(() => {
    cm = new ConnectionManager();
    redis = createInMemoryRedis();
    channels = new ChannelRegistry({ redis: redis.stub, connectionManager: cm });
  });

  it('delivers each event to each local socket exactly once (SC-06)', async () => {
    const a = createMockWs();
    const b = createMockWs();
    cm.add(SESSION_ID, a);
    cm.add(SESSION_ID, b);
    await channels.acquire(SESSION_ID); // subscription live for the session

    const bridge = new SessionBridge({
      connectionManager: cm,
      runtime: createMockRuntime([makeTokenEvent('hello')]),
      redis: redis.stub,
      channels,
    });

    await bridge.handleSendMessage(SESSION_ID, 'hi', a);

    // Local broadcast delivers once; the self-echo over Redis is dropped.
    expect(getSent(a)).toHaveLength(1);
    expect(getSent(b)).toHaveLength(1);
    expect(JSON.parse(getSent(a)[0]).text).toBe('hello');
  });

  it('does not double-deliver the instance\'s own publish through Redis (SC-06)', async () => {
    const a = createMockWs();
    cm.add(SESSION_ID, a);
    await channels.acquire(SESSION_ID);

    // Publish the instance's own event directly through the registry (as
    // handleSendMessage does). The in-memory double invokes the subscription
    // handler synchronously — the self-origin filter must suppress it.
    await channels.publish(SESSION_ID, makeTokenEvent('x'));

    expect(getSent(a)).toHaveLength(0);
  });

  it('forwards a PEER instance event to local sockets (Phase 2 path is wired)', async () => {
    const a = createMockWs();
    cm.add(SESSION_ID, a);
    await channels.acquire(SESSION_ID);

    // A message tagged with a DIFFERENT origin simulates a peer instance's
    // publish; it must be forwarded to this instance's local sockets.
    const peerEnvelope = JSON.stringify({ origin: 'other-instance', event: makeTokenEvent('peer') });
    redis.handlers.get(`session:${SESSION_ID}`)?.(`session:${SESSION_ID}`, peerEnvelope);

    expect(getSent(a)).toHaveLength(1);
    expect(JSON.parse(getSent(a)[0]).text).toBe('peer');
  });

  it('subscribes once per session regardless of socket count (SC-06)', async () => {
    await channels.acquire(SESSION_ID); // socket a
    await channels.acquire(SESSION_ID); // socket b

    expect(redis.subscribeSpy).toHaveBeenCalledTimes(1);
    expect(redis.subscribeSpy).toHaveBeenCalledWith(`session:${SESSION_ID}`);
    expect(channels.refCount(SESSION_ID)).toBe(2);
  });

  it('unsubscribes only when the LAST socket releases — no premature teardown (SC-06)', async () => {
    await channels.acquire(SESSION_ID); // a
    await channels.acquire(SESSION_ID); // b

    await channels.release(SESSION_ID); // a closes — b still needs the channel
    expect(redis.unsubscribeSpy).not.toHaveBeenCalled();
    expect(channels.refCount(SESSION_ID)).toBe(1);

    await channels.release(SESSION_ID); // b closes — last socket
    expect(redis.unsubscribeSpy).toHaveBeenCalledTimes(1);
    expect(redis.unsubscribeSpy).toHaveBeenCalledWith(`session:${SESSION_ID}`);
    // Fully released: no lingering handler entry, no ref.
    expect(redis.handlers.has(`session:${SESSION_ID}`)).toBe(false);
    expect(channels.refCount(SESSION_ID)).toBe(0);
  });

  it('disconnect releases the correct channel and leaves others intact (SC-06)', async () => {
    await channels.acquire('ses_s1');
    await channels.acquire('ses_s2');

    await channels.release('ses_s1');

    expect(redis.unsubscribeSpy).toHaveBeenCalledTimes(1);
    expect(redis.unsubscribeSpy).toHaveBeenCalledWith('session:ses_s1');
    expect(redis.handlers.has('session:ses_s1')).toBe(false);
    expect(redis.handlers.has('session:ses_s2')).toBe(true);
    expect(channels.refCount('ses_s2')).toBe(1);
  });
});
