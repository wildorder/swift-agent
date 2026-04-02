import { describe, it, expect } from 'vitest';

describe('index exports', () => {
  it('exports buildContainer and startServer for programmatic use', async () => {
    const mod = await import('../index.js');
    expect(typeof mod.buildContainer).toBe('function');
    expect(typeof mod.startServer).toBe('function');
    expect(typeof mod.loadServerConfig).toBe('function');
    expect(typeof mod.redactConfig).toBe('function');
    expect(typeof mod.registerHealthCheck).toBe('function');
  });
});
