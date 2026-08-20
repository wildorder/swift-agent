import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { customAlphabet } from 'nanoid';
import type { Db } from '../client.js';
import { playgroundSpendDays, playgroundSpendReservations } from '../schema/index.js';

const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 21);

/** The exhaustive terminal family the settlement rule quantifies over. */
export type PlaygroundSpendTerminalStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'abandoned';

export type PlaygroundSpendReservationRow = typeof playgroundSpendReservations.$inferSelect;

export type ReserveResult =
  | { accepted: true; reservation: PlaygroundSpendReservationRow; dayTotalMicroUsd: number }
  /** Typed refusal — the atomic ceiling gate said no; nothing was inserted. */
  | { accepted: false; reason: 'daily_ceiling'; dayTotalMicroUsd: number };

/** Sentinel used to roll the reserve transaction back on a ceiling refusal. */
class CeilingRefused extends Error {
  constructor(readonly dayTotalMicroUsd: number) {
    super('daily_ceiling');
  }
}

/**
 * WS-49 — the playground's atomic reserve-then-settle spend ledger (SC-09).
 *
 * - `reserve` is ONE transaction around the atomic conditional UPDATE on the
 *   day row: concurrent sessions racing the ceiling serialize on that row, so
 *   the sum of accepted reservations can never exceed the ceiling.
 * - `settle` is bookkeeping on the reservation row only, ALWAYS at the full
 *   reserved amount — there is deliberately no decrement API of any kind, and
 *   observed token usage is stored but never adjusts anything.
 * - `sweepAbandoned` settles never-terminal reservations as 'abandoned' after
 *   a timeout; the charge stands in full. Idempotent (status-guarded).
 */
export function createPlaygroundSpendRepo(db: Db) {
  return {
    /**
     * Atomically reserve `amountMicroUsd` against `day`'s ceiling. Refuses
     * (and inserts nothing) when the reservation would push the day total
     * past `ceilingMicroUsd`.
     */
    async reserve(
      day: string,
      amountMicroUsd: number,
      ceilingMicroUsd: number,
      sessionId: string,
    ): Promise<ReserveResult> {
      if (!Number.isInteger(amountMicroUsd) || amountMicroUsd <= 0) {
        throw new Error(`reserve amount must be a positive integer of micro-USD, got ${amountMicroUsd}`);
      }
      try {
        return await db.transaction(async (tx) => {
          // Upsert the day row so the conditional UPDATE always has a target.
          await tx
            .insert(playgroundSpendDays)
            .values({ day, reservedTotalMicroUsd: 0 })
            .onConflictDoNothing();

          // The atomic ceiling gate: 0 rows updated → refusal.
          const updated = await tx
            .update(playgroundSpendDays)
            .set({
              reservedTotalMicroUsd: sql`${playgroundSpendDays.reservedTotalMicroUsd} + ${amountMicroUsd}`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(playgroundSpendDays.day, day),
                sql`${playgroundSpendDays.reservedTotalMicroUsd} + ${amountMicroUsd} <= ${ceilingMicroUsd}`,
              ),
            )
            .returning();

          const dayRow = updated[0];
          if (!dayRow) {
            const [existing] = await tx
              .select({ total: playgroundSpendDays.reservedTotalMicroUsd })
              .from(playgroundSpendDays)
              .where(eq(playgroundSpendDays.day, day));
            // Throw to roll the transaction back — nothing is inserted.
            throw new CeilingRefused(existing?.total ?? 0);
          }

          const inserted = await tx
            .insert(playgroundSpendReservations)
            .values({
              reservationId: `psr_${nanoid()}`,
              day,
              sessionId,
              reservedMicroUsd: amountMicroUsd,
            })
            .returning();
          const reservation = inserted[0];
          if (!reservation) throw new Error('Failed to insert playground spend reservation');

          return {
            accepted: true as const,
            reservation,
            dayTotalMicroUsd: dayRow.reservedTotalMicroUsd,
          };
        });
      } catch (err) {
        if (err instanceof CeilingRefused) {
          return { accepted: false, reason: 'daily_ceiling', dayTotalMicroUsd: err.dayTotalMicroUsd };
        }
        throw err;
      }
    },

    /** Record the runId once known. No-op if a runId is already attached. */
    async attachRun(reservationId: string, runId: string): Promise<PlaygroundSpendReservationRow | null> {
      const [row] = await db
        .update(playgroundSpendReservations)
        .set({ runId })
        .where(
          and(
            eq(playgroundSpendReservations.reservationId, reservationId),
            isNull(playgroundSpendReservations.runId),
          ),
        )
        .returning();
      return row ?? null;
    },

    /**
     * Settle a reservation — ALWAYS at its full reserved amount. The day
     * total is untouched by design; observed usage is observability only.
     * Guarded on `status = 'reserved'` so a second settle is a no-op (null).
     */
    async settle(
      reservationId: string,
      terminalStatus: PlaygroundSpendTerminalStatus,
      observedUsage?: { inputTokens?: number; outputTokens?: number },
    ): Promise<PlaygroundSpendReservationRow | null> {
      const [row] = await db
        .update(playgroundSpendReservations)
        .set({
          status: 'settled',
          terminalStatus,
          settledAt: new Date(),
          observedInputTokens: observedUsage?.inputTokens ?? null,
          observedOutputTokens: observedUsage?.outputTokens ?? null,
        })
        .where(
          and(
            eq(playgroundSpendReservations.reservationId, reservationId),
            eq(playgroundSpendReservations.status, 'reserved'),
          ),
        )
        .returning();
      return row ?? null;
    },

    /**
     * Settle every reservation still 'reserved' after `olderThanMs` as
     * 'abandoned' (the charge stands in full). Idempotent: already-settled
     * rows are never touched. Returns the settled rows.
     */
    async sweepAbandoned(olderThanMs: number): Promise<PlaygroundSpendReservationRow[]> {
      const cutoff = new Date(Date.now() - olderThanMs);
      return db
        .update(playgroundSpendReservations)
        .set({ status: 'settled', terminalStatus: 'abandoned', settledAt: new Date() })
        .where(
          and(
            eq(playgroundSpendReservations.status, 'reserved'),
            lt(playgroundSpendReservations.createdAt, cutoff),
          ),
        )
        .returning();
    },

    /** The day's reserved total in micro-USD (0 when no row exists yet). */
    async dayTotal(day: string): Promise<number> {
      const [row] = await db
        .select({ total: playgroundSpendDays.reservedTotalMicroUsd })
        .from(playgroundSpendDays)
        .where(eq(playgroundSpendDays.day, day));
      return row?.total ?? 0;
    },
  };
}

export type PlaygroundSpendRepo = ReturnType<typeof createPlaygroundSpendRepo>;
