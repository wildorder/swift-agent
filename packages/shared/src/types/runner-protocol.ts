import { z } from 'zod';

/**
 * Versioned, bounded wire contract for the remote tool-runner boundary.
 *
 * Consumed by both `RemoteToolExecutor` (runtime, request side) and
 * `startToolRunner` (SDK, server side). Keeping the schema here — the single
 * shared source of truth — prevents the two sides from drifting (WS-22).
 */

/** Bumped on any breaking change to the request/response envelope. */
export const RUNNER_PROTOCOL_VERSION = '1' as const;

// ── Payload bounds (bytes) — reject oversized payloads before executing ──────

/** Max serialized tool input; the executor refuses to send larger, the runner rejects it. */
export const RUNNER_MAX_INPUT_BYTES = 256 * 1024; // 256 KiB
/** Max serialized tool output the executor will read from a runner response. */
export const RUNNER_MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB
/** Max error message the runner returns / the executor surfaces. */
export const RUNNER_MAX_ERROR_BYTES = 8 * 1024; // 8 KiB

// ── Request ──────────────────────────────────────────────────────────────────

/**
 * Invocation identity carried on every request. Every field a runner validates
 * against its signed token claim lives here; `.strict()` rejects unknown keys so
 * a caller cannot smuggle extra context past the schema.
 */
export const RunnerRequestContextSchema = z
  .object({
    sessionId: z.string().startsWith('ses_'),
    agentId: z.string().startsWith('agt_'),
    runId: z.string().startsWith('run_'),
    callId: z.string().startsWith('tc_'), // Swift Agent tc_ id — invocation identity
    userId: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type RunnerRequestContext = z.infer<typeof RunnerRequestContextSchema>;

export const RunnerRequestSchema = z
  .object({
    version: z.literal(RUNNER_PROTOCOL_VERSION),
    idempotencyKey: z.string().min(1), // stable per logical tool call (the tc_ id)
    input: z.unknown(),
    context: RunnerRequestContextSchema,
  })
  .strict();
export type RunnerRequest = z.infer<typeof RunnerRequestSchema>;

// ── Response ─────────────────────────────────────────────────────────────────

export const RunnerSuccessResponseSchema = z
  .object({
    version: z.literal(RUNNER_PROTOCOL_VERSION),
    result: z.unknown(),
  })
  .strict();
export type RunnerSuccessResponse = z.infer<typeof RunnerSuccessResponseSchema>;

export const RunnerErrorResponseSchema = z
  .object({
    version: z.literal(RUNNER_PROTOCOL_VERSION),
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .strict();
export type RunnerErrorResponse = z.infer<typeof RunnerErrorResponseSchema>;

export type RunnerResponse = RunnerSuccessResponse | RunnerErrorResponse;
