import Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam,
  ContentBlockParam,
  RawMessageStreamEvent,
  Tool,
} from '@anthropic-ai/sdk/resources/messages';

import type { ModelProvider } from '../provider.js';
import type {
  ModelMessage,
  ModelRequest,
  ModelStreamChunk,
  ProviderConfig,
  ToolSchema,
} from '../types.js';
import { ModelError, normalizeError } from '../types.js';
import { mergeSignals } from '../signals.js';

// ---------------------------------------------------------------------------
// Message mapping helpers
// ---------------------------------------------------------------------------

/**
 * Extract system messages and join their content into a single string.
 * Returns `undefined` when there are no system messages (Anthropic omits
 * the param rather than sending an empty string).
 */
function extractSystemPrompt(messages: readonly ModelMessage[]): string | undefined {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      parts.push(msg.content);
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

/**
 * Map a single ModelMessage to the Anthropic MessageParam format.
 * System messages must already have been filtered out.
 */
function mapMessage(msg: ModelMessage): MessageParam {
  // Tool-result messages → wrap inside a user turn with tool_result content block
  if (msg.role === 'tool') {
    const content: ContentBlockParam[] = [
      {
        type: 'tool_result' as const,
        tool_use_id: msg.toolCallId ?? '',
        content: msg.content,
      },
    ];
    return { role: 'user', content };
  }

  // Assistant messages that include tool calls → mixed content blocks
  if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
    const content: ContentBlockParam[] = [];

    // Leading text block (may be empty, but Anthropic allows it)
    if (msg.content) {
      content.push({ type: 'text' as const, text: msg.content });
    }

    for (const tc of msg.toolCalls) {
      content.push({
        type: 'tool_use' as const,
        id: tc.callId,
        name: tc.toolName,
        input: tc.arguments as Record<string, unknown>,
      });
    }

    return { role: 'assistant', content };
  }

  // Plain user / assistant text messages
  return {
    role: msg.role as 'user' | 'assistant',
    content: msg.content,
  };
}

/**
 * Map our unified ToolSchema to Anthropic's Tool format.
 */
function mapTool(tool: ToolSchema): Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object' as const,
      ...tool.parameters,
    },
  };
}

// ---------------------------------------------------------------------------
// Tool-call buffering state (per content block index)
// ---------------------------------------------------------------------------

interface ToolCallBuffer {
  callId: string;
  toolName: string;
  jsonParts: string[];
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TOKENS = 4096;

export function createAnthropicProvider(config: ProviderConfig): ModelProvider {
  const client = new Anthropic({
    apiKey: config.apiKey,
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
  });

  async function* generate(
    request: ModelRequest,
  ): AsyncGenerator<ModelStreamChunk, void, undefined> {
    const systemPrompt = extractSystemPrompt(request.messages);

    const nonSystemMessages = request.messages.filter((m) => m.role !== 'system');
    const messages: MessageParam[] = nonSystemMessages.map(mapMessage);

    const tools: Tool[] | undefined =
      request.tools && request.tools.length > 0
        ? request.tools.map(mapTool)
        : undefined;

    const signal = mergeSignals(request.signal, config.timeout);

    // Track input tokens from message_start
    let inputTokens: number | undefined;

    // Buffer for in-progress tool_use blocks, keyed by content block index
    const toolBuffers = new Map<number, ToolCallBuffer>();

    let stream: AsyncIterable<RawMessageStreamEvent>;

    try {
      // Use the low-level create() with stream: true so we get
      // RawMessageStreamEvent items we can iterate over directly.
      stream = await client.messages.create(
        {
          model: request.model,
          messages,
          max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(systemPrompt !== undefined ? { system: systemPrompt } : {}),
          ...(tools !== undefined ? { tools } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          stream: true as const,
        },
        { signal },
      );
    } catch (e: unknown) {
      throw wrapError(e);
    }

    try {
      for await (const event of stream) {
        switch (event.type) {
          // Capture input token usage from the opening message
          case 'message_start': {
            inputTokens = event.message.usage?.input_tokens;
            break;
          }

          case 'content_block_start': {
            if (event.content_block.type === 'tool_use') {
              toolBuffers.set(event.index, {
                callId: event.content_block.id,
                toolName: event.content_block.name,
                jsonParts: [],
              });
            }
            break;
          }

          case 'content_block_delta': {
            if (event.delta.type === 'text_delta') {
              yield { type: 'token', text: event.delta.text };
            } else if (event.delta.type === 'input_json_delta') {
              const buf = toolBuffers.get(event.index);
              if (buf) {
                buf.jsonParts.push(event.delta.partial_json);
              }
            }
            break;
          }

          case 'content_block_stop': {
            const buf = toolBuffers.get(event.index);
            if (buf) {
              toolBuffers.delete(event.index);
              const raw = buf.jsonParts.join('');
              let parsed: unknown;
              try {
                parsed = raw.length > 0 ? JSON.parse(raw) : {};
              } catch {
                parsed = raw;
              }
              yield {
                type: 'tool_call',
                toolName: buf.toolName,
                callId: buf.callId,
                arguments: parsed,
              };
            }
            break;
          }

          case 'message_delta': {
            const stopReason = event.delta.stop_reason ?? 'end_turn';
            const outputTokens = event.usage?.output_tokens;
            yield {
              type: 'finish',
              finishReason: stopReason,
              usage: {
                inputTokens,
                outputTokens,
                totalTokens:
                  inputTokens !== undefined && outputTokens !== undefined
                    ? inputTokens + outputTokens
                    : undefined,
              },
            };
            break;
          }

          // message_stop — nothing to emit
          default:
            break;
        }
      }
    } catch (e: unknown) {
      throw wrapError(e);
    }
  }

  return { generate };
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

/**
 * Wrap errors via normalizeError, with special handling for Anthropic 529
 * (overloaded) which normalizeError does not mark as retryable.
 */
function wrapError(e: unknown): ModelError {
  const err = normalizeError(e, 'anthropic');

  // Anthropic 529 = overloaded → retryable, but normalizeError only knows
  // about the standard retryable set (429, 500, 502, 503, 504).
  if (err.statusCode === 529 && !err.retryable) {
    return new ModelError(err.message, 'anthropic', {
      statusCode: 529,
      retryable: true,
      cause: e,
    });
  }

  return err;
}
