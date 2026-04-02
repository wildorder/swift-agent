import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineAgent } from '../agent.js';
import { tool } from '../tool.js';

describe('defineAgent()', () => {
  it('returns a valid agent definition from a complete config', () => {
    const weatherTool = tool({
      name: 'weather',
      description: 'Get weather',
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ temp: 72, city }),
    });

    const agent = defineAgent({
      name: 'assistant',
      model: 'anthropic/claude-sonnet',
      system: 'You are helpful.',
      tools: [weatherTool],
      temperature: 0.7,
      maxTokens: 4096,
      memory: { strategy: 'last_n', maxMessages: 50 },
    });

    expect(agent.name).toBe('assistant');
    expect(agent.modelConfig.model).toBe('anthropic/claude-sonnet');
    expect(agent.modelConfig.temperature).toBe(0.7);
    expect(agent.modelConfig.maxTokens).toBe(4096);
    expect(agent.systemPrompt).toBe('You are helpful.');
    expect(agent.memoryConfig?.strategy).toBe('last_n');
    expect(agent.memoryConfig?.maxMessages).toBe(50);
    expect(agent.toolSchemas).toHaveLength(1);
    expect(agent.toolSchemas[0].name).toBe('weather');
    expect(agent.tools).toHaveLength(1);
    expect(Object.isFrozen(agent)).toBe(true);
  });

  it('works with minimal config (name + model only)', () => {
    const agent = defineAgent({
      name: 'simple',
      model: 'openai/gpt-4',
    });

    expect(agent.name).toBe('simple');
    expect(agent.modelConfig.model).toBe('openai/gpt-4');
    expect(agent.systemPrompt).toBe('');
    expect(agent.memoryConfig).toBeUndefined();
    expect(agent.toolSchemas).toHaveLength(0);
    expect(agent.tools).toHaveLength(0);
  });

  it('throws when name is missing', () => {
    expect(() =>
      defineAgent({ name: '', model: 'openai/gpt-4' }),
    ).toThrow();
  });

  it('throws when model is missing', () => {
    expect(() =>
      defineAgent({ name: 'test', model: '' }),
    ).toThrow();
  });

  it('throws on invalid memory shape', () => {
    expect(() =>
      defineAgent({
        name: 'test',
        model: 'openai/gpt-4',
        memory: { strategy: 'invalid' as any },
      }),
    ).toThrow();
  });

  it('throws on duplicate tool names within agent', () => {
    const t1 = tool({
      name: 'dup',
      description: 'First',
      inputSchema: z.object({}),
      execute: async () => ({}),
    });
    const t2 = tool({
      name: 'dup',
      description: 'Second',
      inputSchema: z.object({}),
      execute: async () => ({}),
    });

    expect(() =>
      defineAgent({
        name: 'test',
        model: 'openai/gpt-4',
        tools: [t1, t2],
      }),
    ).toThrow('Duplicate tool name "dup"');
  });
});
