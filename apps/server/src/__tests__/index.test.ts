import { describe, it, expect } from 'vitest';

describe('index exports', () => {
  it('exports buildContainer and startServer for programmatic use', async () => {
    // This dynamic import evaluates the entire server module graph (~2.5s in
    // isolation, unbounded under parallel turbo load). The suite-level
    // testTimeout in vitest.config.ts exists for exactly this test — do not
    // "simplify" the config back to the vitest default (WS-51 / SC-17).
    const mod = await import('../index.js');
    expect(typeof mod.buildContainer).toBe('function');
    expect(typeof mod.startServer).toBe('function');
    expect(typeof mod.loadServerConfig).toBe('function');
    expect(typeof mod.redactConfig).toBe('function');
    expect(typeof mod.registerHealthCheck).toBe('function');
  });
});
