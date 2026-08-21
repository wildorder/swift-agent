import { tool } from '@swiftagent/sdk';
import type { ToolDefinition } from '@swiftagent/sdk';

/**
 * A demo-owned tool time budget. This is deliberately NOT a protocol concept:
 * no deadline or timing field exists on `ChatEvent`, `ToolContext`, or the
 * runner protocol, and none may be added. The budget lives entirely inside this
 * demo's own tool wrapper and is served to the frontend via `/api/demo-config`.
 */
export interface DemoBudget {
  toolName: string;
  budgetMs: number;
}

const budgets = new Map<string, number>();

/**
 * Wrap a tool so its `execute` races a demo-owned timer. On breach the wrapper
 * rejects, so the runtime reports the call as `tool_call_completed` with
 * `status: 'failed'` — the public event union's real failure path. The wrapper
 * also registers `{ toolName, budgetMs }` in the in-process demo-config map.
 */
export function withBudget<TInput, TResult>(
  def: ToolDefinition<TInput, TResult>,
  budgetMs: number,
): ToolDefinition<TInput, TResult> {
  budgets.set(def.name, budgetMs);
  return tool<TInput, TResult>({
    ...def,
    execute: async (input, ctx) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const breach = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `Tool "${def.name}" exceeded its demo-owned budget of ${budgetMs}ms.`,
            ),
          );
        }, budgetMs);
      });
      try {
        return await Promise.race([def.execute(input, ctx), breach]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  });
}

/** The demo-owned budgets registered so far, for `/api/demo-config`. */
export function listDemoBudgets(): DemoBudget[] {
  return [...budgets.entries()].map(([toolName, budgetMs]) => ({
    toolName,
    budgetMs,
  }));
}
