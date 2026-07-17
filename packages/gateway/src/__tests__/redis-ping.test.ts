import { describe, it, expect, vi, afterEach } from 'vitest';

// Controllable `ping` behaviour for the mocked ioredis client. Hoisted so the
// `vi.mock` factory (also hoisted) can close over it.
const state = vi.hoisted(() => ({
  pingImpl: (): Promise<string> => Promise.resolve('PONG'),
}));

vi.mock('ioredis', () => {
  class FakeRedis {
    on(): this {
      return this;
    }
    async publish(): Promise<number> {
      return 0;
    }
    async subscribe(): Promise<void> {}
    async unsubscribe(): Promise<void> {}
    async quit(): Promise<void> {}
    ping(): Promise<string> {
      return state.pingImpl();
    }
  }
  return { Redis: FakeRedis, default: FakeRedis };
});

// `vi.mock` is hoisted above this import, and `createRedisPubSub` resolves
// ioredis via a dynamic `import('ioredis')` at call time — both see FakeRedis.
import { createRedisPubSub } from '../session-bridge.js';

describe('RedisPubSubStub.ping', () => {
  afterEach(() => {
    vi.useRealTimers();
    state.pingImpl = () => Promise.resolve('PONG');
  });

  it('resolves true when the client answers PONG', async () => {
    state.pingImpl = () => Promise.resolve('PONG');
    const ps = await createRedisPubSub('redis://fake');
    expect(await ps.ping()).toBe(true);
  });

  it('resolves false when PING rejects (caught, never throws)', async () => {
    state.pingImpl = () => Promise.reject(new Error('ECONNREFUSED'));
    const ps = await createRedisPubSub('redis://fake');
    await expect(ps.ping()).resolves.toBe(false);
  });

  it('resolves false on a non-PONG reply', async () => {
    state.pingImpl = () => Promise.resolve('WAT');
    const ps = await createRedisPubSub('redis://fake');
    expect(await ps.ping()).toBe(false);
  });

  it('resolves false when PING hangs, bounded by the ~1s timeout', async () => {
    vi.useFakeTimers();
    state.pingImpl = () => new Promise<string>(() => {}); // never resolves
    const ps = await createRedisPubSub('redis://fake');

    const pending = ps.ping();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toBe(false);
  });
});
