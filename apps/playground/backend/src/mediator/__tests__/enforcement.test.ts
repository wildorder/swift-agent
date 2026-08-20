import { describe, it, expect, vi } from 'vitest';
import { ChatEventSchema } from '@swiftagent/shared';
import { MediatorFrameSchema, RefusalFrameSchema } from '../protocol.js';
import { startHarness, chatEventScript } from './harness.js';
import type { Harness } from './harness.js';

/**
 * WS-49 enforcement tests (SC-09) — one test per limit, driven by a RAW
 * WebSocket/HTTP client that ignores the UI entirely. The runtime is a stub
 * upstream WS server emitting scripted ChatEvent sequences; the ledger is the
 * in-memory fake (the Postgres path is covered by the packages/db suite).
 */

async function withHarness(
  overrides: Parameters<typeof startHarness>[0],
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const h = await startHarness(overrides);
  try {
    await fn(h);
  } finally {
    await h.close();
  }
}

/** Every refusal must be the typed frame — never a ChatEvent, never malformed. */
function expectTypedRefusal(frame: Record<string, unknown>, reason: string): void {
  const parsed = RefusalFrameSchema.parse(frame);
  expect(parsed.reason).toBe(reason);
  expect(parsed.message.length).toBeGreaterThan(0);
  expect(ChatEventSchema.safeParse(frame).success).toBe(false);
  expect(MediatorFrameSchema.safeParse(frame).success).toBe(true);
}

// ── Spec test 5 — per-IP rate limit ─────────────────────────────────

describe('per-IP rate limit (rate_limit_ip)', () => {
  it('refuses a mint burst from one IP with the typed 429 body; a different IP is unaffected', async () => {
    await withHarness({ ipLimit: { max: 2, windowMs: 60_000 } }, async (h) => {
      const first = await h.mint('203.0.113.1');
      const second = await h.mint('203.0.113.1');
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);

      const refused = await h.mint('203.0.113.1');
      expect(refused.statusCode).toBe(429);
      expectTypedRefusal(refused.body, 'rate_limit_ip');
      expect(RefusalFrameSchema.parse(refused.body).retryAfterSeconds).toBeGreaterThan(0);

      // A different IP is unaffected.
      const otherIp = await h.mint('203.0.113.99');
      expect(otherIp.statusCode).toBe(200);
    });
  });
});

// ── Spec test 6 — per-session rate limit ────────────────────────────

describe('per-session rate limit (rate_limit_session)', () => {
  it('refuses over-rate sends with retryAfterSeconds, keeps the socket open, and resumes service under compliant pacing', async () => {
    await withHarness({ sessionLimit: { max: 2, windowMs: 400 } }, async (h) => {
      const mint = await h.mint();
      const client = await h.connect(mint.body['guestId'] as string);
      await client.waitForType('session_ready');

      client.send({ type: 'send', content: 'one' });
      client.send({ type: 'send', content: 'two' });
      client.send({ type: 'send', content: 'three' });

      const refusal = await client.waitForType('refusal');
      expectTypedRefusal(refusal, 'rate_limit_session');
      expect(RefusalFrameSchema.parse(refusal).retryAfterSeconds).toBeGreaterThanOrEqual(1);

      // The socket stays open…
      expect(client.isClosed).toBe(false);

      // …and compliant pacing resumes service: after the window drains, the
      // next send is forwarded upstream.
      await vi.waitFor(() => expect(h.upstream.received).toEqual(['one', 'two']));
      await new Promise((r) => setTimeout(r, 500));
      client.send({ type: 'send', content: 'four' });
      await vi.waitFor(() => expect(h.upstream.received).toEqual(['one', 'two', 'four']));
      expect(client.isClosed).toBe(false);

      await client.close();
    });
  });
});

// ── Spec test 7 — message cap ───────────────────────────────────────

describe('message cap (message_cap)', () => {
  it('refuses the (cap+1)-th message and never forwards it — the upstream saw exactly cap messages', async () => {
    await withHarness({ messagesPerSession: 2 }, async (h) => {
      const mint = await h.mint();
      const client = await h.connect(mint.body['guestId'] as string);
      await client.waitForType('session_ready');

      client.send({ type: 'send', content: 'first' });
      client.send({ type: 'send', content: 'second' });
      client.send({ type: 'send', content: 'third — must be refused' });

      const refusal = await client.waitForType('refusal');
      expectTypedRefusal(refusal, 'message_cap');
      expect(RefusalFrameSchema.parse(refusal).remaining?.messages).toBe(0);

      // The stub upstream saw exactly cap messages.
      await vi.waitFor(() => expect(h.upstream.received).toEqual(['first', 'second']));
      expect(client.isClosed).toBe(false);
      await client.close();
    });
  });

  it('refuses a single over-length message (the input-token bound) without forwarding it', async () => {
    await withHarness({ messageMaxChars: 10 }, async (h) => {
      const mint = await h.mint();
      const client = await h.connect(mint.body['guestId'] as string);
      await client.waitForType('session_ready');

      client.send({ type: 'send', content: 'x'.repeat(11) });
      const refusal = await client.waitForType('refusal');
      expectTypedRefusal(refusal, 'message_cap');
      expect(h.upstream.received).toEqual([]);
      await client.close();
    });
  });
});

