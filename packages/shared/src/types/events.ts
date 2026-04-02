import { z } from 'zod';
import type { ToolCallStatus } from './tool-call.js';
import { ToolCallStatusSchema } from './tool-call.js';

// --- TypeScript types ---

export type MessageStartedEvent = {
  type: 'message_started';
  messageId: string;
  runId: string;
  sessionId: string;
};

export type TokenEvent = {
  type: 'token';
  runId: string;
  sessionId: string;
  messageId: string;
  text: string;
};

export type ToolCallStartedEvent = {
  type: 'tool_call_started';
  callId: string;
  runId: string;
  sessionId: string;
  toolName: string;
};

export type ToolCallCompletedEvent = {
  type: 'tool_call_completed';
  callId: string;
  runId: string;
  sessionId: string;
  toolName: string;
  status: ToolCallStatus;
};

export type MessageCompletedEvent = {
  type: 'message_completed';
  messageId: string;
  runId: string;
  sessionId: string;
};

export type RunFailedEvent = {
  type: 'run_failed';
  runId: string;
  sessionId: string;
  code: string;
  message: string;
  cause?: unknown;
};

export type ChatEvent =
  | MessageStartedEvent
  | TokenEvent
  | ToolCallStartedEvent
  | ToolCallCompletedEvent
  | MessageCompletedEvent
  | RunFailedEvent;

// --- Zod schemas ---

export const MessageStartedEventSchema = z.object({
  type: z.literal('message_started'),
  messageId: z.string(),
  runId: z.string(),
  sessionId: z.string(),
}).strict();

export const TokenEventSchema = z.object({
  type: z.literal('token'),
  runId: z.string(),
  sessionId: z.string(),
  messageId: z.string(),
  text: z.string(),
}).strict();

export const ToolCallStartedEventSchema = z.object({
  type: z.literal('tool_call_started'),
  callId: z.string(),
  runId: z.string(),
  sessionId: z.string(),
  toolName: z.string(),
}).strict();

export const ToolCallCompletedEventSchema = z.object({
  type: z.literal('tool_call_completed'),
  callId: z.string(),
  runId: z.string(),
  sessionId: z.string(),
  toolName: z.string(),
  status: ToolCallStatusSchema,
}).strict();

export const MessageCompletedEventSchema = z.object({
  type: z.literal('message_completed'),
  messageId: z.string(),
  runId: z.string(),
  sessionId: z.string(),
}).strict();

export const RunFailedEventSchema = z.object({
  type: z.literal('run_failed'),
  runId: z.string(),
  sessionId: z.string(),
  code: z.string(),
  message: z.string(),
  cause: z.unknown().optional(),
}).strict();

export const ChatEventSchema = z.discriminatedUnion('type', [
  MessageStartedEventSchema,
  TokenEventSchema,
  ToolCallStartedEventSchema,
  ToolCallCompletedEventSchema,
  MessageCompletedEventSchema,
  RunFailedEventSchema,
]);
