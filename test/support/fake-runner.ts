import { createServer } from 'node:net';
import { z } from 'zod';
import type { CryptoKey, KeyObject } from 'jose';
import { RUNNER_MAX_OUTPUT_BYTES } from '@swiftagent/shared';
import { tool, type ToolDefinition } from '@swiftagent/sdk';
import { startToolRunner } from '@swiftagent/sdk/internal';

/**
 * Starts a REAL SDK tool runner (`startToolRunner`) on a pre-reserved port so
 * WS-22's scoped-token auth, SSRF policy, idempotency de-dup, and payload bounds
 * are genuinely exercised over HTTP (WS-25). Scripted tools:
 *
 *   - `echo`    — returns its input.
 *   - `counter` — increments a shared counter (detects double execution, SC-10).
 *   - `slow`    — delays past the caller's deadline (drives tool timeouts, SC-14).
 *   - `boom`    — throws (drives tool-handler failure finalization, SC-15).
 *   - `big`     — returns an oversized payload (drives output-bound rejection, SC-09).
 */

/** Public verification key type accepted by the runner (`jose` asymmetric key). */
type PublicKey = CryptoKey | KeyObject;

type RunnerServer = Awaited<ReturnType<typeof startToolRunner>>;

export interface FakeRunnerHandle {
  /** `http://127.0.0.1:${port}` — use as the agent's `toolRunnerUrl`. */
  url: string;
  port: number;
  server: RunnerServer;
  /** Live `counter` tool invocation count. */
  counter: { value: number };
  teardown(): Promise<void>;
}

export interface StartFakeRunnerOptions {
  publicKey: PublicKey;
  /** The workspace the runner's tokens must be scoped to (`claims.workspaceId`). */
  workspaceId: string;
  /**
   * Required `aud`. Defaults to the runner's own URL. Override when a proxy sits
   * in front of the runner so the token minted for the proxy URL still verifies
   * (SC-10 replay test).
   */
  expectedAudience?: string;
  /** Per-tool execution deadline enforced by the runner itself. */
  toolTimeoutMs?: number;
  /** Delay (ms) used by the `slow` tool. Default 3000. */
  slowToolDelayMs?: number;
  /** Byte size of the `big` tool's payload. Default just over the output bound. */
  bigToolBytes?: number;
  /** Idempotency replay window on the runner. */
  idempotencyTtlMs?: number;
}

/**
 * Reserve a concrete free TCP port by briefly binding `:0`, reading the assigned
 * port, then releasing it. The runner is then started on that exact port so its
 * `expectedAudience` (= the registered `toolRunnerUrl`) is known up front — the
 * runner cannot report its own port back (WS-22).
 */
export function reserveFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('Failed to reserve a free port')));
      }
    });
  });
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function startFakeRunner(opts: StartFakeRunnerOptions): Promise<FakeRunnerHandle> {
  const port = await reserveFreePort();
  const url = `http://127.0.0.1:${port}`;
  const counter = { value: 0 };
  const slowDelay = opts.slowToolDelayMs ?? 3_000;
  const bigBytes = opts.bigToolBytes ?? RUNNER_MAX_OUTPUT_BYTES + 1024;

  // Permissive object schema: the loop already validated arguments against the
  // agent's persisted JSON schema; the runner just needs to accept the object.
  const anyObject = z.object({}).passthrough();

  const defs: ToolDefinition[] = [
    tool({
      name: 'echo',
      description: 'Echo the input back to the caller',
      inputSchema: anyObject,
      execute: async (input: unknown) => ({ echoed: input }),
    }),
    tool({
      name: 'counter',
      description: 'Increment a shared counter and return its value',
      inputSchema: anyObject,
      execute: async () => {
        counter.value += 1;
        return { count: counter.value };
      },
    }),
    tool({
      name: 'slow',
      description: 'Delay beyond the caller deadline',
      inputSchema: anyObject,
      execute: async () => {
        await delay(slowDelay);
        return { done: true };
      },
    }),
    tool({
      name: 'boom',
      description: 'Throw an error',
      inputSchema: anyObject,
      execute: async () => {
        throw new Error('boom tool failed');
      },
    }),
    tool({
      name: 'big',
      description: 'Return an oversized payload',
      inputSchema: anyObject,
      execute: async () => ({ blob: 'x'.repeat(bigBytes) }),
    }),
  ];

  const registry = new Map<string, ToolDefinition>();
  for (const def of defs) registry.set(def.name, def);

  const runner = await startToolRunner({
    port,
    registry,
    auth: {
      publicKey: opts.publicKey,
      expectedAudience: opts.expectedAudience ?? url,
      expectedWorkspaceId: opts.workspaceId,
    },
    ...(opts.toolTimeoutMs !== undefined ? { toolTimeoutMs: opts.toolTimeoutMs } : {}),
    ...(opts.idempotencyTtlMs !== undefined ? { idempotencyTtlMs: opts.idempotencyTtlMs } : {}),
  });

  return {
    url,
    port,
    server: runner,
    counter,
    async teardown() {
      await runner.close();
    },
  };
}
