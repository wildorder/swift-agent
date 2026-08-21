import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq } from 'drizzle-orm';
import { createDbClient, type DbClient } from '../client.js';
import { createPlaygroundSpendRepo, type PlaygroundSpendRepo } from '../repositories/playground-spend-repo.js';
import { playgroundSpendReservations } from '../schema/index.js';

/**
 * WS-49 ledger integration tests (SC-09) — Testcontainers Postgres, applying
 * the SAME committed forward-only migration chain (`packages/db/drizzle`) the
 * deploy release step runs. Spins its own throwaway container (the same
 * pattern as `test/support/pg-container.ts`), so it never touches the shared
 * integration DB.
 *
 * Runs via `pnpm test:integration` (needs Docker); excluded from the
 * package's unit `vitest run` like every other Testcontainers suite.
 */

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

const CONTAINER_TIMEOUT_MS = 120_000;

let container: StartedPostgreSqlContainer;
let client: DbClient;
let repo: PlaygroundSpendRepo;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('playground_spend_test')
    .withUsername('test')
    .withPassword('test')
    .start();
  client = createDbClient(container.getConnectionUri());
  await migrate(client.db, { migrationsFolder });
  repo = createPlaygroundSpendRepo(client.db);
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, CONTAINER_TIMEOUT_MS);

/** Distinct day per test so suites don't interfere with each other's totals. */
let dayCounter = 0;
function freshDay(): string {
  dayCounter += 1;
  const d = String(dayCounter).padStart(2, '0');
  return `2031-01-${d}`;
}

describe('playground spend ledger — atomic ceiling (spec test 1)', () => {
  it('admits only combinations whose sum <= ceiling under Promise.all concurrency; a refused reserve inserts nothing', async () => {
    const day = freshDay();
    const ceiling = 5_000; // micro-USD
    const amount = 1_000; // 5 fit exactly; 12 race

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => repo.reserve(day, amount, ceiling, `ses_race_${i}`)),
    );

    const accepted = results.filter((r) => r.accepted);
    const refused = results.filter((r) => !r.accepted);
    expect(accepted).toHaveLength(5);
    expect(refused).toHaveLength(7);
    for (const r of refused) {
      expect(r).toMatchObject({ accepted: false, reason: 'daily_ceiling' });
    }

    // The day total equals the sum of admitted reservations exactly.
    expect(await repo.dayTotal(day)).toBe(5 * amount);

    // A refused reserve inserted nothing: exactly 5 reservation rows exist.
    const rows = await client.db
      .select()
      .from(playgroundSpendReservations)
      .where(eq(playgroundSpendReservations.day, day));
    expect(rows).toHaveLength(5);
    expect(rows.reduce((sum, r) => sum + r.reservedMicroUsd, 0)).toBe(5 * amount);
  });

  it('refuses a single reservation larger than the remaining headroom, then admits one that fits', async () => {
    const day = freshDay();
    const first = await repo.reserve(day, 900, 1_000, 'ses_a');
    expect(first.accepted).toBe(true);

    const tooBig = await repo.reserve(day, 200, 1_000, 'ses_b');
    expect(tooBig).toMatchObject({ accepted: false, reason: 'daily_ceiling', dayTotalMicroUsd: 900 });

    const fits = await repo.reserve(day, 100, 1_000, 'ses_c');
    expect(fits.accepted).toBe(true);
    expect(await repo.dayTotal(day)).toBe(1_000);
  });
});