// ── Spec test 8 — token cap ─────────────────────────────────────────

describe('token cap (token_cap)', () => {
  it('refuses on crossing the estimated output-token cap and cancels the run upstream', async () => {
    await withHarness({ tokensPerSession: 20 }, async (h) => {
      // Each scripted token frame is 100 chars → 25 estimated tokens → breach.
      h.upstream.onSend((send, index) => {
        for (const frame of chatEventScript(`run_${index}`, { tokenText: 'y'.repeat(100) })) {
          send(frame);
        }
      });

      const mint = await h.mint();
      const client = await h.connect(mint.body['guestId'] as string);
      await client.waitForType('session_ready');

      client.send({ type: 'send', content: 'stream a lot' });

      const refusal = await client.waitForType('refusal');
      expectTypedRefusal(refusal, 'token_cap');
      expect(RefusalFrameSchema.parse(refusal).remaining?.tokens).toBe(0);

      // The mediator called cancelRun upstream (spy).
      await vi.waitFor(() => expect(h.control.cancelled).toEqual(['run_0']));
      expect(client.isClosed).toBe(false);
      await client.close();
    });
  });
});

// ── Spec test 9 — daily ceiling ─────────────────────────────────────

describe('daily ceiling (daily_ceiling)', () => {
  it('refuses BEFORE any upstream forward when the primed ledger is at the ceiling, inserting nothing', async () => {
    await withHarness(
      { reservationMicroUsd: 1_000, dailyCeilingMicroUsd: 10_000 },
      async (h) => {
        // Prime the fake ledger to the brim for today.
        const today = new Date().toISOString().slice(0, 10);
        h.ledger.dayTotals.set(today, 9_500);

        const mint = await h.mint();
        const client = await h.connect(mint.body['guestId'] as string);
        await client.waitForType('session_ready');

        client.send({ type: 'send', content: 'one over the ceiling' });
        const refusal = await client.waitForType('refusal');
        expectTypedRefusal(refusal, 'daily_ceiling');

        // Nothing was forwarded upstream and no reservation row exists.
        expect(h.upstream.received).toEqual([]);
        expect(h.ledger.reservations).toEqual([]);
        expect(client.isClosed).toBe(false);
        await client.close();
      },
    );
  });
});

// ── Spec test 10 — TTL ──────────────────────────────────────────────

describe('guest TTL (session_expired)', () => {
  it('refuses a post-expiry send with the typed frame delivered BEFORE the close', async () => {
    await withHarness({ sessionTtlMs: 150 }, async (h) => {
      const mint = await h.mint();
      const client = await h.connect(mint.body['guestId'] as string);
      await client.waitForType('session_ready');

      await new Promise((r) => setTimeout(r, 250));
      client.send({ type: 'send', content: 'too late' });

      const refusal = await client.waitForType('refusal');
      expectTypedRefusal(refusal, 'session_expired');
      // The frame arrived before the close (we parsed it off the open socket);
      // the socket then closes cleanly.
      const { code } = await client.closed;
      expect(code).toBe(1000);
      expect(h.upstream.received).toEqual([]);
    });
  });

  it('an unknown guest id (e.g. after a mediator restart) gets the typed frame, then a clean close', async () => {
    await withHarness(undefined, async (h) => {
      const client = await h.connect('pg_no_such_guest');
      const refusal = await client.waitForType('refusal');
      expectTypedRefusal(refusal, 'session_expired');
      const { code } = await client.closed;
      expect(code).toBe(1000);
    });
  });
});

// ── Spec test 11 — refusals are typed frames, not failures ──────────

describe('bad frames and refusal typing (bad_frame)', () => {
  it('answers unparseable and unknown inbound frames with bad_frame and never drops the socket', async () => {
    await withHarness(undefined, async (h) => {
      const mint = await h.mint();
      const client = await h.connect(mint.body['guestId'] as string);
      await client.waitForType('session_ready');

      client.sendRaw('this is not JSON {{{');
      const first = await client.waitForType('refusal');
      expectTypedRefusal(first, 'bad_frame');

      client.send({ type: 'weird_frame', payload: 1 });
      await vi.waitFor(() => {
        expect(client.frames.filter((f) => f['type'] === 'refusal')).toHaveLength(2);
      });
      for (const refusal of client.frames.filter((f) => f['type'] === 'refusal')) {
        expectTypedRefusal(refusal, 'bad_frame');
      }

      // No unhandled error, no 500, no socket drop — service continues.
      expect(client.isClosed).toBe(false);
      client.send({ type: 'send', content: 'still works' });
      await vi.waitFor(() => expect(h.upstream.received).toEqual(['still works']));
      await client.close();
    });
  });
});
