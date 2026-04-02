import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerHealthCheck } from '../health.js';

describe('registerHealthCheck', () => {
  let app: FastifyInstance;

  const mockDbClient = {
    db: {},
    pool: Object.assign(
      // Tagged template function mock
      (..._args: unknown[]) => Promise.resolve([{ '?column?': 1 }]),
      { end: vi.fn() },
    ),
    close: vi.fn(),
  };

  const mockConnectionManager = {
    connectionCount: vi.fn(() => 5),
  };

  afterAll(async () => {
    if (app) await app.close();
  });

  it('returns 200 with status ok when DB is reachable', async () => {
    app = Fastify();
    registerHealthCheck(app, {
      dbClient: mockDbClient as never,
      connectionManager: mockConnectionManager as never,
      redisEnabled: false,
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe('ok');
    expect(body.checks.db).toBe('ok');
    expect(body.checks.redis).toBe('disabled');
    expect(body.checks.gateway.connections).toBe(5);
    expect(typeof body.uptime).toBe('number');
  });

  it('returns 503 when database is unreachable', async () => {
    await app.close();
    app = Fastify();

    const failingDbClient = {
      db: {},
      pool: Object.assign(
        (..._args: unknown[]) => Promise.reject(new Error('connection refused')),
        { end: vi.fn() },
      ),
      close: vi.fn(),
    };

    registerHealthCheck(app, {
      dbClient: failingDbClient as never,
      connectionManager: null,
      redisEnabled: false,
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe('degraded');
    expect(body.checks.db).toBe('error');
  });

  it('reports redis error when ping fails', async () => {
    await app.close();
    app = Fastify();

    registerHealthCheck(app, {
      dbClient: mockDbClient as never,
      connectionManager: null,
      redisEnabled: true,
      redisPing: async () => { throw new Error('ECONNREFUSED'); },
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe('degraded');
    expect(body.checks.redis).toBe('error');
  });

  it('reports gateway connections as 0 when no connection manager', async () => {
    await app.close();
    app = Fastify();

    registerHealthCheck(app, {
      dbClient: mockDbClient as never,
      connectionManager: null,
      redisEnabled: false,
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = JSON.parse(res.payload);
    expect(body.checks.gateway.connections).toBe(0);
  });
});
