import { describe, it, expect } from 'vitest';
import { parseModelString, formatModelString } from '../parser.js';
import { ModelError } from '../types.js';

describe('parseModelString', () => {
  it('parses openai/gpt-4o correctly', () => {
    const result = parseModelString('openai/gpt-4o');
    expect(result).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  it('parses anthropic/claude-3-5-sonnet correctly', () => {
    const result = parseModelString('anthropic/claude-3-5-sonnet');
    expect(result).toEqual({ provider: 'anthropic', model: 'claude-3-5-sonnet' });
  });

  it('parses google/gemini-1.5-pro correctly', () => {
    const result = parseModelString('google/gemini-1.5-pro');
    expect(result).toEqual({ provider: 'google', model: 'gemini-1.5-pro' });
  });

  it('resolves gemini alias to google', () => {
    const result = parseModelString('gemini/gemini-1.5-pro');
    expect(result).toEqual({ provider: 'google', model: 'gemini-1.5-pro' });
  });

  it('resolves claude alias to anthropic', () => {
    const result = parseModelString('claude/claude-3-opus');
    expect(result).toEqual({ provider: 'anthropic', model: 'claude-3-opus' });
  });

  it('resolves gpt alias to openai', () => {
    const result = parseModelString('gpt/gpt-4-turbo');
    expect(result).toEqual({ provider: 'openai', model: 'gpt-4-turbo' });
  });

  it('accepts unknown provider names (registry decides validity)', () => {
    const result = parseModelString('unknown/model-v1');
    expect(result).toEqual({ provider: 'unknown', model: 'model-v1' });
  });

  it('throws on empty string', () => {
    expect(() => parseModelString('')).toThrow(ModelError);
    expect(() => parseModelString('')).toThrow('must not be empty');
  });

  it('throws on missing slash', () => {
    expect(() => parseModelString('openai-gpt-4o')).toThrow(ModelError);
    expect(() => parseModelString('openai-gpt-4o')).toThrow('expected format');
  });

  it('throws on empty provider segment', () => {
    expect(() => parseModelString('/gpt-4o')).toThrow(ModelError);
    expect(() => parseModelString('/gpt-4o')).toThrow('provider segment is empty');
  });

  it('throws on empty model segment', () => {
    expect(() => parseModelString('openai/')).toThrow(ModelError);
    expect(() => parseModelString('openai/')).toThrow('model segment is empty');
  });

  it('handles model names containing slashes', () => {
    // Only splits on first slash
    const result = parseModelString('openai/ft:gpt-4o/org/custom');
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('ft:gpt-4o/org/custom');
  });
});

describe('formatModelString', () => {
  it('formats provider and model into a model string', () => {
    expect(formatModelString('openai', 'gpt-4o')).toBe('openai/gpt-4o');
  });

  it('round-trips with parseModelString', () => {
    const parsed = parseModelString('anthropic/claude-3-5-sonnet');
    expect(formatModelString(parsed.provider, parsed.model)).toBe('anthropic/claude-3-5-sonnet');
  });
});