describe('playground spend ledger — full-reservation settlement (spec test 2)', () => {
  const terminalStatuses = ['completed', 'failed', 'cancelled', 'timed_out'] as const;

  it.each(terminalStatuses)(
    'settle(%s) marks the row settled at FULL reserved amount without changing the day total',
    async (terminalStatus) => {
      const day = freshDay();
      const reserved = await repo.reserve(day, 700, 10_000, 'ses_settle');
      if (!reserved.accepted) throw new Error('reserve unexpectedly refused');
      const totalAfterReserve = await repo.dayTotal(day);

      const settled = await repo.settle(reserved.reservation.reservationId, terminalStatus, {
        inputTokens: 12,
        outputTokens: 34,
      });
      expect(settled).not.toBeNull();
      expect(settled).toMatchObject({
        status: 'settled',
        terminalStatus,
        reservedMicroUsd: 700, // never released below the reserved amount
        observedInputTokens: 12,
        observedOutputTokens: 34,
      });
      expect(settled?.settledAt).toBeInstanceOf(Date);

      // Settlement never touches the day counter (no decrement API exists).
      expect(await repo.dayTotal(day)).toBe(totalAfterReserve);
    },
  );

  it('sweep settles a never-terminal reservation as abandoned without changing the day total; observed usage is observability only', async () => {
    const day = freshDay();
    const reserved = await repo.reserve(day, 500, 10_000, 'ses_abandoned');
    if (!reserved.accepted) throw new Error('reserve unexpectedly refused');
    const totalAfterReserve = await repo.dayTotal(day);

    const swept = await repo.sweepAbandoned(0);
    const mine = swept.find((r) => r.reservationId === reserved.reservation.reservationId);
    expect(mine).toMatchObject({
      status: 'settled',
      terminalStatus: 'abandoned',
      reservedMicroUsd: 500,
    });
    expect(await repo.dayTotal(day)).toBe(totalAfterReserve);

    // A second settle attempt is a status-guarded no-op — the charge stands once, in full.
    const again = await repo.settle(reserved.reservation.reservationId, 'completed');
    expect(again).toBeNull();
  });
});

describe('playground spend ledger — restart survival + sweep idempotence (spec test 3)', () => {
  it('reads reservations and day totals back through a FRESH client (Postgres persistence, not memory)', async () => {
    const day = freshDay();
    const reserved = await repo.reserve(day, 1_234, 10_000, 'ses_restart');
    if (!reserved.accepted) throw new Error('reserve unexpectedly refused');

    // A brand-new connection pool simulates a mediator restart.
    const fresh = createDbClient(container.getConnectionUri());
    try {
      const freshRepo = createPlaygroundSpendRepo(fresh.db);
      expect(await freshRepo.dayTotal(day)).toBe(1_234);
      const [row] = await fresh.db
        .select()
        .from(playgroundSpendReservations)
        .where(eq(playgroundSpendReservations.reservationId, reserved.reservation.reservationId));
      expect(row).toMatchObject({ status: 'reserved', reservedMicroUsd: 1_234, sessionId: 'ses_restart' });

      // The restarted process's sweep settles the orphaned row.
      await freshRepo.sweepAbandoned(0);
      const [after] = await fresh.db
        .select()
        .from(playgroundSpendReservations)
        .where(eq(playgroundSpendReservations.reservationId, reserved.reservation.reservationId));
      expect(after).toMatchObject({ status: 'settled', terminalStatus: 'abandoned' });
    } finally {
      await fresh.close();
    }
  });

  it('sweepAbandoned settles only rows older than the threshold and is idempotent', async () => {
    const day = freshDay();
    const young = await repo.reserve(day, 100, 10_000, 'ses_young');
    if (!young.accepted) throw new Error('reserve unexpectedly refused');

    // A one-hour threshold leaves the just-created row untouched.
    const sweptNone = await repo.sweepAbandoned(60 * 60 * 1000);
    expect(sweptNone.map((r) => r.reservationId)).not.toContain(young.reservation.reservationId);

    // A zero threshold settles it…
    const sweptOne = await repo.sweepAbandoned(0);
    expect(sweptOne.map((r) => r.reservationId)).toContain(young.reservation.reservationId);

    // …and a repeat sweep touches nothing (idempotent).
    const sweptAgain = await repo.sweepAbandoned(0);
    expect(sweptAgain.map((r) => r.reservationId)).not.toContain(young.reservation.reservationId);
    expect(await repo.dayTotal(day)).toBe(100);
  });
});

describe('playground spend ledger — day boundary (spec test 4)', () => {
  it('accrues reservations on different UTC days to different day rows; a new day starts from zero against the same ceiling', async () => {
    const dayOne = freshDay();
    const dayTwo = freshDay();
    const ceiling = 1_000;

    const fillDayOne = await repo.reserve(dayOne, 1_000, ceiling, 'ses_d1');
    expect(fillDayOne.accepted).toBe(true);
    const overflow = await repo.reserve(dayOne, 1, ceiling, 'ses_d1b');
    expect(overflow).toMatchObject({ accepted: false, reason: 'daily_ceiling' });

    // The next UTC day starts from zero against the same ceiling.
    const nextDay = await repo.reserve(dayTwo, 1_000, ceiling, 'ses_d2');
    expect(nextDay.accepted).toBe(true);

    expect(await repo.dayTotal(dayOne)).toBe(1_000);
    expect(await repo.dayTotal(dayTwo)).toBe(1_000);
  });
});
