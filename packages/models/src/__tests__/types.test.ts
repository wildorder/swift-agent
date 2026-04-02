import { describe, it, expect } from 'vitest';
import { ModelError, normalizeError } from '../types.js';

describe('ModelError', () => {
  it('sets provider, statusCode, and retryable', () => {
    const err = new ModelError('rate limited', 'openai', {
      statusCode: 429,
      retryable: true,
    });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ModelError);
    expect(err.message).toBe('rate limited');
    expect(err.name).toBe('ModelError');
    expect(err.provider).toBe('openai');
    expect(err.statusCode).toBe(429);
    expect(err.retryable).toBe(true);
  });

  it('defaults retryable to false', () => {
    const err = new ModelError('bad request', 'anthropic', { statusCode: 400 });
    expect(err.retryable).toBe(false);
  });

  it('preserves cause', () => {
    const cause = new Error('original');
    const err = new ModelError('wrapped', 'google', { cause });
    expect(err.cause).toBe(cause);
  });
});

describe('normalizeError', () => {
  it('returns ModelError as-is', () => {
    const original = new ModelError('already wrapped', 'openai');
    expect(normalizeError(original, 'openai')).toBe(original);
  });

  it('wraps a generic Error with provider name and retryable: false', () => {
    const err = normalizeError(new Error('something broke'), 'anthropic');
    expect(err).toBeInstanceOf(ModelError);
    expect(err.provider).toBe('anthropic');
    expect(err.message).toBe('something broke');
    expect(err.retryable).toBe(false);
    expect(err.statusCode).toBeUndefined();
  });

  it('detects status 429 as retryable', () => {
    const sdkError = Object.assign(new Error('rate limit'), { status: 429 });
    const err = normalizeError(sdkError, 'openai');

    expect(err.statusCode).toBe(429);
    expect(err.retryable).toBe(true);
  });

  it('detects status 503 as retryable', () => {
    const sdkError = Object.assign(new Error('service unavailable'), { status: 503 });
    const err = normalizeError(sdkError, 'google');

    expect(err.statusCode).toBe(503);
    expect(err.retryable).toBe(true);
  });

  it('detects statusCode property (alternative SDK format)', () => {
    const sdkError = Object.assign(new Error('overloaded'), { statusCode: 529 });
    const err = normalizeError(sdkError, 'anthropic');

    expect(err.statusCode).toBe(529);
    expect(err.retryable).toBe(false);
  });

  it('detects status 400 as non-retryable', () => {
    const sdkError = Object.assign(new Error('bad request'), { status: 400 });
    const err = normalizeError(sdkError, 'openai');

    expect(err.statusCode).toBe(400);
    expect(err.retryable).toBe(false);
  });

  it('wraps a string value', () => {
    const err = normalizeError('something went wrong', 'openai');
    expect(err.message).toBe('something went wrong');
    expect(err.provider).toBe('openai');
  });

  it('preserves original error as cause', () => {
    const original = new Error('original');
    const err = normalizeError(original, 'openai');
    expect(err.cause).toBe(original);
  });
});
