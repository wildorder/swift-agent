import { tool } from '@swiftagent/sdk';
import { z } from 'zod';

/**
 * How long the "service" hangs — far past any demo-owned budget, so the
 * `withBudget` wrapper always aborts it first and the run surfaces
 * `tool_call_completed` with `status: 'failed'` (Beat 2's failure path).
 */
export const UNRELIABLE_HANG_MS = 60_000;

/**
 * The deliberately failing tool. It simulates a dependency that hangs: its
 * execute sleeps far past the budget `withBudget` gives it, so the wrapper's
 * timer wins the race and the call fails. This is on purpose — the demo shows
 * the failure path instead of hiding it.
 */
export const unreliableServiceTool = tool({
  name: 'unreliable_service',
  description:
    'Check the status of a deliberately unreliable demo dependency. This call is expected to exceed its time budget and fail.',
  inputSchema: z.object({
    probe: z.string().max(100).optional(),
  }),
  execute: async () => {
    await new Promise((resolve) => setTimeout(resolve, UNRELIABLE_HANG_MS));
    return { status: 'unreachable — you should never see this result' };
  },
});
