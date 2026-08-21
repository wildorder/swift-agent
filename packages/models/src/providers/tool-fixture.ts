import type { ModelProvider } from '../provider.js';
import type { ModelRequest, ModelStreamChunk, ProviderConfig } from '../types.js';
import { ModelError } from '../types.js';

// ---------------------------------------------------------------------------
// Tool-fixture provider — a zero-cost, deterministic tool-CALLING ModelProvider.
//
// Sibling of the echo provider (WS-35), added by WS-43 for the local compose
// stack: the echo provider never emits a `tool_call` chunk, so it cannot prove
// a real tool round trip. This fixture runs a FIXED two-turn script keyed on
// how many `tool`-role messages are in the request (the same turn-indexing idea
// as test/support/fake-provider.ts, made production-shaped — no test handle,
// no configurability):
//
//   turn 0 (no tool-role message): one token, exactly one `tool_call`
//     (local_echo / fixture_call_1 / fixed arguments), then one `finish` with
//     finishReason 'tool_calls' — the reason real providers surface for a tool
//     round (the runtime loop keys the next round on the tool_call chunks
//     themselves, not on finishReason; see packages/runtime/src/loop.ts).
//   turn 1+ (>=1 tool-role message): a short token sequence referencing the
//     tool result, then one `finish {finishReason: 'stop'}`.
//
// It makes NO external call, costs nothing, and is fully deterministic, so the
// local smoke check can assert exactly one tool_call_started/tool_call_completed
// pair per turn. It is registered ONLY when the LOCAL_FIXTURE_PROVIDER boot
// flag is set (apps/server/src/container.ts) — never in cloud deployments.
// ---------------------------------------------------------------------------

/** Fixed tool call emitted on turn 0 — matches the bootstrap-seeded local_echo tool. */
const FIXTURE_TOOL_NAME = 'local_echo';
const FIXTURE_CALL_ID = 'fixture_call_1';
const FIXTURE_ARGUMENTS = Object.freeze({
  message: 'hello from the local fixture',
  shout: false,
});

/** Tokens streamed on the final turn (after the tool result). */
const FINAL_TURN_TOKENS = ['The ', 'local_echo ', 'tool ', 'responded ', 'successfully.'] as const;

function throwIfAborted(request: ModelRequest, phase: string): void {
  if (request.signal?.aborted) {
    throw new ModelError(`Tool-fixture generation aborted ${phase}`, 'fixture');
  }
}

/**
 * Factory for the tool-fixture provider. The `ProviderConfig` is accepted to
 * satisfy the `ProviderFactory` signature but is intentionally unused — there
 * is no API key or endpoint. Register it with an explicit throwaway config so
 * the registry never tries to resolve a real key from the environment.
 */
export function createToolFixtureProvider(_config: ProviderConfig): ModelProvider {
  return {
    async *generate(request: ModelRequest): AsyncGenerator<ModelStreamChunk, void, undefined> {
      throwIfAborted(request, 'before start');

      // Turn index = number of tool-role messages already in the context
      // (mirrors test/support/fake-provider.ts `byTurn`).
      const turn = request.messages.filter((m) => m.role === 'tool').length;

      if (turn === 0) {
        yield { type: 'token', text: 'Calling local_echo… ' };
        throwIfAborted(request, 'mid-stream');
        yield {
          type: 'tool_call',
          toolName: FIXTURE_TOOL_NAME,
          callId: FIXTURE_CALL_ID,
          arguments: { ...FIXTURE_ARGUMENTS },
        };
        yield {
          type: 'finish',
          finishReason: 'tool_calls',
          usage: { inputTokens: 0, outputTokens: 1, totalTokens: 1 },
        };
        return;
      }

      for (const text of FINAL_TURN_TOKENS) {
        throwIfAborted(request, 'mid-stream');
        yield { type: 'token', text };
      }
      yield {
        type: 'finish',
        finishReason: 'stop',
        usage: {
          inputTokens: 0,
          outputTokens: FINAL_TURN_TOKENS.length,
          totalTokens: FINAL_TURN_TOKENS.length,
        },
      };
    },
  };
}
