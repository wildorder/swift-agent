import { describe, it, expect } from 'vitest';
import { echoTool, supportAgent } from '../server.js';

// These assertions run with no env and no network: importing `server.js` only
// evaluates the `echoTool`/`supportAgent` definitions — `main()` is guarded
// behind an entrypoint check, so no server boots.

describe('echoTool', () => {
  it('is a frozen tool definition with a working Zod inputSchema', () => {
    expect(Object.isFrozen(echoTool)).toBe(true);
    expect(echoTool.name).toBe('echo');
    expect(echoTool.inputSchema.safeParse({ message: 'hi' }).success).toBe(true);
    expect(echoTool.inputSchema.safeParse({ message: '' }).success).toBe(false);
  });
});

describe('supportAgent', () => {
  it('defines the support-assistant agent with the echo tool', () => {
    expect(supportAgent.name).toBe('support-assistant');
    expect(supportAgent.modelConfig.model).toBe('anthropic/claude-sonnet');
    expect(supportAgent.toolSchemas.map((t) => t.name)).toContain('echo');
  });
});
