import type {
  ModelProvider,
  ModelRequest,
  ModelStreamChunk,
  TokenUsage,
} from '@swiftagent/models';

/**
 * Deterministic, scripted {@link ModelProvider} for the runtime integration
 * suites (WS-25). No real model API is ever called: each `generate` computes its
 * chunks from a caller-supplied responder, honouring `request.signal` (so
 * cancellation and per-model deadlines abort a slow turn) and recording every
 * `request` it received (so tests can assert the tools the loop forwarded — SC-03).
 *
 * Chunk order matches the provider contract: `token*` → `tool_call*` → exactly
 * one `finish`.
 */

/** A single scripted model turn. */
export interface ScriptedTurn {
  /** Text tokens emitted in order before any tool call. */
  tokens?: string[];
  /** Fully-assembled tool calls to emit this turn. */
  toolCalls?: Array<{ toolName: string; callId?: string; arguments: unknown }>;
  /** Finish reason for the terminal `finish` chunk. Defaults to `stop`. */
  finishReason?: string;
  /** Usage for the terminal `finish` chunk. */
  usage?: TokenUsage;
  /**
   * Delay (ms) applied BEFORE emitting anything, awaited against
   * `request.signal`. Used to trigger model/total deadlines and to keep a run
   * in-flight for cancellation / disconnect tests.
   */
  delayMs?: number;
  /** When set, throw instead of yielding — simulates a provider error (SC-15). */
  error?: Error | string;
}

/** Computes the turn to emit for a given request. */
export type FakeResponder = (request: ModelRequest) => ScriptedTurn | Promise<ScriptedTurn>;

export interface FakeProviderHandle {
  /** The provider instance to register in a {@link ProviderRegistry}. */
  readonly provider: ModelProvider;
  /** Swap the active responder (typically per test, before starting a run). */
  setResponder(fn: FakeResponder): void;
  /** Every request observed, in order — for SC-03 tool-forwarding assertions. */
  readonly requests: ModelRequest[];
}

const DEFAULT_USAGE: TokenUsage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('Aborted', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

/** A delay that rejects promptly when the request signal aborts. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      reject(abortError(signal));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Create a fake provider whose behaviour is driven by a swappable responder.
 * The responder is a pure function of the request, so scripts that branch on
 * `request.model` or the conversation state (e.g. {@link byTurn}) remain
 * deterministic even under concurrent runs sharing one provider instance.
 */
export function createFakeProvider(initial?: FakeResponder): FakeProviderHandle {
  let responder: FakeResponder = initial ?? (() => ({ tokens: ['ok'] }));
  const requests: ModelRequest[] = [];

  const provider: ModelProvider = {
    async *generate(request: ModelRequest): AsyncGenerator<ModelStreamChunk, void, undefined> {
      requests.push(request);
      const turn = await responder(request);

      if (turn.delayMs && turn.delayMs > 0) {
        await abortableDelay(turn.delayMs, request.signal);
      }
      throwIfAborted(request.signal);

      if (turn.error) {
        throw typeof turn.error === 'string' ? new Error(turn.error) : turn.error;
      }

      for (const text of turn.tokens ?? []) {
        throwIfAborted(request.signal);
        yield { type: 'token', text };
      }

      let seq = 0;
      for (const tc of turn.toolCalls ?? []) {
        throwIfAborted(request.signal);
        yield {
          type: 'tool_call',
          toolName: tc.toolName,
          callId: tc.callId ?? `prov_call_${seq++}`,
          arguments: tc.arguments,
        };
      }

      yield {
        type: 'finish',
        finishReason: turn.finishReason ?? 'stop',
        usage: turn.usage ?? DEFAULT_USAGE,
      };
    },
  };

  return {
    provider,
    setResponder(fn: FakeResponder): void {
      responder = fn;
    },
    requests,
  };
}

// ── Script builders ──────────────────────────────────────────────────────

/** A pure-text turn. */
export function textTurn(text: string, usage?: TokenUsage): ScriptedTurn {
  return { tokens: [text], ...(usage ? { usage } : {}) };
}

/** A single tool-call turn. */
export function toolTurn(toolName: string, args: unknown): ScriptedTurn {
  return { toolCalls: [{ toolName, arguments: args }] };
}

/**
 * A responder that walks a fixed script of turns, indexed by how many tool
 * results are already in the conversation. Turn 0 runs before any tool has
 * executed; each completed tool round appends a `tool` role message, advancing
 * the index. The final turn is repeated if the model is called again.
 */
export function byTurn(...turns: ScriptedTurn[]): FakeResponder {
  return (request: ModelRequest): ScriptedTurn => {
    const idx = request.messages.filter((m) => m.role === 'tool').length;
    return turns[Math.min(idx, turns.length - 1)] ?? { finishReason: 'stop' };
  };
}
