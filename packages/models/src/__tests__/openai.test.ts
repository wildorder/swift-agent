import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ModelRequest, ModelStreamChunk } from '../types.js';
import { ModelError } from '../types.js';
import { createOpenAIProvider } from '../providers/openai.js';

// ---------------------------------------------------------------------------
// Mock the openai module
// ---------------------------------------------------------------------------

const mockCreate = vi.fn();

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockCreate } };
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* asyncIter<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

async function collectChunks(
  gen: AsyncGenerator<ModelStreamChunk>,
): Promise<ModelStreamChunk[]> {
  const chunks: ModelStreamChunk[] = [];
  for await (const c of gen) chunks.push(c);
  return chunks;
}

function makeChunk(overrides: Record<string, unknown> = {}) {
  return {
    choices: [{ delta: {}, finish_reason: null, ...overrides }],
    usage: null,
    ...overrides,
  };
}

function baseRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createOpenAIProvider', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  // -----------------------------------------------------------------------
  // 1. text + tool_call + finish
  // -----------------------------------------------------------------------
  it('streams text deltas, assembles tool calls, and finishes with usage', async () => {
    const streamChunks = [
      // Text deltas split across chunks
      makeChunk({ delta: { content: 'Hello' } }),
      makeChunk({ delta: { content: ' world' } }),
      // Tool call deltas — arguments split across chunks
      makeChunk({
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_abc123',
              function: { name: 'get_weather', arguments: '{"lo' },
            },
          ],
        },
      }),
      makeChunk({
        delta: {
          tool_calls: [
            {
              index: 0,
              function: { arguments: 'cation":"NYC"}' },
            },
          ],
        },
      }),
      // Finish reason
      makeChunk({ delta: {}, finish_reason: 'tool_calls' }),
      // Usage chunk (final, typically no choices)
      {
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      },
    ];

    mockCreate.mockResolvedValue(asyncIter(streamChunks));

    const provider = createOpenAIProvider({ apiKey: 'test-key' });
    const gen = provider.generate(baseRequest());
    const chunks = await collectChunks(gen);

    // Should yield: token, token, tool_call, finish
    expect(chunks).toHaveLength(4);

    expect(chunks[0]).toEqual({ type: 'token', text: 'Hello' });
    expect(chunks[1]).toEqual({ type: 'token', text: ' world' });

    expect(chunks[2]).toEqual({
      type: 'tool_call',
      toolName: 'get_weather',
      callId: 'call_abc123',
      arguments: { location: 'NYC' },
    });

    expect(chunks[3]).toEqual({
      type: 'finish',
      finishReason: 'tool_calls',
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
      },
    });
  });

  // -----------------------------------------------------------------------
  // 2. text only
  // -----------------------------------------------------------------------
  it('streams text-only response with no tool calls', async () => {
    const streamChunks = [
      makeChunk({ delta: { content: 'Just ' } }),
      makeChunk({ delta: { content: 'text.' } }),
      makeChunk({ delta: {}, finish_reason: 'stop' }),
      {
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      },
    ];

    mockCreate.mockResolvedValue(asyncIter(streamChunks));

    const provider = createOpenAIProvider({ apiKey: 'test-key' });
    const chunks = await collectChunks(provider.generate(baseRequest()));

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({ type: 'token', text: 'Just ' });
    expect(chunks[1]).toEqual({ type: 'token', text: 'text.' });
    expect(chunks[2]).toEqual({
      type: 'finish',
      finishReason: 'stop',
      usage: {
        inputTokens: 5,
        outputTokens: 3,
        totalTokens: 8,
      },
    });
  });

  // -----------------------------------------------------------------------
  // 3. multiple tool calls
  // -----------------------------------------------------------------------
  it('assembles multiple parallel tool calls by index', async () => {
    const streamChunks = [
      // First tool call — index 0
      makeChunk({
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_001',
              function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
            },
          ],
        },
      }),
      // Second tool call — index 1
      makeChunk({
        delta: {
          tool_calls: [
            {
              index: 1,
              id: 'call_002',
              function: { name: 'get_time', arguments: '{"tz":' },
            },
          ],
        },
      }),
      // Continue second tool call arguments
      makeChunk({
        delta: {
          tool_calls: [
            {
              index: 1,
              function: { arguments: '"UTC"}' },
            },
          ],
        },
      }),
      makeChunk({ delta: {}, finish_reason: 'tool_calls' }),
      {
        choices: [],
        usage: { prompt_tokens: 15, completion_tokens: 25, total_tokens: 40 },
      },
    ];

    mockCreate.mockResolvedValue(asyncIter(streamChunks));

    const provider = createOpenAIProvider({ apiKey: 'test-key' });
    const chunks = await collectChunks(provider.generate(baseRequest()));

    // Should yield: tool_call (index 0), tool_call (index 1), finish
    expect(chunks).toHaveLength(3);

    expect(chunks[0]).toEqual({
      type: 'tool_call',
      toolName: 'get_weather',
      callId: 'call_001',
      arguments: { city: 'NYC' },
    });

    expect(chunks[1]).toEqual({
      type: 'tool_call',
      toolName: 'get_time',
      callId: 'call_002',
      arguments: { tz: 'UTC' },
    });

    expect(chunks[2]).toEqual({
      type: 'finish',
      finishReason: 'tool_calls',
      usage: {
        inputTokens: 15,
        outputTokens: 25,
        totalTokens: 40,
      },
    });
  });

  // -----------------------------------------------------------------------
  // 4. error handling — 429 retryable
  // -----------------------------------------------------------------------
  it('wraps a 429 error as ModelError with retryable=true', async () => {
    const apiError = new Error('Rate limit exceeded');
    (apiError as unknown as Record<string, unknown>).status = 429;

    mockCreate.mockRejectedValue(apiError);

    const provider = createOpenAIProvider({ apiKey: 'test-key' });

    await expect(
      collectChunks(provider.generate(baseRequest())),
    ).rejects.toThrow(ModelError);

    try {
      await collectChunks(provider.generate(baseRequest()));
    } catch (err) {
      expect(err).toBeInstanceOf(ModelError);
      const modelErr = err as ModelError;
      expect(modelErr.provider).toBe('openai');
      expect(modelErr.statusCode).toBe(429);
      expect(modelErr.retryable).toBe(true);
    }
  });

  // -----------------------------------------------------------------------
  // 5. error — generic non-retryable
  // -----------------------------------------------------------------------
  it('wraps a plain Error as ModelError with retryable=false', async () => {
    mockCreate.mockRejectedValue(new Error('Something went wrong'));

    const provider = createOpenAIProvider({ apiKey: 'test-key' });

    await expect(
      collectChunks(provider.generate(baseRequest())),
    ).rejects.toThrow(ModelError);

    try {
      await collectChunks(provider.generate(baseRequest()));
    } catch (err) {
      expect(err).toBeInstanceOf(ModelError);
      const modelErr = err as ModelError;
      expect(modelErr.provider).toBe('openai');
      expect(modelErr.retryable).toBe(false);
      expect(modelErr.statusCode).toBeUndefined();
    }
  });

  // -----------------------------------------------------------------------
  // 6. abort signal is passed through
  // -----------------------------------------------------------------------
  it('passes abort signal to the create call', async () => {
    const streamChunks = [
      makeChunk({ delta: { content: 'ok' }, finish_reason: 'stop' }),
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ];
    mockCreate.mockResolvedValue(asyncIter(streamChunks));

    const controller = new AbortController();
    const provider = createOpenAIProvider({ apiKey: 'test-key' });

    await collectChunks(
      provider.generate(baseRequest({ signal: controller.signal })),
    );

    // Verify create was called with signal in the second argument
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const [, options] = mockCreate.mock.calls[0] as [unknown, { signal: AbortSignal }];
    expect(options).toHaveProperty('signal');
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  // -----------------------------------------------------------------------
  // 7. timeout via config
  // -----------------------------------------------------------------------
  it('creates a signal that includes the configured timeout', async () => {
    const streamChunks = [
      makeChunk({ delta: { content: 'hi' }, finish_reason: 'stop' }),
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ];
    mockCreate.mockResolvedValue(asyncIter(streamChunks));

    const provider = createOpenAIProvider({
      apiKey: 'test-key',
      timeout: 5000,
    });

    await collectChunks(provider.generate(baseRequest()));

    // Verify a signal was passed (mergeSignals produces a combined signal)
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const [, options] = mockCreate.mock.calls[0] as [unknown, { signal: AbortSignal }];
    expect(options).toHaveProperty('signal');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    // The signal should not already be aborted (timeout hasn't elapsed)
    expect(options.signal.aborted).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Edge: no model specified and no defaultModel
  // -----------------------------------------------------------------------
  it('throws ModelError when no model is specified and no defaultModel configured', async () => {
    const provider = createOpenAIProvider({ apiKey: 'test-key' });

    await expect(
      collectChunks(
        provider.generate({
          model: '',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      ),
    ).rejects.toThrow(ModelError);
  });

  // -----------------------------------------------------------------------
  // Edge: uses defaultModel from config when request.model is empty
  // -----------------------------------------------------------------------
  it('falls back to defaultModel from config', async () => {
    const streamChunks = [
      makeChunk({ delta: { content: 'ok' }, finish_reason: 'stop' }),
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ];
    mockCreate.mockResolvedValue(asyncIter(streamChunks));

    const provider = createOpenAIProvider({
      apiKey: 'test-key',
      defaultModel: 'gpt-4o-mini',
    });

    await collectChunks(
      provider.generate({
        model: '',
        messages: [{ role: 'user', content: 'test' }],
      }),
    );

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const [params] = mockCreate.mock.calls[0] as [{ model: string }];
    expect(params.model).toBe('gpt-4o-mini');
  });

  // -----------------------------------------------------------------------
  // Edge: tools and parameters forwarded correctly
  // -----------------------------------------------------------------------
  it('maps tools and optional parameters to the create call', async () => {
    const streamChunks = [
      makeChunk({ delta: { content: 'ok' }, finish_reason: 'stop' }),
      { choices: [], usage: null },
    ];
    mockCreate.mockResolvedValue(asyncIter(streamChunks));

    const provider = createOpenAIProvider({ apiKey: 'test-key' });

    await collectChunks(
      provider.generate({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [
          {
            name: 'get_weather',
            description: 'Get the weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        ],
        temperature: 0.7,
        maxTokens: 100,
      }),
    );

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const [params] = mockCreate.mock.calls[0] as [Record<string, unknown>];

    expect(params.model).toBe('gpt-4o');
    expect(params.stream).toBe(true);
    expect(params.temperature).toBe(0.7);
    expect(params.max_tokens).toBe(100);
    expect(params.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get the weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      },
    ]);
  });
});
