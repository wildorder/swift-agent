/**
 * WS-49 — mediator guardrail configuration, all env-tunable with safe demo
 * defaults. Money values are integer micro-USD (no floats in money paths).
 *
 * The per-run reservation is the conservative maximum derived from the
 * mediator's OWN enforced caps and the cheap model's published pricing —
 * see deploy/playground/README.md for the formula with concrete numbers.
 * USD-per-MTok is numerically micro-USD-per-token, which keeps the math exact.
 */

export interface MediatorConfig {
  /** Guest session TTL in ms (short — minutes). */
  sessionTtlMs: number;
  /** Per-IP session-mint limit: at most `max` mints per `windowMs`. */
  ipLimit: { max: number; windowMs: number };
  /** Per-session send rate limit: at most `max` sends per `windowMs`. */
  sessionLimit: { max: number; windowMs: number };
  /** Per-session message cap. */
  messagesPerSession: number;
  /** Per-message length cap (chars) — the input-token bound. */
  messageMaxChars: number;
  /** Per-session output-token cap (estimated as ceil(chars/4) of relayed token frames). */
  tokensPerSession: number;
  /** Conservative per-run maximum input tokens (all model rounds). */
  maxInputTokensPerRun: number;
  /** Conservative per-run maximum output tokens (modelConfig.maxTokens × max tool iterations). */
  maxOutputTokensPerRun: number;
  /** Cheap model input price, USD per MTok (== micro-USD per token). */
  inputPriceUsdPerMTok: number;
  /** Cheap model output price, USD per MTok (== micro-USD per token). */
  outputPriceUsdPerMTok: number;
  /** The per-run reservation, micro-USD (derived; overridable for tests). */
  reservationMicroUsd: number;
  /** Global daily spend ceiling, micro-USD. */
  dailyCeilingMicroUsd: number;
  /** Fraction of the ceiling at which the once-per-day structured warn fires. */
  alertThresholdFraction: number;
  /** Abandoned-reservation sweep interval, ms. */
  sweepIntervalMs: number;
  /** Reservations still 'reserved' after this many ms are swept as 'abandoned'. */
  abandonedAfterMs: number;
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/**
 * Load the guardrail config from env. Defaults document the deployed posture:
 * claude-3-5-haiku ($0.80 / $4.00 per MTok published pricing), maxTokens 1024
 * × 10 runtime tool iterations → 10,240 output-token bound, 30,000 input-token
 * bound (system + last-50 memory + tool schemas re-sent per round), so
 * reservation = ceil(30,000×0.8 + 10,240×4.0) = 64,960 µUSD ≈ $0.065/run,
 * and the $5.00 default daily ceiling admits ~76 runs.
 */
export function loadMediatorConfig(env: NodeJS.ProcessEnv = process.env): MediatorConfig {
  const maxInputTokensPerRun = int(env, 'PLAYGROUND_MAX_INPUT_TOKENS_PER_RUN', 30_000);
  const maxOutputTokensPerRun = int(env, 'PLAYGROUND_MAX_OUTPUT_TOKENS_PER_RUN', 10_240);
  const inputPriceUsdPerMTok = num(env, 'PLAYGROUND_INPUT_PRICE_USD_PER_MTOK', 0.8);
  const outputPriceUsdPerMTok = num(env, 'PLAYGROUND_OUTPUT_PRICE_USD_PER_MTOK', 4.0);

  const reservationMicroUsd = int(
    env,
    'PLAYGROUND_RESERVATION_MICRO_USD',
    Math.ceil(
      maxInputTokensPerRun * inputPriceUsdPerMTok + maxOutputTokensPerRun * outputPriceUsdPerMTok,
    ),
  );

  const fraction = num(env, 'PLAYGROUND_ALERT_THRESHOLD_FRACTION', 0.5);
  if (fraction > 1) {
    throw new Error(`PLAYGROUND_ALERT_THRESHOLD_FRACTION must be <= 1, got ${fraction}`);
  }

  return {
    sessionTtlMs: int(env, 'PLAYGROUND_SESSION_TTL_SECONDS', 600) * 1000,
    ipLimit: {
      max: int(env, 'PLAYGROUND_IP_MINTS_PER_WINDOW', 10),
      windowMs: int(env, 'PLAYGROUND_IP_WINDOW_SECONDS', 3600) * 1000,
    },
    sessionLimit: {
      max: int(env, 'PLAYGROUND_SESSION_SENDS_PER_WINDOW', 6),
      windowMs: int(env, 'PLAYGROUND_SESSION_WINDOW_SECONDS', 60) * 1000,
    },
    messagesPerSession: int(env, 'PLAYGROUND_MESSAGES_PER_SESSION', 20),
    messageMaxChars: int(env, 'PLAYGROUND_MESSAGE_MAX_CHARS', 500),
    tokensPerSession: int(env, 'PLAYGROUND_TOKENS_PER_SESSION', 8_000),
    maxInputTokensPerRun,
    maxOutputTokensPerRun,
    inputPriceUsdPerMTok,
    outputPriceUsdPerMTok,
    reservationMicroUsd,
    dailyCeilingMicroUsd: int(env, 'PLAYGROUND_DAILY_CEILING_MICRO_USD', 5_000_000),
    alertThresholdFraction: fraction,
    sweepIntervalMs: int(env, 'PLAYGROUND_SWEEP_INTERVAL_SECONDS', 60) * 1000,
    abandonedAfterMs: int(env, 'PLAYGROUND_ABANDONED_AFTER_SECONDS', 300) * 1000,
  };
}
