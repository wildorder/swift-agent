import { nanoid } from 'nanoid';
import {
  PREFIX_SESSION,
  PREFIX_MESSAGE,
  PREFIX_RUN,
  PREFIX_TOOL_CALL,
  PREFIX_AGENT,
  PREFIX_WORKSPACE,
  PREFIX_API_KEY,
  PREFIX_TRACE,
  PREFIX_SPAN,
  DEFAULT_NANOID_LENGTH,
} from '../constants.js';

function prefixedId(prefix: string): string {
  return `${prefix}${nanoid(DEFAULT_NANOID_LENGTH)}`;
}

export function generateSessionId(): string {
  return prefixedId(PREFIX_SESSION);
}

export function generateMessageId(): string {
  return prefixedId(PREFIX_MESSAGE);
}

export function generateRunId(): string {
  return prefixedId(PREFIX_RUN);
}

export function generateToolCallId(): string {
  return prefixedId(PREFIX_TOOL_CALL);
}

export function generateAgentId(): string {
  return prefixedId(PREFIX_AGENT);
}

export function generateWorkspaceId(): string {
  return prefixedId(PREFIX_WORKSPACE);
}

export function generateApiKeyId(): string {
  return prefixedId(PREFIX_API_KEY);
}

export function generateTraceId(): string {
  return prefixedId(PREFIX_TRACE);
}

export function generateSpanId(): string {
  return prefixedId(PREFIX_SPAN);
}

/**
 * Extracts the prefix from an ID string for debugging/logging.
 * Returns the prefix portion (everything before the first underscore + underscore),
 * or null if no prefix is found.
 */
export function parsePrefix(id: string): string | null {
  const idx = id.indexOf('_');
  if (idx === -1) return null;
  return id.slice(0, idx + 1);
}
