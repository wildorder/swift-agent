import type { AgentRecord } from '@swiftagent/shared';
import type { ToolExecutor } from './tool-executor.js';
import { LocalToolExecutor } from './tool-executor-local.js';
import { RemoteToolExecutor } from './tool-executor-remote.js';

export function createToolExecutor(
  agent: AgentRecord,
  opts: { authToken: string },
): ToolExecutor {
  if (agent.toolRunnerUrl) {
    return new RemoteToolExecutor({
      toolRunnerUrl: agent.toolRunnerUrl,
      authToken: opts.authToken,
    });
  }
  return new LocalToolExecutor();
}
