import {
  generateMessageId,
  generateToolCallId,
  SwiftAgentError,
  type ChatEvent,
} from '@swiftagent/shared';
// ModelStreamChunk used implicitly via provider.generate() return type
import { ContextBuilder, type ToolMessageContent } from './context-builder.js';
import { createMemoryStrategy } from './memory/strategy.js';
import { toModelToolSchemas, buildToolIndex } from './tool-mapping.js';
import { validateToolCall } from './tool-validation.js';
import { deriveCallDeadline, timeoutReason, RunTimeoutError } from './deadlines.js';
import type { ToolCall, ToolCallResult } from './tool-executor.js';
import type { AgentEngineDeps, RunContext, AgentEngineOptions } from './types.js';
import { DEFAULT_MAX_TOOL_ITERATIONS, DEFAULT_LAST_N } from './types.js';

/**
 * Signals that the run row and user message have already been persisted by an
 * upstream owner (the RunExecutionService). When present, the loop skips
 * creating the run + user message (avoiding the historical dual-path
 * duplication) and reuses `userMessageId` for the `message_started` event.
 */
export interface PreparedRunPersistence {
  userMessageId: string;
}

export async function* runAgentLoop(
  ctx: RunContext,
  deps: AgentEngineDeps,
  userContent: string,
  options?: AgentEngineOptions,
  prepared?: PreparedRunPersistence,
): AsyncGenerator<ChatEvent> {
  const maxToolIterations = options?.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
  const memoryStrategyName = options?.memoryStrategy ?? ctx.agentConfig.memoryConfig?.strategy ?? 'last_n';
  const lastN = options?.lastN ?? ctx.agentConfig.memoryConfig?.maxMessages ?? DEFAULT_LAST_N;

  const memoryStrategy = createMemoryStrategy(memoryStrategyName, { lastN });
  const contextBuilder = new ContextBuilder(ctx.agentConfig, memoryStrategy);
  // When the run was prepared upstream, reuse the persisted user-message id so
  // message_started correlates with the row the service already wrote.
  const messageId = prepared?.userMessageId ?? generateMessageId();

  // ── Lifecycle-hardening state (WS-24) ──────────────────────────────────
  // One trace per run, wired from `deps.tracer`. `startRunTrace` is a no-op when
  // no tracer is configured (unit tests), so spans are entirely optional.
  const trace = deps.tracer?.startRunTrace(ctx.runId);
  // Tool calls created but not yet finalized. Any left open on a premature exit
  // are closed `failed` in `finally` so no tool call dangles in `started` (SC-15).
  const openToolCalls = new Set<string>();
  // Set when a per-model/per-tool deadline fires: the run must time out even
  // though `ctx.abortSignal` (cancel/total) may not itself be aborted.
  let deadlineHit: RunTimeoutError | null = null;
  // Trace outcome, resolved as the loop exits.
  let traceStatus: 'ok' | 'error' = 'ok';
  let traceError: Error | undefined;

  const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));
  // Finalization must never throw — a failure here would mask the real cause.
  const safe = async (fn: () => Promise<unknown> | undefined): Promise<void> => {
    try {
      await fn();
    } catch {
      /* swallow — best-effort finalization */
    }
  };
  const throwIfAborted = (): void => {
    if (ctx.abortSignal.aborted) {
      // Propagate the abort reason so a total-run RunTimeoutError classifies as
      // a timeout; a bare user cancel classifies as a cancellation.
      throw ctx.abortSignal.reason ?? new Error('Run aborted');
    }
  };
  // Classify why the run is terminating from signal state + deadline flag.
  const classifyTerminal = (): 'timeout' | 'cancel' | 'failure' => {
    if (deadlineHit || timeoutReason(ctx.abortSignal)) return 'timeout';
    if (ctx.abortSignal.aborted) return 'cancel';
    return 'failure';
  };

  try {
    // Step 1: Persist user message + Run record — UNLESS an upstream owner (the
    // RunExecutionService) already created them. This is the single guard that
    // prevents the REST and gateway paths from double-persisting a logical run.
    if (!prepared) {
      await deps.db.messages.create({
        messageId,
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        role: 'user',
        content: userContent,
      });
    }

    // Step 2: Yield message_started
    yield {
      type: 'message_started',
      messageId,
      runId: ctx.runId,
      sessionId: ctx.sessionId,
    };

    // Step 3: Create Run record
    if (!prepared) {
      await deps.db.runs.create({
        runId: ctx.runId,
        sessionId: ctx.sessionId,
        model: ctx.agentConfig.modelConfig.model,
      });
    }

    // Step 4: Iteration loop
    let assistantText = '';
    let lastUsage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {};
    const assistantMessageId = generateMessageId();
    let hitMaxIterations = false;

    // Source persisted agent tools once per run: map to the provider-neutral
    // ToolSchema[] the model layer understands, and build an O(1) index for
    // allowlist + JSON-schema argument validation at tool-call time.
    const toolSchemas = toModelToolSchemas(ctx.agentConfig.tools);
    const toolIndex = buildToolIndex(ctx.agentConfig.tools);

    while (ctx.iterationCount < maxToolIterations) {
      // Check abort (cancel or total-run deadline) at the top of every round.
      throwIfAborted();

      // Load message history
      const history = await deps.db.messages.listBySession(ctx.sessionId);

      // Build context
      const context = contextBuilder.build(history);

      // Resolve model provider
      const { provider, modelId } = deps.modelRegistry.resolveForModel(
        ctx.agentConfig.modelConfig.model,
      );

      // Process stream chunks
      let hadToolCalls = false;
      const toolCallChunks: Array<{ type: 'tool_call'; toolName: string; callId: string; arguments?: unknown }> = [];

      // Model call under a per-model-call deadline + trace span. The deadline
      // signal merges `ctx.abortSignal` (cancel/total) with a fresh model timer;
      // a firing timer aborts the provider stream with a RunTimeoutError.
      const modelDeadline = deriveCallDeadline(ctx.abortSignal, 'model', options?.modelTimeoutMs);
      const modelSpan = trace?.startModelCall(modelId);
      try {
        const stream = provider.generate({
          model: modelId,
          messages: context,
          // Pass registered tools on every model turn for tool-bearing agents;
          // tool-less agents keep sending `undefined` (SC-03).
          tools: toolSchemas.length > 0 ? toolSchemas : undefined,
          temperature: ctx.agentConfig.modelConfig.temperature,
          maxTokens: ctx.agentConfig.modelConfig.maxTokens,
          signal: modelDeadline.signal,
        });

        for await (const chunk of stream) {
          throwIfAborted();

          switch (chunk.type) {
            case 'token':
              assistantText += chunk.text;
              yield {
                type: 'token',
                text: chunk.text,
                messageId: assistantMessageId,
                runId: ctx.runId,
                sessionId: ctx.sessionId,
              };
              break;

            case 'tool_call':
              hadToolCalls = true;
              toolCallChunks.push(chunk);
              break;

            case 'finish':
              lastUsage = chunk.usage;
              break;
          }
        }
        modelSpan?.end('ok');
      } catch (err) {
        modelSpan?.end('error', asError(err));
        // A per-model deadline (or the total deadline propagated through the
        // merged signal) promotes to a run timeout rather than a model failure.
        const fired = timeoutReason(modelDeadline.signal);
        if (fired) deadlineHit = fired;
        throw err;
      } finally {
        modelDeadline.dispose();
      }

      // Process tool calls after stream completes
      if (hadToolCalls) {
        // Assign a stable Swift Agent id (`tc_…`) to EVERY assembled call —
        // accepted or rejected — so both have an observable identity. The
        // provider-native id (`chunk.callId`) is retained separately as
        // `providerCallId` and never used as our own id (SC-05).
        const preparedCalls = toolCallChunks.map((tc) => ({
          swiftCallId: generateToolCallId(),
          providerCallId: tc.callId,
          toolName: tc.toolName,
          arguments: tc.arguments,
        }));

        // Persist assistant message with tool calls before executing tools.
        // Store all three identifiers so ContextBuilder can round-trip
        // provider-facing correlation on the next turn.
        await deps.db.messages.create({
          messageId: generateMessageId(),
          sessionId: ctx.sessionId,
          runId: ctx.runId,
          role: 'assistant',
          content: JSON.stringify({
            text: assistantText,
            toolCalls: preparedCalls.map((p) => ({
              swiftCallId: p.swiftCallId,
              providerCallId: p.providerCallId,
              toolName: p.toolName,
              arguments: p.arguments,
            })),
          }),
        });
        assistantText = '';

        for (const p of preparedCalls) {
          // Gate: emit tool_call_started only for a fully-assembled, actionable
          // call (validated OR recorded as rejected) — never per stream delta.
          yield {
            type: 'tool_call_started',
            callId: p.swiftCallId,
            runId: ctx.runId,
            sessionId: ctx.sessionId,
            toolName: p.toolName,
          };

          // Create the ToolCall record under our own `tc_` id.
          await deps.db.toolCalls.create({
            callId: p.swiftCallId,
            runId: ctx.runId,
            toolName: p.toolName,
            input: p.arguments,
          });
          openToolCalls.add(p.swiftCallId);

          // Enforce the registered-tool allowlist + persisted-schema argument
          // validation BEFORE any execution (SC-04).
          const validation = validateToolCall(toolIndex, p.toolName, p.arguments);

          let status: 'completed' | 'failed';
          let resultText: string;

          if (!validation.ok) {
            // Reject: record the failure and surface it to the model so it can
            // recover, but never invoke the executor.
            resultText = `Tool call rejected (${validation.code}): ${validation.message}`;
            status = 'failed';
            await deps.db.toolCalls.updateResult(p.swiftCallId, resultText, 'failed');
            openToolCalls.delete(p.swiftCallId);
          } else {
            const call: ToolCall = {
              toolName: p.toolName,
              callId: p.swiftCallId,
              arguments: p.arguments,
            };

            // Execute under a per-tool-call deadline + trace span. Use the
            // run-scoped executor from ctx (resolved per-agent in the engine) —
            // never a deps-wide one — so concurrent agents cannot cross-route
            // tool calls (WS-21, SC-07).
            const toolDeadline = deriveCallDeadline(ctx.abortSignal, 'tool', options?.toolTimeoutMs);
            const toolSpan = trace?.startToolCall(p.toolName, p.swiftCallId);
            let result: ToolCallResult;
            try {
              result = await ctx.toolExecutor.execute(
                call,
                { sessionId: ctx.sessionId, runId: ctx.runId },
                toolDeadline.signal,
              );
            } catch (err) {
              // An executor that throws on abort is normalized to a failure
              // result; the deadline check below promotes it to a run timeout.
              result = { ok: false, error: asError(err).message };
            } finally {
              toolDeadline.dispose();
            }

            // Did THIS tool's deadline fire? (A user cancel or total deadline
            // aborts without a tool-scope RunTimeoutError and is handled at the
            // loop top instead.)
            const toolFired = timeoutReason(toolDeadline.signal);

            if (result.ok) {
              status = 'completed';
              resultText = JSON.stringify(result.output);
              await deps.db.toolCalls.updateResult(p.swiftCallId, result.output, 'completed');
              toolSpan?.end('ok');
            } else {
              status = 'failed';
              resultText = result.error;
              await deps.db.toolCalls.updateResult(p.swiftCallId, result.error, 'failed');
              toolSpan?.end('error', new Error(result.error));
            }
            openToolCalls.delete(p.swiftCallId);

            // Definitive deadline policy: a tool that exceeds `toolTimeoutMs` is
            // finalized as a `failed` tool call (above) AND the whole run times
            // out — there is no silent continuation (SC-14).
            if (toolFired) deadlineHit = toolFired;
          }

          // Yield tool_call_completed using our `tc_` id.
          yield {
            type: 'tool_call_completed',
            callId: p.swiftCallId,
            runId: ctx.runId,
            sessionId: ctx.sessionId,
            toolName: p.toolName,
            status,
          };

          // Persist tool result as a MessageRecord, carrying the provider-native
          // id AND the tool name so the next turn correlates for any provider.
          const toolContent: ToolMessageContent = {
            swiftCallId: p.swiftCallId,
            providerCallId: p.providerCallId,
            toolName: p.toolName,
            result: resultText,
          };
          await deps.db.messages.create({
            messageId: generateMessageId(),
            sessionId: ctx.sessionId,
            runId: ctx.runId,
            role: 'tool',
            content: JSON.stringify(toolContent),
          });

          // Promote a tool deadline to a run timeout once its records are
          // consistent — break out to the terminal classification.
          if (deadlineHit) throw deadlineHit;
        }

        // Iteration accounting: count MODEL ROUNDS, not individual tool
        // executions. One outer-loop pass that produced tool calls == one
        // increment, regardless of how many tools ran in that turn.
        ctx.iterationCount++;

        // Continue outer loop — re-call model with updated context
        continue;
      }

      // No tool calls — we're done
      break;
    }

    // Step 6: Check if we hit max iterations
    if (ctx.iterationCount >= maxToolIterations) {
      hitMaxIterations = true;
    }

    if (hitMaxIterations) {
      // Persist whatever we have
      if (assistantText) {
        await deps.db.messages.create({
          messageId: assistantMessageId,
          sessionId: ctx.sessionId,
          runId: ctx.runId,
          role: 'assistant',
          content: assistantText,
        });
      }

      traceStatus = 'error';
      // Conditional terminal write — a no-op if the run is already terminal.
      await deps.db.runs.fail(ctx.runId);

      yield {
        type: 'run_failed',
        runId: ctx.runId,
        sessionId: ctx.sessionId,
        code: 'MAX_ITERATIONS',
        message: `Run exceeded maximum tool iterations (${maxToolIterations})`,
      };
      return;
    }

    // Step 5: Completion — persist assistant message
    if (assistantText) {
      await deps.db.messages.create({
        messageId: assistantMessageId,
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        role: 'assistant',
        content: assistantText,
      });
    }

    // Conditional terminal write (SC-13): a run cancelled/timed-out mid-flight
    // stays terminal — `complete` is a no-op unless the run is still `running`.
    await deps.db.runs.complete(ctx.runId, {
      inputTokens: lastUsage.inputTokens ?? 0,
      outputTokens: lastUsage.outputTokens ?? 0,
      totalTokens: lastUsage.totalTokens ?? 0,
    });

    yield {
      type: 'message_completed',
      messageId: assistantMessageId,
      runId: ctx.runId,
      sessionId: ctx.sessionId,
    };
  } catch (error) {
    traceStatus = 'error';
    traceError = asError(error);

    // Classify the terminal cause and persist the matching conditional
    // terminal transition. Because every terminal write is `WHERE
    // status='running'`, whichever cause fires first wins (SC-13/SC-14/SC-15).
    const cause = classifyTerminal();
    let code: string;
    let message: string;

    if (cause === 'timeout') {
      const fired = deadlineHit ?? timeoutReason(ctx.abortSignal);
      await safe(() => deps.db.runs.timeout(ctx.runId));
      code = 'TIMED_OUT';
      message = fired?.message ?? 'Run timed out';
    } else if (cause === 'cancel') {
      await safe(() => deps.db.runs.cancel(ctx.runId));
      code = 'CANCELLED';
      message = 'Run was cancelled';
    } else {
      await safe(() => deps.db.runs.fail(ctx.runId));
      code = error instanceof SwiftAgentError ? error.code : 'INTERNAL';
      message = asError(error).message;
    }

    // Terminal event. We reuse `run_failed` with a distinct `code`
    // (CANCELLED / TIMED_OUT / error code) so cancellation and timeout do not
    // require a breaking addition to the `ChatEvent` discriminated union.
    yield {
      type: 'run_failed',
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      code,
      message,
      cause: error,
    };
  } finally {
    // Finalize everything (SC-15): close any still-`started` tool calls and
    // persist the trace, on EVERY exit path. All writes are conditional /
    // best-effort so a mid-finalization failure cannot wedge the run.
    for (const callId of openToolCalls) {
      await safe(() => deps.db.toolCalls.fail(callId));
    }
    await safe(() => trace?.finish(traceStatus, traceError));
  }
}
