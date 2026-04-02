import { describe, it, expect } from 'vitest';
import { serializeChatEvent, parseInboundMessage, toErrorEvent, ParseError } from '../events.js';
import type { ChatEvent } from '@swiftagent/shared';

describe('serializeChatEvent', () => {
  it('serializes a ChatEvent to JSON string', () => {
    const event: ChatEvent = {
      type: 'token',
      runId: 'run_1',
      sessionId: 'ses_1',
      messageId: 'msg_1',
      text: 'hello',
    };

    const result = serializeChatEvent(event);
    expect(result).toBe(JSON.stringify(event));
    expect(JSON.parse(result)).toEqual(event);
  });

  it('serializes message_started event', () => {
    const event: ChatEvent = {
      type: 'message_started',
      messageId: 'msg_1',
      runId: 'run_1',
      sessionId: 'ses_1',
    };

    const result = serializeChatEvent(event);
    const parsed = JSON.parse(result);
    expect(parsed.type).toBe('message_started');
    expect(parsed.messageId).toBe('msg_1');
  });

  it('serializes run_failed event', () => {
    const event: ChatEvent = {
      type: 'run_failed',
      runId: 'run_1',
      sessionId: 'ses_1',
      code: 'TIMEOUT',
      message: 'Agent timed out',
    };

    const result = serializeChatEvent(event);
    const parsed = JSON.parse(result);
    expect(parsed.type).toBe('run_failed');
    expect(parsed.code).toBe('TIMEOUT');
  });
});

describe('parseInboundMessage', () => {
  it('parses a valid send_message', () => {
    const raw = JSON.stringify({ type: 'send_message', content: 'Hello!' });
    const result = parseInboundMessage(raw);
    expect(result).toEqual({ type: 'send_message', content: 'Hello!' });
  });

  it('parses a valid ping message', () => {
    const raw = JSON.stringify({ type: 'ping' });
    const result = parseInboundMessage(raw);
    expect(result).toEqual({ type: 'ping' });
  });

  it('throws ParseError with INVALID_JSON for non-JSON input', () => {
    expect(() => parseInboundMessage('not json {')).toThrow(ParseError);

    try {
      parseInboundMessage('not json {');
    } catch (err) {
      expect(err).toBeInstanceOf(ParseError);
      expect((err as ParseError).code).toBe('INVALID_JSON');
    }
  });

  it('throws ParseError with INVALID_SCHEMA for unknown type', () => {
    const raw = JSON.stringify({ type: 'unknown_type', data: 123 });

    try {
      parseInboundMessage(raw);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ParseError);
      expect((err as ParseError).code).toBe('INVALID_SCHEMA');
    }
  });

  it('throws ParseError with INVALID_SCHEMA for missing content in send_message', () => {
    const raw = JSON.stringify({ type: 'send_message' });

    try {
      parseInboundMessage(raw);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ParseError);
      expect((err as ParseError).code).toBe('INVALID_SCHEMA');
    }
  });

  it('throws ParseError with INVALID_SCHEMA for empty content in send_message', () => {
    const raw = JSON.stringify({ type: 'send_message', content: '' });

    try {
      parseInboundMessage(raw);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ParseError);
      expect((err as ParseError).code).toBe('INVALID_SCHEMA');
    }
  });

  it('throws ParseError with INVALID_SCHEMA for missing type field', () => {
    const raw = JSON.stringify({ content: 'hello' });

    try {
      parseInboundMessage(raw);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ParseError);
      expect((err as ParseError).code).toBe('INVALID_SCHEMA');
    }
  });

  it('throws ParseError with INVALID_SCHEMA for non-object input', () => {
    const raw = JSON.stringify('just a string');

    try {
      parseInboundMessage(raw);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ParseError);
      expect((err as ParseError).code).toBe('INVALID_SCHEMA');
    }
  });
});

describe('toErrorEvent', () => {
  it('returns a structured error event', () => {
    const result = toErrorEvent('AUTH_FAILED', 'Authentication failed');
    expect(result).toEqual({
      type: 'error',
      code: 'AUTH_FAILED',
      message: 'Authentication failed',
    });
  });
});

describe('ParseError', () => {
  it('has correct name, code, and message', () => {
    const err = new ParseError('INVALID_JSON', 'Bad JSON');
    expect(err.name).toBe('ParseError');
    expect(err.code).toBe('INVALID_JSON');
    expect(err.message).toBe('Bad JSON');
    expect(err).toBeInstanceOf(Error);
  });
});
