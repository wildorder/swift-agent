import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { tool, toolToJsonSchema } from '../tool.js';

describe('tool()', () => {
  it('returns a frozen object with correct name and description', () => {
    const t = tool({
      name: 'weather',
      description: 'Get the weather',
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ temp: 72, city }),
    });

    expect(t.name).toBe('weather');
    expect(t.description).toBe('Get the weather');
    expect(Object.isFrozen(t)).toBe(true);
  });

  it('throws if name is missing', () => {
    expect(() =>
      tool({
        name: '',
        description: 'desc',
        inputSchema: z.object({}),
        execute: async () => ({}),
      }),
    ).toThrow('name');
  });

  it('throws if description is missing', () => {
    expect(() =>
      tool({
        name: 'test',
        description: '',
        inputSchema: z.object({}),
        execute: async () => ({}),
      }),
    ).toThrow('description');
  });

  it('throws if inputSchema is not a Zod schema', () => {
    expect(() =>
      tool({
        name: 'test',
        description: 'desc',
        inputSchema: { type: 'object' } as any,
        execute: async () => ({}),
      }),
    ).toThrow('inputSchema');
  });

  it('throws if execute is not a function', () => {
    expect(() =>
      tool({
        name: 'test',
        description: 'desc',
        inputSchema: z.object({}),
        execute: 'not a function' as any,
      }),
    ).toThrow('execute');
  });
});

describe('toolToJsonSchema()', () => {
  it('converts Zod schema to JSON Schema for API registration', () => {
    const t = tool({
      name: 'lookup',
      description: 'Look up a thing',
      inputSchema: z.object({ id: z.string(), count: z.number().optional() }),
      execute: async () => ({}),
    });

    const schema = toolToJsonSchema(t);
    expect(schema.name).toBe('lookup');
    expect(schema.description).toBe('Look up a thing');
    expect(schema.parameters).toBeDefined();
    expect((schema.parameters as any).type).toBe('object');
    expect((schema.parameters as any).properties?.id).toBeDefined();
    expect((schema.parameters as any).properties?.count).toBeDefined();
    expect((schema.parameters as any).required).toContain('id');
  });
});
