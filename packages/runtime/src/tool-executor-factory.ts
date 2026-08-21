import type { AgentRecord } from '@swiftagent/shared';
import type { ToolExecutor, ToolCall, ToolCallContext } from './tool-executor.js';
import { LocalToolExecutor } from './tool-executor-local.js';
import { RemoteToolExecutor } from './tool-executor-remote.js';
import type { OutboundUrlPolicy } from './ssrf.js';

export interface CreateToolExecutorOptions {
  /** Outbound SSRF policy for the agent's runner URL. */
  policy: OutboundUrlPolicy;
  /** Mints the per-call scoped bearer token for the resolved agent (WS-22, SC-08). */
  mintToken: (call: ToolCall, ctx: ToolCallContext) => Promise<string>;
}

export function createToolExecutor(
  agent: AgentRecord,
  opts: CreateToolExecutorOptions,
): ToolExecutor {
  if (agent.toolRunnerUrl) {
    return new RemoteToolExecutor({
      toolRunnerUrl: agent.toolRunnerUrl,
      agentId: agent.agentId,
      policy: opts.policy,
      mintToken: opts.mintToken,
    });
  }
  return new LocalToolExecutor();
}
