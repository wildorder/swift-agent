import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { createTracedLogger } from '../logger.js';

describe('createTracedLogger', () => {
  it('includes traceId in log output', () => {
    const logs: Record<string, unknown>[] = [];
    const base = pino({
      level: 'info',
      transport: undefined,
    }, {
      write(chunk: string) {
        logs.push(JSON.parse(chunk));
      },
    });

    const traced = createTracedLogger(base, { traceId: 'tr_test123' });
    traced.info('hello');

    expect(logs).toHaveLength(1);
    expect(logs[0].traceId).toBe('tr_test123');
    expect(logs[0].msg).toBe('hello');
  });

  it('includes both traceId and spanId when spanId is provided', () => {
    const logs: Record<string, unknown>[] = [];
    const base = pino({
      level: 'info',
    }, {
      write(chunk: string) {
        logs.push(JSON.parse(chunk));
      },
    });

    const traced = createTracedLogger(base, { traceId: 'tr_abc', spanId: 'sp_xyz' });
    traced.info('test');

    expect(logs[0].traceId).toBe('tr_abc');
    expect(logs[0].spanId).toBe('sp_xyz');
  });

  it('does not include spanId when not provided', () => {
    const logs: Record<string, unknown>[] = [];
    const base = pino({
      level: 'info',
    }, {
      write(chunk: string) {
        logs.push(JSON.parse(chunk));
      },
    });

    const traced = createTracedLogger(base, { traceId: 'tr_only' });
    traced.info('test');

    expect(logs[0].traceId).toBe('tr_only');
    expect(logs[0].spanId).toBeUndefined();
  });
});
