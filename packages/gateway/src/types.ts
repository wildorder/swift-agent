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

export const InboundMessageSchema = z.discriminatedUnion('type', [
  SendMessageSchema,
  PingMessageSchema,
]);

export type SendMessage = z.infer<typeof SendMessageSchema>;
export type PingMessage = z.infer<typeof PingMessageSchema>;
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
 * Interface for the runtime that processes user messages.
 * AgentEngine from @swiftagent/runtime implements this contract.
 */
export interface RuntimeDelegate {
  run(
    sessionId: string,
    userMessage: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatEvent>;
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
