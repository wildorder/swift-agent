import { pgTable, text, timestamp, date, bigint, integer, index } from 'drizzle-orm/pg-core';

/**
 * WS-49 — the playground's global daily spend ledger (SC-09).
 *
 * One row per UTC day: the atomic ceiling gate. `reservedTotalMicroUsd` only
 * ever increments — settlement is always at the FULL reserved amount, so the
 * day counter is never decremented and settlement never touches it. Amounts
 * are integer micro-USD (no floats in money paths).
 */
export const playgroundSpendDays = pgTable('playground_spend_days', {
  /** UTC date ('YYYY-MM-DD'). */
  day: date('day').primaryKey(),
  reservedTotalMicroUsd: bigint('reserved_total_micro_usd', { mode: 'number' })
    .notNull()
    .default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per reservation: the audit trail + settlement/sweep state.
 *
 * `observedInputTokens`/`observedOutputTokens` are observability ONLY — the
 * runtime's `RunRecord.tokenUsage` structurally under-counts multi-round runs
 * (loop.ts persists only the final round's usage) and NEVER reduces a charge.
 */
export const playgroundSpendReservations = pgTable(
  'playground_spend_reservations',
  {
    /** 'psr_' + nanoid. */
    reservationId: text('reservation_id').primaryKey(),
    day: date('day').notNull(),
    /** ses_… (guest session). */
    sessionId: text('session_id').notNull(),
    /** run_… once known; null if run creation failed / never observed. */
    runId: text('run_id'),
    reservedMicroUsd: bigint('reserved_micro_usd', { mode: 'number' }).notNull(),
    status: text('status', { enum: ['reserved', 'settled'] })
      .notNull()
      .default('reserved'),
    /** completed | failed | cancelled | timed_out | abandoned. */
    terminalStatus: text('terminal_status'),
    observedInputTokens: integer('observed_input_tokens'),
    observedOutputTokens: integer('observed_output_tokens'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (table) => [
    index('playground_spend_reservations_day_idx').on(table.day),
    index('playground_spend_reservations_status_idx').on(table.status),
  ],
);
