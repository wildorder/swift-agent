import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/index';

import type { ModelProvider } from '../provider.js';
import { mergeSignals } from '../signals.js';
import type {
  ModelMessage,
  ModelRequest,
  ModelStreamChunk,
  ProviderConfig,
  ToolSchema,
} from '../types.js';
import { normalizeError } from '../types.js';

// ---------------------------------------------------------------------------
// Message mapping
// ---------------------------------------------------------------------------

function toOpenAIMessages(messages: ModelMessage[]): ChatCompletionMessageParam[] {
  return messages.map((msg): ChatCompletionMessageParam => {
    switch (msg.role) {
      case 'system':
        return { role: 'system', content: msg.content };

      case 'user':
        return { role: 'user', content: msg.content };

      case 'assistant': {
        const base: ChatCompletionMessageParam & { role: 'assistant' } = {
          role: 'assistant',
          content: msg.content || null,
        };
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          base.tool_calls = msg.toolCalls.map((tc) => ({
            id: tc.callId,
            type: 'function' as const,
            function: {
              name: tc.toolName,
              arguments: typeof tc.arguments === 'string'
                ? tc.arguments
                : JSON.stringify(tc.arguments),
            },
          }));
        }
        return base;
      }

      case 'tool':
        return {
          role: 'tool',
          tool_call_id: msg.toolCallId ?? '',
          content: msg.content,
        };
    }
  });
}

// ---------------------------------------------------------------------------
// Tool mapping
// ---------------------------------------------------------------------------

function toOpenAITools(tools: ToolSchema[]): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

// ---------------------------------------------------------------------------
// Accumulator for streamed tool calls
// ---------------------------------------------------------------------------

interface PartialToolCall {
  id: string;
  name: string;
  arguments: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates an OpenAI-compatible `ModelProvider` backed by the official SDK (v4).
 */
export function createOpenAIProvider(config: ProviderConfig): ModelProvider {
  const client = new OpenAI({
    apiKey: config.apiKey,
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
  });

  const defaultModel = config.defaultModel;
  const timeoutMs = config.timeout;

  async function* generate(request: ModelRequest): AsyncGenerator<ModelStreamChunk, void, undefined> {
    const signal = mergeSignals(request.signal, timeoutMs);
    const model = request.model || defaultModel;
    if (!model) {
      throw normalizeError(
        new Error('No model specified and no defaultModel configured'),
        'openai',
      );
    }

    try {
      const stream = await client.chat.completions.create(
        {
          model,
          messages: toOpenAIMessages(request.messages),
          ...(request.tools && request.tools.length > 0
            ? { tools: toOpenAITools(request.tools) }
            : {}),
          stream: true,
          stream_options: { include_usage: true },
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
        },
        { signal },
      );

      // Accumulate tool calls by index across streamed deltas
      const toolCallAccum = new Map<number, PartialToolCall>();
      let finishReason = 'stop';
      let promptTokens: number | undefined;
      let completionTokens: number | undefined;
      let totalTokens: number | undefined;

      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];

        if (choice) {
          // --- Text deltas ---
          if (choice.delta?.content) {
            yield { type: 'token', text: choice.delta.content };
          }

          // --- Tool-call deltas ---
          if (choice.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              const idx = tc.index;
              let acc = toolCallAccum.get(idx);
              if (!acc) {
                acc = { id: '', name: '', arguments: '' };
                toolCallAccum.set(idx, acc);
              }
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name = tc.function.name;
              if (tc.function?.arguments) acc.arguments += tc.function.arguments;
            }
          }

          // --- Finish reason ---
          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
          }
        }

        // --- Usage (arrives on the final chunk, typically with no choices) ---
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens;
          completionTokens = chunk.usage.completion_tokens;
          totalTokens = chunk.usage.total_tokens;
        }
      }

      // Yield assembled tool calls after the stream is exhausted
      for (const [, tc] of [...toolCallAccum.entries()].sort((a, b) => a[0] - b[0])) {
        let parsedArgs: unknown;
        try {
          parsedArgs = JSON.parse(tc.arguments || '{}');
        } catch {
          parsedArgs = tc.arguments;
        }
        yield {
          type: 'tool_call',
          toolName: tc.name,
          callId: tc.id,
          arguments: parsedArgs,
        };
      }

      // Terminal finish chunk
      yield {
        type: 'finish',
        finishReason,
        usage: {
          inputTokens: promptTokens,
          outputTokens: completionTokens,
          totalTokens: totalTokens,
        },
      };
    } catch (error) {
      throw normalizeError(error, 'openai');
    }
  }

  return { generate };
}
