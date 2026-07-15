import {
  generateMessageId,
  generateToolCallId,
  type ChatEvent,
} from '@swiftagent/shared';
// ModelStreamChunk used implicitly via provider.generate() return type
import { ContextBuilder, type ToolMessageContent } from './context-builder.js';
import { createMemoryStrategy } from './memory/strategy.js';
import { toModelToolSchemas, buildToolIndex } from './tool-mapping.js';
import { validateToolCall } from './tool-validation.js';
import type { ToolCall } from './tool-executor.js';
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
      // Check abort
      if (ctx.abortSignal.aborted) {
        throw new Error('Run was cancelled');
      }

      // Load message history
      const history = await deps.db.messages.listBySession(ctx.sessionId);

      // Build context
      const context = contextBuilder.build(history);

      // Resolve model provider
      const { provider, modelId } = deps.modelRegistry.resolveForModel(
        ctx.agentConfig.modelConfig.model,
      );

      // Call provider.generate
      const stream = provider.generate({
        model: modelId,
        messages: context,
        // Pass registered tools on every model turn for tool-bearing agents;
        // tool-less agents keep sending `undefined` (SC-03).
        tools: toolSchemas.length > 0 ? toolSchemas : undefined,
        temperature: ctx.agentConfig.modelConfig.temperature,
        maxTokens: ctx.agentConfig.modelConfig.maxTokens,
        signal: ctx.abortSignal,
      });

      // Process stream chunks
      let hadToolCalls = false;
      const toolCallChunks: Array<{ type: 'tool_call'; toolName: string; callId: string; arguments?: unknown }> = [];

      for await (const chunk of stream) {
        if (ctx.abortSignal.aborted) {
          throw new Error('Run was cancelled');
        }

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
          } else {
            const call: ToolCall = {
              toolName: p.toolName,
              callId: p.swiftCallId,
              arguments: p.arguments,
            };

            // Use the run-scoped executor from ctx (resolved per-agent in the
            // engine) — never a deps-wide one — so concurrent agents cannot
            // cross-route tool calls to each other's runners (WS-21, SC-07).
            const result = await ctx.toolExecutor.execute(
              call,
              { sessionId: ctx.sessionId, runId: ctx.runId },
              ctx.abortSignal,
            );

            if (result.ok) {
              status = 'completed';
              resultText = JSON.stringify(result.output);
              await deps.db.toolCalls.updateResult(p.swiftCallId, result.output, 'completed');
            } else {
              status = 'failed';
              resultText = result.error;
              await deps.db.toolCalls.updateResult(p.swiftCallId, result.error, 'failed');
            }
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
    // Error handling — mark run as failed
    try {
      await deps.db.runs.fail(ctx.runId);
    } catch {
      // Swallow — we're already in error handling
    }

    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof Error && error.message === 'Run was cancelled'
      ? 'CANCELLED'
      : 'INTERNAL';

    yield {
      type: 'run_failed',
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      code,
      message,
      cause: error,
    };
  }
}
