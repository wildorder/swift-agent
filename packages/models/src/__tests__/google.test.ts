import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ModelRequest, ModelStreamChunk } from '../types.js';
import { ModelError } from '../types.js';
import { createGoogleProvider } from '../providers/google.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGenerateContentStream = vi.fn();
const mockGetGenerativeModel = vi.fn(() => ({
  generateContentStream: mockGenerateContentStream,
}));

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class MockGoogleGenAI {
    getGenerativeModel = mockGetGenerativeModel;
  },
}));

vi.mock('nanoid', () => ({
  nanoid: () => 'mock-id-123',
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* asyncIter<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

async function collectChunks(gen: AsyncGenerator<ModelStreamChunk>): Promise<ModelStreamChunk[]> {
  const chunks: ModelStreamChunk[] = [];
  for await (const c of gen) chunks.push(c);
  return chunks;
}

function baseRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: 'gemini-pro',
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createGoogleProvider', () => {
  const provider = createGoogleProvider({ apiKey: 'test-key' });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Text + function call + finish
  // -------------------------------------------------------------------------
  describe('text then function call stream', () => {
    it('yields token, tool_call, then finish with correct fields', async () => {
      mockGenerateContentStream.mockResolvedValue({
        stream: asyncIter([
          {
            candidates: [{
              content: { parts: [{ text: 'Let me check ' }] },
              finishReason: undefined,
            }],
            usageMetadata: undefined,
          },
          {
            candidates: [{
              content: {
                parts: [{
                  functionCall: { name: 'get_weather', args: { location: 'NYC' } },
                }],
              },
              finishReason: 'STOP',
            }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
          },
        ]),
      });

      const chunks = await collectChunks(provider.generate(baseRequest()));

      expect(chunks).toHaveLength(3);

      expect(chunks[0]).toEqual({ type: 'token', text: 'Let me check ' });

      expect(chunks[1]).toEqual({
        type: 'tool_call',
        toolName: 'get_weather',
        callId: 'tc_mock-id-123',
        arguments: { location: 'NYC' },
      });

      expect(chunks[2]).toEqual({
        type: 'finish',
        finishReason: 'stop',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        },
      });
    });
  });

  // -------------------------------------------------------------------------
  // 2. Text only
  // -------------------------------------------------------------------------
  describe('text-only stream', () => {
    it('yields token chunks then finish, no tool_call', async () => {
      mockGenerateContentStream.mockResolvedValue({
        stream: asyncIter([
          {
            candidates: [{
              content: { parts: [{ text: 'Hello' }] },
              finishReason: undefined,
            }],
            usageMetadata: undefined,
          },
          {
            candidates: [{
              content: { parts: [{ text: ' world' }] },
              finishReason: 'STOP',
            }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
          },
        ]),
      });

      const chunks = await collectChunks(provider.generate(baseRequest()));

      const types = chunks.map((c) => c.type);
      expect(types).toEqual(['token', 'token', 'finish']);
      expect(types).not.toContain('tool_call');

      expect(chunks[0]).toEqual({ type: 'token', text: 'Hello' });
      expect(chunks[1]).toEqual({ type: 'token', text: ' world' });
      expect(chunks[2]).toEqual({
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      });
    });
  });

  // -------------------------------------------------------------------------
  // 3. Finish reason mapping
  // -------------------------------------------------------------------------
  describe('finish reason mapping', () => {
    const cases: Array<[string, string]> = [
      ['STOP', 'stop'],
      ['MAX_TOKENS', 'max_tokens'],
      ['SAFETY', 'safety'],
      ['RECITATION', 'recitation'],
      ['OTHER', 'other'],
    ];

    it.each(cases)('maps %s → %s', async (raw, expected) => {
      mockGenerateContentStream.mockResolvedValue({
        stream: asyncIter([
          {
            candidates: [{
              content: { parts: [{ text: 'x' }] },
              finishReason: raw,
            }],
            usageMetadata: undefined,
          },
        ]),
      });

      const chunks = await collectChunks(provider.generate(baseRequest()));
      const finish = chunks.find((c) => c.type === 'finish');

      expect(finish).toBeDefined();
      expect(finish?.type === 'finish' && finish.finishReason).toBe(expected);
    });

    it('defaults to stop when finishReason is undefined', async () => {
      mockGenerateContentStream.mockResolvedValue({
        stream: asyncIter([
          {
            candidates: [{
              content: { parts: [{ text: 'x' }] },
              finishReason: undefined,
            }],
            usageMetadata: undefined,
          },
        ]),
      });

      const chunks = await collectChunks(provider.generate(baseRequest()));
      const finish = chunks.find((c) => c.type === 'finish');

      expect(finish).toBeDefined();
      expect(finish?.type === 'finish' && finish.finishReason).toBe('stop');
    });

    it('lowercases unknown finish reasons', async () => {
      mockGenerateContentStream.mockResolvedValue({
        stream: asyncIter([
          {
            candidates: [{
              content: { parts: [{ text: 'x' }] },
              finishReason: 'BLOCKLIST',
            }],
            usageMetadata: undefined,
          },
        ]),
      });

      const chunks = await collectChunks(provider.generate(baseRequest()));
      const finish = chunks.find((c) => c.type === 'finish');

      expect(finish?.type === 'finish' && finish.finishReason).toBe('blocklist');
    });
  });

  // -------------------------------------------------------------------------
  // 4. Error handling
  // -------------------------------------------------------------------------
  describe('error handling', () => {
    it('wraps SDK errors as ModelError with provider=google', async () => {
      mockGenerateContentStream.mockRejectedValue(new Error('API quota exceeded'));

      await expect(async () => {
        await collectChunks(provider.generate(baseRequest()));
      }).rejects.toThrow(ModelError);

      try {
        await collectChunks(provider.generate(baseRequest()));
      } catch (err) {
        expect(err).toBeInstanceOf(ModelError);
        expect((err as ModelError).provider).toBe('google');
        expect((err as ModelError).message).toBe('API quota exceeded');
      }
    });

    it('throws ModelError when no model is specified and no default configured', async () => {
      const noDefaultProvider = createGoogleProvider({ apiKey: 'test-key' });

      await expect(async () => {
        // Pass model as empty string to trigger the check
        await collectChunks(noDefaultProvider.generate({
          model: '',
          messages: [{ role: 'user', content: 'Hello' }],
        }));
      }).rejects.toThrow(ModelError);
    });

    it('preserves retryable flag for status-code errors', async () => {
      const err = Object.assign(new Error('rate limited'), { status: 429 });
      mockGenerateContentStream.mockRejectedValue(err);

      try {
        await collectChunks(provider.generate(baseRequest()));
      } catch (e) {
        expect(e).toBeInstanceOf(ModelError);
        expect((e as ModelError).retryable).toBe(true);
        expect((e as ModelError).statusCode).toBe(429);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 5. Cancellation via abort signal
  // -------------------------------------------------------------------------
  describe('cancellation via abort signal', () => {
    it('stops early when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      mockGenerateContentStream.mockResolvedValue({
        stream: asyncIter([
          {
            candidates: [{
              content: { parts: [{ text: 'chunk1' }] },
              finishReason: undefined,
            }],
            usageMetadata: undefined,
          },
          {
            candidates: [{
              content: { parts: [{ text: 'chunk2' }] },
              finishReason: undefined,
            }],
            usageMetadata: undefined,
          },
          {
            candidates: [{
              content: { parts: [{ text: 'chunk3' }] },
              finishReason: 'STOP',
            }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
          },
        ]),
      });

      const chunks = await collectChunks(
        provider.generate({ ...baseRequest(), signal: controller.signal }),
      );

      // With signal already aborted, the loop breaks before processing any chunk
      // but the finish chunk is still emitted at the end
      const tokenChunks = chunks.filter((c) => c.type === 'token');
      expect(tokenChunks.length).toBeLessThan(3);

      // A finish chunk is always emitted
      const finish = chunks.find((c) => c.type === 'finish');
      expect(finish).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // 6. System instruction
  // -------------------------------------------------------------------------
  describe('system instruction', () => {
    it('passes systemInstruction to getGenerativeModel', async () => {
      mockGenerateContentStream.mockResolvedValue({
        stream: asyncIter([
          {
            candidates: [{
              content: { parts: [{ text: 'OK' }] },
              finishReason: 'STOP',
            }],
            usageMetadata: undefined,
          },
        ]),
      });

      await collectChunks(provider.generate(baseRequest({
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hi' },
        ],
      })));

      expect(mockGetGenerativeModel).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gemini-pro',
          systemInstruction: 'You are helpful.',
        }),
      );
    });

    it('concatenates multiple system messages', async () => {
      mockGenerateContentStream.mockResolvedValue({
        stream: asyncIter([
          {
            candidates: [{
              content: { parts: [{ text: 'OK' }] },
              finishReason: 'STOP',
            }],
            usageMetadata: undefined,
          },
        ]),
      });

      await collectChunks(provider.generate(baseRequest({
        messages: [
          { role: 'system', content: 'Be concise.' },
          { role: 'system', content: 'Be accurate.' },
          { role: 'user', content: 'Hi' },
        ],
      })));

      expect(mockGetGenerativeModel).toHaveBeenCalledWith(
        expect.objectContaining({
          systemInstruction: 'Be concise.\nBe accurate.',
        }),
      );
    });

    it('does not include systemInstruction when no system messages present', async () => {
      mockGenerateContentStream.mockResolvedValue({
        stream: asyncIter([
          {
            candidates: [{
              content: { parts: [{ text: 'OK' }] },
              finishReason: 'STOP',
            }],
            usageMetadata: undefined,
          },
        ]),
      });

      await collectChunks(provider.generate(baseRequest()));

      const modelCall = mockGetGenerativeModel.mock.calls[0] as unknown[];
      expect(modelCall[0] as Record<string, unknown>).not.toHaveProperty('systemInstruction');
    });
  });

  // -------------------------------------------------------------------------
  // 7. Usage extraction
  // -------------------------------------------------------------------------
  describe('usage extraction', () => {
    it('maps promptTokenCount → inputTokens, candidatesTokenCount → outputTokens, totalTokenCount → totalTokens', async () => {
      mockGenerateContentStream.mockResolvedValue({
        stream: asyncIter([
          {
            candidates: [{
              content: { parts: [{ text: 'done' }] },
              finishReason: 'STOP',
            }],
            usageMetadata: {
              promptTokenCount: 42,
              candidatesTokenCount: 18,
              totalTokenCount: 60,
            },
          },
        ]),
      });

      const chunks = await collectChunks(provider.generate(baseRequest()));
      const finish = chunks.find((c) => c.type === 'finish');

      expect(finish).toEqual({
        type: 'finish',
        finishReason: 'stop',
        usage: {
          inputTokens: 42,
          outputTokens: 18,
          totalTokens: 60,
        },
      });
    });

    it('yields undefined usage fields when usageMetadata is absent', async () => {
      mockGenerateContentStream.mockResolvedValue({
        stream: asyncIter([
          {
            candidates: [{
              content: { parts: [{ text: 'hi' }] },
              finishReason: 'STOP',
            }],
            usageMetadata: undefined,
          },
        ]),
      });

      const chunks = await collectChunks(provider.generate(baseRequest()));
      const finish = chunks.find((c) => c.type === 'finish');

      expect(finish).toEqual({
        type: 'finish',
        finishReason: 'stop',
        usage: {
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: undefined,
        },
      });
    });

    it('takes usage from the last chunk when multiple chunks have metadata', async () => {
      mockGenerateContentStream.mockResolvedValue({
        stream: asyncIter([
          {
            candidates: [{
              content: { parts: [{ text: 'a' }] },
              finishReason: undefined,
            }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 },
          },
          {
            candidates: [{
              content: { parts: [{ text: 'b' }] },
              finishReason: 'STOP',
            }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
          },
        ]),
      });

      const chunks = await collectChunks(provider.generate(baseRequest()));
      const finish = chunks.find((c) => c.type === 'finish');

      expect(finish).toEqual({
        type: 'finish',
        finishReason: 'stop',
        usage: {
          inputTokens: 5,
          outputTokens: 3,
          totalTokens: 8,
        },
      });
    });
  });

  // -------------------------------------------------------------------------
  // Additional: message mapping & tools
  // -------------------------------------------------------------------------
  describe('message and tool mapping', () => {
    it('passes tools as functionDeclarations when provided', async () => {
      mockGenerateContentStream.mockResolvedValue({
        stream: asyncIter([
          {
            candidates: [{
              content: { parts: [{ text: 'OK' }] },
              finishReason: 'STOP',
            }],
            usageMetadata: undefined,
          },
        ]),
      });

      await collectChunks(provider.generate(baseRequest({
        tools: [
          {
            name: 'get_weather',
            description: 'Get the weather',
            parameters: { type: 'object', properties: { location: { type: 'string' } } },
          },
        ],
      })));

      expect(mockGenerateContentStream).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'get_weather',
                  description: 'Get the weather',
                  parameters: { type: 'object', properties: { location: { type: 'string' } } },
                },
              ],
            },
          ],
        }),
      );
    });

    it('maps assistant messages with toolCalls to model role with functionCall parts', async () => {
      mockGenerateContentStream.mockResolvedValue({
        stream: asyncIter([
          {
            candidates: [{
              content: { parts: [{ text: 'OK' }] },
              finishReason: 'STOP',
            }],
            usageMetadata: undefined,
          },
        ]),
      });

      await collectChunks(provider.generate(baseRequest({
        messages: [
          { role: 'user', content: 'Check weather' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              { callId: 'tc_abc', toolName: 'get_weather', arguments: { location: 'NYC' } },
            ],
          },
          {
            role: 'tool',
            content: '{"temp": 72}',
            toolCallId: 'get_weather',
          },
          { role: 'user', content: 'Thanks' },
        ],
      })));

      const callArgs = (mockGenerateContentStream.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
      const contents = callArgs['contents'] as Array<Record<string, unknown>>;

      // user → model (assistant with functionCall) → function (tool response) → user
      expect(contents).toHaveLength(4);
      expect(contents[0]).toEqual({ role: 'user', parts: [{ text: 'Check weather' }] });
      expect(contents[1]).toEqual({
        role: 'model',
        parts: [
          { functionCall: { name: 'get_weather', args: { location: 'NYC' } } },
        ],
      });
      expect(contents[2]).toEqual({
        role: 'function',
        parts: [
          { functionResponse: { name: 'get_weather', response: { temp: 72 } } },
        ],
      });
      expect(contents[3]).toEqual({ role: 'user', parts: [{ text: 'Thanks' }] });
    });

    it('passes temperature to generationConfig in getGenerativeModel', async () => {
      mockGenerateContentStream.mockResolvedValue({
        stream: asyncIter([
          {
            candidates: [{
              content: { parts: [{ text: 'OK' }] },
              finishReason: 'STOP',
            }],
            usageMetadata: undefined,
          },
        ]),
      });

      await collectChunks(provider.generate(baseRequest({ temperature: 0.7 })));

      expect(mockGetGenerativeModel).toHaveBeenCalledWith(
        expect.objectContaining({
          generationConfig: { temperature: 0.7 },
        }),
      );
    });

    it('passes maxTokens as maxOutputTokens in generateContentStream', async () => {
      mockGenerateContentStream.mockResolvedValue({
        stream: asyncIter([
          {
            candidates: [{
              content: { parts: [{ text: 'OK' }] },
              finishReason: 'STOP',
            }],
            usageMetadata: undefined,
          },
        ]),
      });

      await collectChunks(provider.generate(baseRequest({ maxTokens: 256 })));

      expect(mockGenerateContentStream).toHaveBeenCalledWith(
        expect.objectContaining({
          generationConfig: { maxOutputTokens: 256 },
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Edge: empty candidates / missing parts
  // -------------------------------------------------------------------------
  describe('edge cases', () => {
    it('handles chunk with no candidates gracefully', async () => {
      mockGenerateContentStream.mockResolvedValue({
        stream: asyncIter([
          { candidates: undefined, usageMetadata: undefined },
          {
            candidates: [{
              content: { parts: [{ text: 'hi' }] },
              finishReason: 'STOP',
            }],
            usageMetadata: undefined,
          },
        ]),
      });

      const chunks = await collectChunks(provider.generate(baseRequest()));

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toEqual({ type: 'token', text: 'hi' });
      expect(chunks[1]).toEqual({
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined },
      });
    });

    it('handles chunk with text and functionCall in same parts array', async () => {
      mockGenerateContentStream.mockResolvedValue({
        stream: asyncIter([
          {
            candidates: [{
              content: {
                parts: [
                  { text: 'I will call: ' },
                  { functionCall: { name: 'search', args: { q: 'test' } } },
                ],
              },
              finishReason: 'STOP',
            }],
            usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 },
          },
        ]),
      });

      const chunks = await collectChunks(provider.generate(baseRequest()));

      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toEqual({ type: 'token', text: 'I will call: ' });
      expect(chunks[1]).toEqual({
        type: 'tool_call',
        toolName: 'search',
        callId: 'tc_mock-id-123',
        arguments: { q: 'test' },
      });
      expect(chunks[2]).toEqual({
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
      });
    });

    it('uses defaultModel when request.model is omitted', async () => {
      const providerWithDefault = createGoogleProvider({
        apiKey: 'test-key',
        defaultModel: 'gemini-1.5-flash',
      });

      mockGenerateContentStream.mockResolvedValue({
        stream: asyncIter([
          {
            candidates: [{
              content: { parts: [{ text: 'OK' }] },
              finishReason: 'STOP',
            }],
            usageMetadata: undefined,
          },
        ]),
      });

      await collectChunks(providerWithDefault.generate({
        model: '',
        messages: [{ role: 'user', content: 'Hi' }],
      }));

      expect(mockGetGenerativeModel).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gemini-1.5-flash' }),
      );
    });
  });
});
