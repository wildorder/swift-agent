import postgres from 'postgres';

/**
 * WS-49 — ephemeral-retention cleanup for the deployed playground (SC-09).
 *
 * Pure SQL deletes against the playground's OWN isolated database (the
 * runtime service's Postgres — never dev/staging/prod): expired guest
 * sessions' data older than the retention window, plus settled ledger
 * reservations older than the audit window. Day totals
 * (`playground_spend_days`) are KEPT — they are the spend record.
 *
 * This is deployment configuration, not a runtime retention mode (which is
 * explicitly out of program scope). Schedule it per
 * deploy/playground/README.md (host scheduler / `fly machine run --schedule`),
 * or run it ad hoc:
 *
 *   DATABASE_URL=postgres://… node apps/playground/dist/backend/scripts/retention-cleanup.js
 *
 * Env:
 *   DATABASE_URL                     required — the playground runtime's DB
 *   PLAYGROUND_RETENTION_HOURS       session-data window (default 24)
 *   PLAYGROUND_LEDGER_AUDIT_DAYS     settled-reservation window (default 30)
 */

function intEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required (the playground\'s own isolated database)');
  }
  const retentionHours = intEnv('PLAYGROUND_RETENTION_HOURS', 24);
  const auditDays = intEnv('PLAYGROUND_LEDGER_AUDIT_DAYS', 30);

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    // Guest sessions past the retention window, and everything hanging off
    // them — children first, respecting the FK chain
    // (trace_spans → traces → runs; tool_calls/messages → runs/sessions).
    // Deletes run children-first so a partial run is safe to re-run
    // (idempotent cleanup, no dangling FKs).
    const old = sql`
      SELECT session_id FROM sessions
      WHERE created_at < now() - make_interval(hours => ${retentionHours})
    `;
    const oldRuns = sql`SELECT run_id FROM runs WHERE session_id IN (${old})`;

    const spans = await sql`
      DELETE FROM trace_spans WHERE trace_id IN (
        SELECT trace_id FROM traces WHERE run_id IN (${oldRuns})
      )`;
    const tracesDeleted = await sql`DELETE FROM traces WHERE run_id IN (${oldRuns})`;
    const toolCalls = await sql`DELETE FROM tool_calls WHERE run_id IN (${oldRuns})`;
    const messages = await sql`DELETE FROM messages WHERE session_id IN (${old})`;
    const runs = await sql`DELETE FROM runs WHERE session_id IN (${old})`;
    const sessions = await sql`
      DELETE FROM sessions
      WHERE created_at < now() - make_interval(hours => ${retentionHours})`;

    // Old SETTLED ledger reservations past the audit window. 'reserved'
    // rows are NEVER deleted (the sweep owns them); day totals are kept.
    const reservations = await sql`
      DELETE FROM playground_spend_reservations
      WHERE status = 'settled'
        AND created_at < now() - make_interval(days => ${auditDays})`;

    const counts = {
      traceSpans: spans.count,
      traces: tracesDeleted.count,
      toolCalls: toolCalls.count,
      messages: messages.count,
      runs: runs.count,
      sessions: sessions.count,
      settledReservations: reservations.count,
    };

    console.log(
      `[retention-cleanup] done (retention=${retentionHours}h, audit=${auditDays}d): ` +
        JSON.stringify(counts),
    );
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  console.error('[retention-cleanup] FAILED:', err);
  process.exit(1);
});
