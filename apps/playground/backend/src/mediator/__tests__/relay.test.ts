import { describe, it, expect, vi } from 'vitest';
import { ChatEventSchema } from '@swiftagent/shared';
import {
  startHarness,
  chatEventScript,
  FAKE_CLIENT_TOKEN_PREFIX,
  FAKE_WORKSPACE_KEY,
} from './harness.js';
import type { Harness } from './harness.js';

/**
 * WS-49 relay tests (SC-09): verbatim byte-identical ChatEvent relay, the
 * credential-free browser guarantee asserted on serialized frames, and the
 * reserve-before-forward / settle-at-full / sweep-abandoned lifecycle.
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

// ── Spec test 12 — verbatim relay ───────────────────────────────────

describe('verbatim relay', () => {
  it('delivers the scripted ChatEvent sequence byte-identical and in order, interleaved with mediator frames', async () => {
    await withHarness(undefined, async (h) => {
      h.upstream.onSend((send, index) => {
        for (const frame of chatEventScript(`run_${index}`)) send(frame);
      });

      const mint = await h.mint();
      const client = await h.connect(mint.body['guestId'] as string);
      await client.waitForType('session_ready');

      client.send({ type: 'send', content: 'go' });
      await client.waitForType('message_completed');

      // The relayed frames are the EXACT bytes the upstream sent, in order.
      const relayed = client.raw.filter((raw) => {
        const type = (JSON.parse(raw) as { type?: string }).type;
        return type !== 'session_ready' && type !== 'refusal';
      });
      expect(relayed).toEqual(h.upstream.sentRaw);
      expect(relayed.map((raw) => (JSON.parse(raw) as { type: string }).type)).toEqual([
        'message_started',
        'token',
        'tool_call_started',
        'tool_call_completed',
        'message_completed',
      ]);

      // Every relayed frame is a valid ChatEvent; mediator frames sit beside
      // them without polluting the union.
      for (const raw of relayed) {
        expect(ChatEventSchema.safeParse(JSON.parse(raw)).success).toBe(true);
      }
      expect(client.frames[0]?.['type']).toBe('session_ready');

      await client.close();
    });
  });
});

// ── Spec test 13 — credential-free browser ──────────────────────────

describe('credential-free browser', () => {
  it('no mint body or mediator frame ever contains the workspace key, clientToken, or upstream websocketUrl', async () => {
    await withHarness(undefined, async (h) => {
      h.upstream.onSend((send, index) => {
        for (const frame of chatEventScript(`run_${index}`)) send(frame);
      });

      const mint = await h.mint();
      const mintSerialized = JSON.stringify(mint.body);

      const client = await h.connect(mint.body['guestId'] as string);
      await client.waitForType('session_ready');
      client.send({ type: 'send', content: 'go' });
      await client.waitForType('message_completed');
      await client.close();

      const everySerializedFrame = [mintSerialized, ...client.raw];
      for (const serialized of everySerializedFrame) {
        expect(serialized).not.toContain(FAKE_WORKSPACE_KEY);
        expect(serialized).not.toContain(FAKE_CLIENT_TOKEN_PREFIX);
        expect(serialized).not.toContain(h.upstream.url);
        expect(serialized).not.toContain('websocketUrl');
        expect(serialized).not.toContain('clientToken');
        expect(serialized).not.toContain('apiKey');
        expect(serialized).not.toContain('/v1/stream');
      }
    });
  });
});

// ── Spec test 14 — reservation lifecycle ────────────────────────────

describe('reservation lifecycle', () => {
  it('reserves BEFORE the upstream forward and attaches the observed runId', async () => {
    await withHarness(undefined, async (h) => {
      let receivedAtReserveCount = -1;
      h.upstream.onSend((send, index) => {
        // Snapshot how many reservations existed when the forward arrived.
        receivedAtReserveCount = h.ledger.reservations.length;
        for (const frame of chatEventScript(`run_${index}`)) send(frame);
      });

      const mint = await h.mint();
      const client = await h.connect(mint.body['guestId'] as string);
      await client.waitForType('session_ready');
      client.send({ type: 'send', content: 'go' });
      await client.waitForType('message_completed');

      // The reservation existed before the upstream ever saw the message…
      expect(receivedAtReserveCount).toBe(1);
      // …and the observed runId was attached to it.
      await vi.waitFor(() => {
        expect(h.ledger.reservations[0]?.runId).toBe('run_0');
      });
      await client.close();
    });
  });

  it.each(['completed', 'failed', 'cancelled', 'timed_out'] as const)(
    'settles at the FULL reserved amount when getRun confirms terminal status %s',
    async (terminalStatus) => {
      await withHarness({ reservationMicroUsd: 2_500 }, async (h) => {
        h.upstream.onSend((send, index) => {
          const runId = `run_${index}`;
          h.control.runStatuses.set(runId, terminalStatus);
          for (const frame of chatEventScript(runId)) send(frame);
        });

        const mint = await h.mint();
        const client = await h.connect(mint.body['guestId'] as string);
        await client.waitForType('session_ready');

        const today = new Date().toISOString().slice(0, 10);
        client.send({ type: 'send', content: 'go' });
        await client.waitForType('message_completed');

        await vi.waitFor(() => {
          const row = h.ledger.reservations[0];
          expect(row?.status).toBe('settled');
          expect(row?.terminalStatus).toBe(terminalStatus);
        });

        // Full-reservation settlement: the day total is untouched by settle.
        expect(h.ledger.reservations[0]?.reservedMicroUsd).toBe(2_500);
        expect(await h.ledger.dayTotal(today)).toBe(2_500);
        await client.close();
      });
    },
  );

  it('leaves a never-terminal run reserved until the sweep settles it as abandoned (charge stands in full)', async () => {
    await withHarness(
      { sweepIntervalMs: 200, abandonedAfterMs: 100 },
      async (h) => {
        // The upstream starts a run but NEVER emits a terminal event.
        h.upstream.onSend((send, index) => {
          send(
            JSON.stringify({
              type: 'message_started',
              messageId: `msg_${index}`,
              runId: `run_${index}`,
              sessionId: 'ses_guest_1',
            }),
          );
        });

        const mint = await h.mint();
        const client = await h.connect(mint.body['guestId'] as string);
        await client.waitForType('session_ready');

        const today = new Date().toISOString().slice(0, 10);
        client.send({ type: 'send', content: 'go' });
        await client.waitForType('message_started');

        expect(h.ledger.reservations[0]?.status).toBe('reserved');

        // The interval sweep settles it as abandoned — at the full amount.
        await vi.waitFor(
          () => {
            const row = h.ledger.reservations[0];
            expect(row?.status).toBe('settled');
            expect(row?.terminalStatus).toBe('abandoned');
          },
          { timeout: 3_000 },
        );
        expect(await h.ledger.dayTotal(today)).toBe(h.config.reservationMicroUsd);
        await client.close();
      },
    );
  });
});
