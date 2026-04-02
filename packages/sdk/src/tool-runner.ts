import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { ToolRunnerRequestSchema } from './types.js';
import type { ToolRegistry, ToolContext } from './types.js';
import { timingSafeEqual } from 'node:crypto';

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

interface ToolRunnerOptions {
  port: number;
  registry: ToolRegistry;
  apiKey: string;
  toolTimeoutMs?: number;
}

/**
 * Constant-time comparison of two strings to prevent timing attacks.
 */
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) {
    // Compare with self to maintain constant time on length mismatch
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Start the tool runner Fastify server.
 * Listens for POST /tools/:toolName requests from the Swift Agent runtime.
 */
export async function startToolRunner(opts: ToolRunnerOptions): Promise<FastifyInstance> {
  const { port, registry, apiKey, toolTimeoutMs = DEFAULT_TOOL_TIMEOUT_MS } = opts;

  const app = Fastify({ logger: false });

  // Health check — no auth required
  app.get('/health', async (_req, reply) => {
    return reply.status(200).send({ status: 'ok' });
  });

  // Tool execution endpoint
  app.post<{ Params: { toolName: string } }>('/tools/:toolName', async (req, reply) => {
    // ── Auth check ────────────────────────────────────────────
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Invalid or missing authorization' },
      });
    }

    const token = authHeader.slice(7);
    if (!safeCompare(token, apiKey)) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Invalid or missing authorization' },
      });
    }

    // ── Lookup tool ───────────────────────────────────────────
    const { toolName } = req.params;
    const toolDef = registry.get(toolName);
    if (!toolDef) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: `Tool "${toolName}" not found` },
      });
    }

    // ── Parse body ────────────────────────────────────────────
    const bodyResult = ToolRunnerRequestSchema.safeParse(req.body);
    if (!bodyResult.success) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION',
          message: 'Invalid request body',
          details: bodyResult.error.flatten(),
        },
      });
    }

    const { input, context } = bodyResult.data;

    // ── Validate input against tool schema ────────────────────
    const inputResult = toolDef.inputSchema.safeParse(input);
    if (!inputResult.success) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION',
          message: `Input validation failed for tool "${toolName}"`,
          details: inputResult.error.flatten(),
        },
      });
    }

    // ── Execute with timeout ─────────────────────────────────
    const ctx: ToolContext = {
      sessionId: context.sessionId,
      userId: context.userId,
      metadata: context.metadata,
    };

    try {
      const result = await Promise.race([
        toolDef.execute(inputResult.data, ctx),
        new Promise((_resolve, reject) => {
          setTimeout(
            () => reject(new ToolTimeoutError(toolName, toolTimeoutMs)),
            toolTimeoutMs,
          );
        }),
      ]);

      return reply.status(200).send({ result });
    } catch (err) {
      if (err instanceof ToolTimeoutError) {
        return reply.status(504).send({
          error: { code: 'TIMEOUT', message: err.message },
        });
      }

      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(500).send({
        error: { code: 'EXECUTION_ERROR', message },
      });
    }
  });

  await app.listen({ port, host: '0.0.0.0' });
  return app;
}

class ToolTimeoutError extends Error {
  constructor(toolName: string, timeoutMs: number) {
    super(`Tool "${toolName}" timed out after ${timeoutMs}ms`);
    this.name = 'ToolTimeoutError';
  }
}
