import Fastify from 'fastify';
import type { FastifyInstance, FastifyError } from 'fastify';
import {
  RUNNER_PROTOCOL_VERSION,
  RUNNER_MAX_INPUT_BYTES,
  RUNNER_MAX_ERROR_BYTES,
  isSwiftAgentError,
} from '@swiftagent/shared';
import { ToolRunnerRequestSchema } from './types.js';
import type { ToolRegistry, ToolContext, RunnerAuthConfig } from './types.js';
import { verifyRunnerToken } from './runner-token.js';

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
/** How long a settled idempotency result is replayed before re-execution is allowed. */
const DEFAULT_IDEMPOTENCY_TTL_MS = 5 * 60_000;
/** Bound on the idempotency map to cap memory (LRU eviction). */
const DEFAULT_MAX_IDEMPOTENCY_ENTRIES = 1_000;
/** Envelope allowance on top of the max input — version/context/idempotencyKey overhead. */
const ENVELOPE_ALLOWANCE_BYTES = 16 * 1024;

interface ToolRunnerOptions {
  port: number;
  registry: ToolRegistry;
  /** Scoped-token verification config (WS-22). Replaces the shared-secret apiKey. */
  auth: RunnerAuthConfig;
  toolTimeoutMs?: number;
  idempotencyTtlMs?: number;
  maxIdempotencyEntries?: number;
}

/** Settled or in-flight outcome of a single logical tool call. */
type HandlerOutcome =
  | { ok: true; result: unknown }
  | { ok: false; status: number; code: string; message: string };

/**
 * Bounded in-flight-aware idempotency cache (WS-22, SC-10).
 *
 * Storing the in-flight PROMISE before the handler runs means a concurrent or
 * retried request with the same key awaits the same execution instead of
 * starting a second one — a logical tool call executes at most once per runner
 * process. Scope note: per-process only; a restart or a second replica can each
 * execute once. Cross-replica durable de-dup is future work.
 */
interface IdempotencyEntry {
  promise: Promise<HandlerOutcome>;
  settledAt: number | null;
}

