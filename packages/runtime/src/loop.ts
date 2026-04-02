import {
  generateMessageId,
  type ChatEvent,
} from '@swiftagent/shared';
// ModelStreamChunk used implicitly via provider.generate() return type
import { ContextBuilder, type ToolMessageContent } from './context-builder.js';
import { createMemoryStrategy } from './memory/strategy.js';
import type { ToolCall } from './tool-executor.js';
import type { AgentEngineDeps, RunContext, AgentEngineOptions } from './types.js';
import { DEFAULT_MAX_TOOL_ITERATIONS, DEFAULT_LAST_N } from './types.js';

export async function* runAgentLoop(
  ctx: RunContext,
  deps: AgentEngineDeps,
  userContent: string,
  options?: AgentEngineOptions,
): AsyncGenerator<ChatEvent> {
  const maxToolIterations = options?.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
  const memoryStrategyName = options?.memoryStrategy ?? ctx.agentConfig.memoryConfig?.strategy ?? 'last_n';
  const lastN = options?.lastN ?? ctx.agentConfig.memoryConfig?.maxMessages ?? DEFAULT_LAST_N;

  const memoryStrategy = createMemoryStrategy(memoryStrategyName, { lastN });
  const contextBuilder = new ContextBuilder(ctx.agentConfig, memoryStrategy);
  const messageId = generateMessageId();

  try {
    // Step 1: Persist user message
    await deps.db.messages.create({
      messageId,
      sessionId: ctx.sessionId,
      runId: ctx.runId,
      role: 'user',
      content: userContent,
    });

    // Step 2: Yield message_started
    yield {
      type: 'message_started',
      messageId,
      runId: ctx.runId,
      sessionId: ctx.sessionId,
    };

    // Step 3: Create Run record
    await deps.db.runs.create({
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      model: ctx.agentConfig.modelConfig.model,
    });

    // Step 4: Iteration loop
    let assistantText = '';
    let lastUsage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {};
    const assistantMessageId = generateMessageId();
    let hitMaxIterations = false;

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
        tools: undefined, // Tool schemas would come from agent config — passed externally
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
        // Persist assistant message with tool calls before executing tools
        await deps.db.messages.create({
          messageId: generateMessageId(),
          sessionId: ctx.sessionId,
          runId: ctx.runId,
          role: 'assistant',
          content: JSON.stringify({
            text: assistantText,
            toolCalls: toolCallChunks.map((tc) => ({
              callId: tc.callId,
              toolName: tc.toolName,
              arguments: tc.arguments,
            })),
          }),
        });
        assistantText = '';

        for (const tc of toolCallChunks) {
          // Yield tool_call_started
          yield {
            type: 'tool_call_started',
            callId: tc.callId,
            runId: ctx.runId,
            sessionId: ctx.sessionId,
            toolName: tc.toolName,
          };

          // Create ToolCall record
          await deps.db.toolCalls.create({
            callId: tc.callId,
            runId: ctx.runId,
            toolName: tc.toolName,
            input: tc.arguments,
          });

          // Execute tool
          const call: ToolCall = {
            toolName: tc.toolName,
            callId: tc.callId,
            arguments: tc.arguments,
          };

          const result = await deps.toolExecutor.execute(
            call,
            { sessionId: ctx.sessionId, runId: ctx.runId },
            ctx.abortSignal,
          );

          // Update ToolCall record
          if (result.ok) {
            await deps.db.toolCalls.updateResult(tc.callId, result.output, 'completed');
          } else {
            await deps.db.toolCalls.updateResult(tc.callId, result.error, 'failed');
          }

          // Yield tool_call_completed
          yield {
            type: 'tool_call_completed',
            callId: tc.callId,
            runId: ctx.runId,
            sessionId: ctx.sessionId,
            toolName: tc.toolName,
            status: result.ok ? 'completed' : 'failed',
          };

          // Persist tool result as a MessageRecord
          const toolContent: ToolMessageContent = {
            toolCallId: tc.callId,
            result: result.ok ? JSON.stringify(result.output) : result.error,
          };
          await deps.db.messages.create({
            messageId: generateMessageId(),
            sessionId: ctx.sessionId,
            runId: ctx.runId,
            role: 'tool',
            content: JSON.stringify(toolContent),
          });

          ctx.iterationCount++;
        }

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
