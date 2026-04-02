import {
  GoogleGenerativeAI,
  type Content,
  type FunctionDeclarationSchema,
  type GenerateContentCandidate,
  type Part,
} from '@google/generative-ai';
import { nanoid } from 'nanoid';

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
// Finish-reason mapping
// ---------------------------------------------------------------------------

const FINISH_REASON_MAP: Record<string, string> = {
  STOP: 'stop',
  MAX_TOKENS: 'max_tokens',
  SAFETY: 'safety',
  RECITATION: 'recitation',
  OTHER: 'other',
};

function mapFinishReason(raw: string | undefined): string {
  if (!raw) return 'stop';
  return FINISH_REASON_MAP[raw] ?? raw.toLowerCase();
}

// ---------------------------------------------------------------------------
// Message mapping
// ---------------------------------------------------------------------------

interface MappedMessages {
  systemInstruction: string | undefined;
  contents: Content[];
}

function toGoogleMessages(messages: ModelMessage[]): MappedMessages {
  let systemInstruction: string | undefined;
  const contents: Content[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case 'system':
        // Google accepts a single systemInstruction; concatenate if multiple
        systemInstruction = systemInstruction
          ? `${systemInstruction}\n${msg.content}`
          : msg.content;
        break;

      case 'user':
        contents.push({ role: 'user', parts: [{ text: msg.content }] });
        break;

      case 'assistant': {
        const parts: Part[] = [];
        if (msg.content) {
          parts.push({ text: msg.content });
        }
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          for (const tc of msg.toolCalls) {
            parts.push({
              functionCall: {
                name: tc.toolName,
                args: (typeof tc.arguments === 'object' && tc.arguments !== null
                  ? tc.arguments
                  : {}) as Record<string, unknown>,
              },
            });
          }
        }
        contents.push({ role: 'model', parts });
        break;
      }

      case 'tool': {
        let parsed: unknown;
        try {
          parsed = JSON.parse(msg.content);
        } catch {
          parsed = { result: msg.content };
        }
        contents.push({
          role: 'function',
          parts: [
            {
              functionResponse: {
                name: msg.toolCallId ?? '',
                response: parsed as object,
              },
            },
          ],
        });
        break;
      }
    }
  }

  return { systemInstruction, contents };
}

// ---------------------------------------------------------------------------
// Tool mapping
// ---------------------------------------------------------------------------

function toGoogleTools(tools: ToolSchema[]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters as unknown as FunctionDeclarationSchema,
  }));
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a Google (Gemini) `ModelProvider` backed by the `@google/generative-ai` SDK.
 */
export function createGoogleProvider(config: ProviderConfig): ModelProvider {
  const genAI = new GoogleGenerativeAI(config.apiKey);
  const defaultModel = config.defaultModel;
  const timeoutMs = config.timeout;

  async function* generate(request: ModelRequest): AsyncGenerator<ModelStreamChunk, void, undefined> {
    const signal = mergeSignals(request.signal, timeoutMs);
    const modelName = request.model || defaultModel;
    if (!modelName) {
      throw normalizeError(
        new Error('No model specified and no defaultModel configured'),
        'google',
      );
    }

    try {
      const { systemInstruction, contents } = toGoogleMessages(request.messages);

      const model = genAI.getGenerativeModel({
        model: modelName,
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(request.temperature !== undefined
          ? { generationConfig: { temperature: request.temperature } }
          : {}),
      });

      const functionDeclarations = request.tools && request.tools.length > 0
        ? toGoogleTools(request.tools)
        : undefined;

      const streamResult = await model.generateContentStream({
        contents,
        ...(functionDeclarations
          ? { tools: [{ functionDeclarations }] }
          : {}),
        ...(request.maxTokens !== undefined
          ? { generationConfig: { maxOutputTokens: request.maxTokens } }
          : {}),
      });

      let finishReason = 'stop';
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      let totalTokens: number | undefined;

      for await (const chunk of streamResult.stream) {
        // Check cancellation before processing
        if (signal.aborted) break;

        const candidate: GenerateContentCandidate | undefined = chunk.candidates?.[0];

        if (candidate) {
          for (const part of candidate.content?.parts ?? []) {
            // Text token
            if (part.text) {
              yield { type: 'token', text: part.text };
            }

            // Function call (delivered complete, not streamed)
            if (part.functionCall) {
              yield {
                type: 'tool_call',
                toolName: part.functionCall.name,
                callId: `tc_${nanoid()}`,
                arguments: part.functionCall.args ?? {},
              };
            }
          }

          // Capture finish reason from candidate
          if (candidate.finishReason) {
            finishReason = mapFinishReason(candidate.finishReason as string);
          }
        }

        // Usage metadata
        if (chunk.usageMetadata) {
          inputTokens = chunk.usageMetadata.promptTokenCount;
          outputTokens = chunk.usageMetadata.candidatesTokenCount;
          totalTokens = chunk.usageMetadata.totalTokenCount;
        }
      }

      // Terminal finish chunk
      yield {
        type: 'finish',
        finishReason,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens,
        },
      };
    } catch (error) {
      throw normalizeError(error, 'google');
    }
  }

  return { generate };
}
