import { describe, it, expect } from 'vitest';
import {
  ToolDefinitionSchema,
  AgentConfigSchema,
  AgentRecordSchema,
} from '../index.js';

const validTool = {
  name: 'lookupOrder',
  description: 'Look up an order by id',
  inputSchema: { type: 'object', properties: { orderId: { type: 'string' } } },
};

const validAgentConfig = {
  name: 'support-agent',
  modelConfig: { model: 'anthropic/claude-sonnet' },
  systemPrompt: 'You are helpful.',
};

const now = new Date();
const validRecordWithoutTools = {
  agentId: 'agt_abc',
  workspaceId: 'ws_123',
  name: 'support-agent',
  modelConfig: { model: 'anthropic/claude-sonnet' },
  systemPrompt: 'You are helpful.',
  memoryConfig: { strategy: 'last_n' as const, maxMessages: 50 },
  toolRunnerUrl: null,
  createdAt: now,
  updatedAt: now,
};

describe('ToolDefinitionSchema', () => {
  it('accepts a normalized tool definition', () => {
    const result = ToolDefinitionSchema.safeParse(validTool);
    expect(result.success).toBe(true);
  });

  it('rejects a tool object containing an execute handler (strict)', () => {
    const result = ToolDefinitionSchema.safeParse({
      ...validTool,
      execute: () => undefined,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a tool with an empty name', () => {
    const result = ToolDefinitionSchema.safeParse({ ...validTool, name: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a tool missing inputSchema', () => {
    const { inputSchema: _omit, ...withoutSchema } = validTool;
    const result = ToolDefinitionSchema.safeParse(withoutSchema);
    expect(result.success).toBe(false);
  });
});

describe('AgentConfigSchema with tools', () => {
  it('accepts an optional tools array', () => {
    const result = AgentConfigSchema.safeParse({
      ...validAgentConfig,
      tools: [validTool],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a config without tools', () => {
    const result = AgentConfigSchema.safeParse(validAgentConfig);
    expect(result.success).toBe(true);
  });

  it('rejects tools carrying an execute handler', () => {
    const result = AgentConfigSchema.safeParse({
      ...validAgentConfig,
      tools: [{ ...validTool, execute: () => undefined }],
    });
    expect(result.success).toBe(false);
  });
});

describe('AgentRecordSchema tools default (SC-02)', () => {
  it('defaults tools to an empty array for legacy records missing the field', () => {
    const result = AgentRecordSchema.parse(validRecordWithoutTools);
    expect(result.tools).toEqual([]);
  });

  it('parses a record that carries tools', () => {
    const result = AgentRecordSchema.parse({
      ...validRecordWithoutTools,
      tools: [validTool],
    });
    expect(result.tools).toEqual([validTool]);
  });

  it('coerces a null tools value is not permitted (must be array or absent)', () => {
    const result = AgentRecordSchema.safeParse({
      ...validRecordWithoutTools,
      tools: null,
    });
    expect(result.success).toBe(false);
  });
});
