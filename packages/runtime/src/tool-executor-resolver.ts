import type { AgentRecord } from '@swiftagent/shared';
import { SwiftAgentError, SwiftAgentErrorCode } from '@swiftagent/shared';
import type { ToolExecutor } from './tool-executor.js';
import { LocalToolExecutor } from './tool-executor-local.js';
import { createToolExecutor } from './tool-executor-factory.js';

/**
 * Maps an {@link AgentRecord} to the {@link ToolExecutor} that must service
 * that agent's tool calls. Protocol-neutral: a future `McpToolExecutor` (or
 * any other transport) can be selected here without touching the loop,
 * sessions, or persistence (WS-21, SC-07).
 */
export interface ToolExecutorResolver {
  resolve(agent: AgentRecord): Promise<ToolExecutor> | ToolExecutor;
}

export interface CreateToolExecutorResolverOptions {
  /**
   * Produces the bearer token a {@link RemoteToolExecutor} sends to the agent's
   * tool runner. TODO(WS-22): replaced by short-lived, per-call scoped
   * credentials — this callback and the resolver's contract change then.
   */
  resolveAuthToken: (agent: AgentRecord) => Promise<string> | string;
  /**
   * Registers explicit platform-internal/test tool handlers on a fresh
   * {@link LocalToolExecutor}. MUST return the number of handlers registered —
   * `LocalToolExecutor`'s handler map is private, so the count is the only
   * reliable signal that local execution was explicitly configured. Local
   * execution is opt-in, never the silent default.
   */
  registerLocalTools?: (agent: AgentRecord, local: LocalToolExecutor) => number;
}

/**
 * Default {@link ToolExecutorResolver}. Resolution rules:
 *
 * 1. `agent.toolRunnerUrl` set → {@link RemoteToolExecutor} bound to that URL,
 *    authenticated with `resolveAuthToken(agent)`.
 * 2. No runner URL but `registerLocalTools` registers ≥1 handler → the
 *    configured {@link LocalToolExecutor}.
 * 3. No runner URL, no local registration, but the agent declares tools →
 *    fail fast with `SwiftAgentError(VALIDATION)` before any invocation.
 * 4. No runner URL and no tools → a no-op {@link LocalToolExecutor} (the
 *    execution path is never reached for a tool-less agent).
 *
 * Executors are memoized keyed by `${agentId}:${toolRunnerUrl ?? 'local'}`, so
 * re-registering an agent under a new `toolRunnerUrl` yields a *different*
 * executor and one agent's runner URL can never leak into another's.
 */
export function createToolExecutorResolver(
  opts: CreateToolExecutorResolverOptions,
): ToolExecutorResolver {
  const cache = new Map<string, ToolExecutor>();

  return {
    async resolve(agent: AgentRecord): Promise<ToolExecutor> {
      const cacheKey = `${agent.agentId}:${agent.toolRunnerUrl ?? 'local'}`;
      const cached = cache.get(cacheKey);
      if (cached) return cached;

      // Rule 1: remote runner — one executor bound to exactly one URL. The
      // factory returns a RemoteToolExecutor because toolRunnerUrl is set.
      if (agent.toolRunnerUrl) {
        // TODO(WS-22): interim server-configured token — superseded by
        // short-lived, per-call scoped credentials.
        const authToken = await opts.resolveAuthToken(agent);
        const executor = createToolExecutor(agent, { authToken });
        cache.set(cacheKey, executor);
        return executor;
      }

      // Rule 2: explicit local registration (opt-in, never silent).
      if (opts.registerLocalTools) {
        const local = new LocalToolExecutor();
        const registered = opts.registerLocalTools(agent, local);
        if (registered > 0) {
          cache.set(cacheKey, local);
          return local;
        }
      }

      // Rule 3: tool-bearing agent with no execution configuration → fail fast.
      if (agent.tools.length > 0) {
        throw new SwiftAgentError(
          SwiftAgentErrorCode.VALIDATION,
          `No execution configuration for agent ${agent.agentId}`,
        );
      }

      // Rule 4: no tools — a no-op executor that is never actually invoked.
      const noop = new LocalToolExecutor();
      cache.set(cacheKey, noop);
      return noop;
    },
  };
}
