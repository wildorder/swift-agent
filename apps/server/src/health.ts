import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@swiftagent/db';
import type { ConnectionManager } from '@swiftagent/gateway';

// ── Health check types ────────────────────────────────────────────────

interface HealthCheckResult {
  status: 'ok' | 'degraded';
  checks: {
    db: 'ok' | 'error';
    redis: 'ok' | 'error' | 'disabled';
    gateway: {
      connections: number;
    };
  };
  uptime: number;
}

interface HealthDeps {
  dbClient: DbClient;
  connectionManager: ConnectionManager | null;
  redisEnabled: boolean;
  redisPing?: () => Promise<boolean>;
}

// ── Register health endpoint ──────────────────────────────────────────

const startTime = Date.now();

export function registerHealthCheck(app: FastifyInstance, deps: HealthDeps): void {
  app.get('/health', async (_req, reply) => {
    const result: HealthCheckResult = {
      status: 'ok',
      checks: {
        db: 'ok',
        redis: deps.redisEnabled ? 'ok' : 'disabled',
        gateway: {
          connections: deps.connectionManager?.connectionCount() ?? 0,
        },
      },
      uptime: Math.floor((Date.now() - startTime) / 1000),
    };

    // Check database via the underlying postgres pool
    try {
      await deps.dbClient.pool`SELECT 1`;
    } catch {
      result.checks.db = 'error';
      result.status = 'degraded';
    }

    // Check Redis if enabled
    if (deps.redisEnabled && deps.redisPing) {
      try {
        const ok = await deps.redisPing();
        if (!ok) {
          result.checks.redis = 'error';
          result.status = 'degraded';
        }
      } catch {
        result.checks.redis = 'error';
        result.status = 'degraded';
      }
    }

    const statusCode = result.status === 'ok' ? 200 : 503;
    return reply.status(statusCode).send(result);
  });
}
