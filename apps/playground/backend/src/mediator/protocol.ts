import { z } from 'zod';

/**
 * WS-49 — the mediator's OWN app-level protocol (SC-09).
 *
 * Zod schemas are the source of truth (CLAUDE.md); the frontend imports the
 * inferred types from THIS module, never from any `@swiftagent` package.
 *
 * The protocol is deliberately disjoint from the closed `ChatEvent` union:
 * relayed `ChatEvent` frames pass through the mediator byte-for-byte, and
 * mediator frames are distinguishable by `type` values that must never
 * collide with the six ChatEvent types (`message_started`, `token`,
 * `tool_call_started`, `tool_call_completed`, `message_completed`,
 * `run_failed`). Refusals are NEVER a new ChatEvent variant, an unhandled
 * error, a 500, or a dropped socket.
 */

/** Every enforced limit has exactly one defined refusal reason. */
export const RefusalReasonSchema = z.enum([
  /** Per-IP session-mint rate limit (also the HTTP 429 body on POST /playground/session). */
  'rate_limit_ip',
  /** Per-session send rate limit. */
  'rate_limit_session',
  /** Per-session message cap reached — or a single message over the per-message length cap. */
  'message_cap',
  /** Per-session (estimated output) token cap reached; the active run is cancelled upstream. */
  'token_cap',
  /** The global daily spend ledger refused the reservation. */
  'daily_ceiling',
  /** Guest TTL elapsed (delivered BEFORE the socket closes). */
  'session_expired',
  /** Unparseable/unknown inbound frame. */
  'bad_frame',
]);
export type RefusalReason = z.infer<typeof RefusalReasonSchema>;

export const SessionLimitsSchema = z
  .object({
    messagesPerSession: z.number().int().positive(),
    tokensPerSession: z.number().int().positive(),
    messageMaxChars: z.number().int().positive(),
  })
  .strict();
export type SessionLimits = z.infer<typeof SessionLimitsSchema>;

/**
 * Sent as the JSON body of POST /playground/session AND as the first frame on
 * a freshly attached mediator WebSocket. Deliberately credential-free: no
 * workspace API key, no client JWT, no upstream websocketUrl, no provider key
 * — the browser gets an opaque guest id and the limits, nothing else.
 */
export const SessionReadyFrameSchema = z
  .object({
    type: z.literal('session_ready'),
    guestId: z.string().min(1),
    sessionId: z.string().min(1),
    /** ISO timestamp of guest-session expiry (TTL). */
    expiresAt: z.string().min(1),
    limits: SessionLimitsSchema,
  })
  .strict();
export type SessionReadyFrame = z.infer<typeof SessionReadyFrameSchema>;

export const RefusalFrameSchema = z
  .object({
    type: z.literal('refusal'),
    reason: RefusalReasonSchema,
    /** Human-readable, rendered by the frontend's RefusalNotice. */
    message: z.string().min(1),
    retryAfterSeconds: z.number().int().nonnegative().optional(),
    remaining: z
      .object({
        messages: z.number().int().nonnegative().optional(),
        tokens: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type RefusalFrame = z.infer<typeof RefusalFrameSchema>;

/** server → browser frames the mediator itself speaks (relayed ChatEvents pass beside them). */
export const MediatorFrameSchema = z.discriminatedUnion('type', [
  SessionReadyFrameSchema,
  RefusalFrameSchema,
]);
export type MediatorFrame = z.infer<typeof MediatorFrameSchema>;

/** browser → mediator: the ONLY accepted inbound frame. */
export const MediatorInboundSchema = z
  .object({
    type: z.literal('send'),
    content: z.string().min(1),
  })
  .strict();
export type MediatorInbound = z.infer<typeof MediatorInboundSchema>;
