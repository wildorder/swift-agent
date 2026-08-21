import type { ModelProvider } from '../provider.js';
import type { ModelMessage, ModelRequest, ModelStreamChunk, ProviderConfig } from '../types.js';
import { ModelError } from '../types.js';

// ---------------------------------------------------------------------------
// Echo provider — a zero-cost, deterministic ModelProvider.
//
// It makes NO external API call: it streams the last user message back as
// whitespace-delimited `token` chunks followed by exactly one `finish` chunk,
// honoring the ModelProvider ordering contract. Its purpose is the deployed
// realtime smoke test (WS-35): a `smoke-echo` agent backed by this provider
// deterministically emits `token` frames so the smoke test can assert the full
// message_started → token → message_completed sequence without model cost or
// nondeterminism.
//
// It is only reachable by an agent whose modelConfig.model resolves to the
// `echo` provider (e.g. `echo/echo`); no real agent routes here.
// ---------------------------------------------------------------------------

/** Find the most recent user message, whose content the echo streams back. */
function lastUserContent(messages: readonly ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content;
  }
  return 'echo';
}

/**
 * Split into stream tokens while preserving the original text on rejoin.
 * Whitespace runs are kept as their own chunks so `token`s concatenate back to
 * the source string — the loop accumulates `assistantText` by concatenation.
 */
function tokenize(text: string): string[] {
  const tokens = text.split(/(\s+)/).filter((t) => t.length > 0);
  // Guarantee at least one token so REQUIRE_TOKENS smoke assertions always pass,
  // even for an empty/whitespace-only prompt.
  return tokens.length > 0 ? tokens : ['echo'];
}

/**
 * Factory for the echo provider. The `ProviderConfig` is accepted to satisfy
 * the `ProviderFactory` signature but is intentionally unused — there is no
 * API key or endpoint. Register it with an explicit throwaway config so the
 * registry never tries to resolve a real key from the environment.
 */
export function createEchoProvider(_config: ProviderConfig): ModelProvider {
  return {
    async *generate(request: ModelRequest): AsyncGenerator<ModelStreamChunk, void, undefined> {
      if (request.signal?.aborted) {
        throw new ModelError('Echo generation aborted before start', 'echo');
      }

      const tokens = tokenize(lastUserContent(request.messages));

      for (const text of tokens) {
        if (request.signal?.aborted) {
          throw new ModelError('Echo generation aborted', 'echo');
        }
        yield { type: 'token', text };
      }

      const outputTokens = tokens.length;
      yield {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens, totalTokens: outputTokens },
      };
    },
  };
}