class IdempotencyCache {
  private readonly entries = new Map<string, IdempotencyEntry>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  /** Return the existing (in-flight or fresh) outcome, or run `exec` under the key. */
  run(key: string, exec: () => Promise<HandlerOutcome>): Promise<HandlerOutcome> {
    const existing = this.entries.get(key);
    if (existing && (existing.settledAt === null || Date.now() - existing.settledAt < this.ttlMs)) {
      // Refresh LRU recency.
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing.promise;
    }
    if (existing) this.entries.delete(key); // expired

    // `promise` is overwritten synchronously on the next line; the `never`
    // placeholder just satisfies the initializer without an unhandled rejection.
    const entry: IdempotencyEntry = { promise: null as never, settledAt: null };
    entry.promise = exec().then(
      (outcome) => {
        entry.settledAt = Date.now();
        return outcome;
      },
      (err) => {
        // Never cache infrastructure failures — allow a genuine retry.
        this.entries.delete(key);
        throw err;
      },
    );
    this.entries.set(key, entry);
    this.evictIfNeeded();
    return entry.promise;
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

/** Constant-time-ish cap; truncates an error message to the protocol byte bound. */
function capError(message: string): string {
  if (Buffer.byteLength(message, 'utf-8') <= RUNNER_MAX_ERROR_BYTES) return message;
  return Buffer.from(message, 'utf-8').subarray(0, RUNNER_MAX_ERROR_BYTES).toString('utf-8');
}

/**
 * Start the tool runner Fastify server (WS-22 hardened).
 * Listens for versioned POST /tools/:toolName requests from the Swift Agent runtime.
 */
export async function startToolRunner(opts: ToolRunnerOptions): Promise<FastifyInstance> {
  const {
    registry,
    auth,
    port,
    toolTimeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
    idempotencyTtlMs = DEFAULT_IDEMPOTENCY_TTL_MS,
    maxIdempotencyEntries = DEFAULT_MAX_IDEMPOTENCY_ENTRIES,
  } = opts;

  const idempotency = new IdempotencyCache(idempotencyTtlMs, maxIdempotencyEntries);

  const app = Fastify({
    logger: false,
    bodyLimit: RUNNER_MAX_INPUT_BYTES + ENVELOPE_ALLOWANCE_BYTES,
  });

  // Map an over-limit body (Fastify 413) to the protocol's 400 VALIDATION shape.
  app.setErrorHandler((err: FastifyError, _req, reply) => {
    if (err.statusCode === 413 || err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.status(400).send({
        version: RUNNER_PROTOCOL_VERSION,
        error: { code: 'VALIDATION', message: 'Request body exceeds limit' },
      });
    }
    return reply.status(err.statusCode ?? 500).send({
      version: RUNNER_PROTOCOL_VERSION,
      error: { code: 'INTERNAL', message: capError(err.message) },
    });
  });

  // Health check — no auth required
  app.get('/health', async (_req, reply) => {
    return reply.status(200).send({ status: 'ok' });
  });

  app.post<{ Params: { toolName: string } }>('/tools/:toolName', async (req, reply) => {
    const { toolName } = req.params;

    const unauthorized = (message = 'Invalid or missing authorization'): ReturnType<typeof reply.send> =>
      reply.status(401).send({
        version: RUNNER_PROTOCOL_VERSION,
        error: { code: 'UNAUTHORIZED', message },
      });

    // ── Bearer present? ───────────────────────────────────────────
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return unauthorized();
    }
    const token = authHeader.slice(7);

    // ── Parse + version-check body BEFORE trusting any field ──────
    const bodyResult = ToolRunnerRequestSchema.safeParse(req.body);
    if (!bodyResult.success) {
      const wrongVersion =
        typeof req.body === 'object' &&
        req.body !== null &&
        (req.body as { version?: unknown }).version !== RUNNER_PROTOCOL_VERSION;
      return reply.status(400).send({
        version: RUNNER_PROTOCOL_VERSION,
        error: {
          code: 'VALIDATION',
          message: wrongVersion ? 'Unsupported runner protocol version' : 'Invalid request body',
          details: bodyResult.error.flatten(),
        },
      });
    }
    const { input, context, idempotencyKey } = bodyResult.data;

    // ── Verify scoped token: signature + exp + audience + workspace (SC-08) ──
    let claims;
    try {
      claims = await verifyRunnerToken(auth.publicKey, token, {
        audience: auth.expectedAudience,
        workspaceId: auth.expectedWorkspaceId,
      });
    } catch (err) {
      return unauthorized(isSwiftAgentError(err) ? err.message : 'Invalid or missing authorization');
    }

    // ── Every remaining scoped claim MUST match the request (SC-08) ──
    if (
      claims.agentId !== context.agentId ||
      claims.runId !== context.runId ||
      claims.callId !== context.callId ||
      claims.toolName !== toolName ||
      claims.idempotencyKey !== idempotencyKey
    ) {
      return unauthorized('Runner token scope does not match request');
    }

    // ── Lookup tool ───────────────────────────────────────────────
    const toolDef = registry.get(toolName);
    if (!toolDef) {
      return reply.status(404).send({
        version: RUNNER_PROTOCOL_VERSION,
        error: { code: 'NOT_FOUND', message: `Tool "${toolName}" not found` },
      });
    }

    // ── Validate input against the tool schema ────────────────────
    const inputResult = toolDef.inputSchema.safeParse(input);
    if (!inputResult.success) {
      return reply.status(400).send({
        version: RUNNER_PROTOCOL_VERSION,
        error: {
          code: 'VALIDATION',
          message: `Input validation failed for tool "${toolName}"`,
          details: inputResult.error.flatten(),
        },
      });
    }

    const ctx: ToolContext = {
      sessionId: context.sessionId,
      agentId: context.agentId,
      runId: context.runId,
      callId: context.callId,
      userId: context.userId,
      metadata: context.metadata,
    };

    // ── Execute under the idempotency key (SC-10) ─────────────────
    const outcome = await idempotency.run(idempotencyKey, () =>
      executeTool(toolDef.execute, inputResult.data, ctx, toolName, toolTimeoutMs),
    );

    if (outcome.ok) {
      return reply.status(200).send({ version: RUNNER_PROTOCOL_VERSION, result: outcome.result });
    }
    return reply.status(outcome.status).send({
      version: RUNNER_PROTOCOL_VERSION,
      error: { code: outcome.code, message: capError(outcome.message) },
    });
  });

  await app.listen({ port, host: '0.0.0.0' });
  return app;
}

/** Run a tool handler with a timeout race, normalising the result to a {@link HandlerOutcome}. */
async function executeTool(
  execute: (input: unknown, ctx: ToolContext) => Promise<unknown>,
  input: unknown,
  ctx: ToolContext,
  toolName: string,
  toolTimeoutMs: number,
): Promise<HandlerOutcome> {
  try {
    const result = await Promise.race([
      execute(input, ctx),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new ToolTimeoutError(toolName, toolTimeoutMs)), toolTimeoutMs);
      }),
    ]);
    return { ok: true, result };
  } catch (err) {
    if (err instanceof ToolTimeoutError) {
      return { ok: false, status: 504, code: 'TIMEOUT', message: err.message };
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { ok: false, status: 500, code: 'EXECUTION_ERROR', message };
  }
}

class ToolTimeoutError extends Error {
  constructor(toolName: string, timeoutMs: number) {
    super(`Tool "${toolName}" timed out after ${timeoutMs}ms`);
    this.name = 'ToolTimeoutError';
  }
}
