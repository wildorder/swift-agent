import type { ChatEvent } from '@swiftagent/shared';
import { InboundMessageSchema, type InboundMessage, type ErrorEvent } from './types.js';

/**
 * Serialize a ChatEvent to a JSON string for sending over WebSocket.
 */
export function serializeChatEvent(event: ChatEvent): string {
  return JSON.stringify(event);
}

/**
 * Parse a raw WebSocket message into a typed InboundMessage.
 * Throws ParseError if the message is not valid JSON or doesn't match the schema.
 */
export function parseInboundMessage(raw: string): InboundMessage {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ParseError('INVALID_JSON', 'Message is not valid JSON');
  }

  const result = InboundMessageSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new ParseError('INVALID_SCHEMA', `Invalid message format: ${issues}`);
  }

  return result.data;
}

/**
 * Construct a structured error event for sending to clients.
 */
export function toErrorEvent(code: string, message: string): ErrorEvent {
  return { type: 'error', code, message };
}

// ── Parse error ────────────────────────────────────────────────────────

export class ParseError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ParseError';
    this.code = code;
  }
}
