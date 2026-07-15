import { z } from 'zod';
import type { ChatEvent } from '@swiftagent/shared';

// Re-export ChatEvent for gateway consumers
export type { ChatEvent } from '@swiftagent/shared';

// ── Inbound client messages ────────────────────────────────────────────

export const SendMessageSchema = z.object({
  type: z.literal('send_message'),
  content: z.string().min(1, 'Message content must not be empty'),
});

export const PingMessageSchema = z.object({
  type: z.literal('ping'),
});

/**
 * Explicit client-initiated cancellation of the session's active run (WS-24).
 * Distinct from a socket disconnect, which does NOT cancel a server-owned run.
 */
export const CancelMessageSchema = z.object({
  type: z.literal('cancel'),
}).strict();

export const InboundMessageSchema = z.discriminatedUnion('type', [
  SendMessageSchema,
  PingMessageSchema,
  CancelMessageSchema,
]);

export type SendMessage = z.infer<typeof SendMessageSchema>;
export type PingMessage = z.infer<typeof PingMessageSchema>;
export type CancelMessage = z.infer<typeof CancelMessageSchema>;
export type InboundMessage = z.infer<typeof InboundMessageSchema>;

// ── Outbound error payload ─────────────────────────────────────────────

export type ErrorEvent = {
  type: 'error';
  code: string;
  message: string;
};

// ── Gateway configuration ──────────────────────────────────────────────

export interface GatewayConfig {
  /** Port to listen on. Default: 3001 */
  port?: number;

  /** JWT secret for client token validation */
  jwtSecret: string;

  /** Heartbeat timeout in ms. Default: 30000 */
  heartbeatTimeoutMs?: number;

  /** Redis URL for pub/sub. Optional — when absent, pub/sub is a no-op */
  redisUrl?: string;

  /** Whether Redis pub/sub is enabled. Default: false */
  redisEnabled?: boolean;

  /** Fastify logger config */
  logger?: boolean | object;

  /** Max buffered events per run for reconnection replay. Default: 200 */
  maxReplayBufferSize?: number;
}

// ── Runtime delegate ───────────────────────────────────────────────────

/**
 * Interface for the unified run execution service that processes user messages
 * (WS-23). `RunExecutionService` from @swiftagent/runtime satisfies this
 * contract. The gateway supplies an `onEvent` sink; `start` drives the run to a
 * terminal state, forwarding every event, and resolves once fully drained. It
 * throws `SwiftAgentError(CONFLICT)` when the session already has an active run
 * — shared with the REST path via one session lock (SC-12).
 */
export interface RuntimeDelegate {
  start(
    input: { sessionId: string; content: string },
    opts?: { onEvent?: (event: ChatEvent) => void; signal?: AbortSignal },
  ): Promise<{ runId: string }>;
  /**
   * Idempotent cancellation of an in-flight run (WS-24). Invoked when a client
   * sends an explicit `cancel` message. Safe to call for an unknown or
   * already-terminal run.
   */
  requestCancel(runId: string): Promise<{ requested: boolean }>;
}

// ── WebSocket with metadata ────────────────────────────────────────────

export interface AuthenticatedSocket {
  sessionId: string;
  agentId: string;
}

// ── Default values ─────────────────────────────────────────────────────

export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;
export const DEFAULT_GATEWAY_PORT = 3001;
export const DEFAULT_MAX_REPLAY_BUFFER_SIZE = 200;
