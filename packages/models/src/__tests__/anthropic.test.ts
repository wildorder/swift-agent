import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ModelRequest, ModelStreamChunk } from '../types.js';
import { ModelError } from '../types.js';
import { createAnthropicProvider } from '../providers/anthropic.js';

// ---------------------------------------------------------------------------
// Mock the Anthropic SDK
// ---------------------------------------------------------------------------

const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
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

function baseRequest(overrides?: Partial<ModelRequest>): ModelRequest {
  return {
    model: 'claude-3-5-sonnet-20241022',
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createAnthropicProvider', () => {
  const provider = createAnthropicProvider({ apiKey: 'test-key' });

  beforeEach(() => {
    mockCreate.mockReset();
  });

  // -----------------------------------------------------------------------
  // 1. text + tool_call + finish
  // -----------------------------------------------------------------------
  it('streams text tokens, a tool_call, and a finish chunk', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      // Text tokens
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The weather ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'is nice.' } },
      { type: 'content_block_stop', index: 0 },
      // Tool use
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'tc_1', name: 'get_weather' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"loc' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: 'ation":"NYC"}' },
      },
      { type: 'content_block_stop', index: 1 },
      // Finish
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 25 },
      },
    ];

    mockCreate.mockResolvedValue(asyncIter(events));

    const chunks = await collectChunks(provider.generate(baseRequest()));

    // Token chunks
    expect(chunks[0]).toEqual({ type: 'token', text: 'The weather ' });
    expect(chunks[1]).toEqual({ type: 'token', text: 'is nice.' });

    // Tool call chunk
    expect(chunks[2]).toEqual({
      type: 'tool_call',
      callId: 'tc_1',
      toolName: 'get_weather',
      arguments: { location: 'NYC' },
    });

    // Finish chunk
    expect(chunks[3]).toEqual({
      type: 'finish',
      finishReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 25, totalTokens: 35 },
    });

    expect(chunks).toHaveLength(4);
  });

  // -----------------------------------------------------------------------
  // 2. text only — no tool calls
  // -----------------------------------------------------------------------
  it('streams text tokens and finish without tool calls', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi!' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 3 },
      },
    ];

    mockCreate.mockResolvedValue(asyncIter(events));

    const chunks = await collectChunks(provider.generate(baseRequest()));

    const types = chunks.map((c) => c.type);
    expect(types).toEqual(['token', 'finish']);
    expect(chunks[0]).toEqual({ type: 'token', text: 'Hi!' });
    expect(chunks[1]).toEqual({
      type: 'finish',
      finishReason: 'end_turn',
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
    });
  });

  // -----------------------------------------------------------------------
  // 3. system message extraction
  // -----------------------------------------------------------------------
  it('extracts system messages into the system parameter', async () => {
    mockCreate.mockResolvedValue(asyncIter([
      { type: 'message_start', message: { usage: { input_tokens: 0 } } },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 0 },
      },
    ]));

    const request = baseRequest({
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hello' },
      ],
    });

    await collectChunks(provider.generate(request));

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const [createArgs] = mockCreate.mock.calls[0] as [Record<string, unknown>];

    // System messages joined with double newline
    expect(createArgs.system).toBe('You are helpful.\n\nBe concise.');

    // Messages array should only contain the user message
    expect(createArgs.messages).toEqual([
      { role: 'user', content: 'Hello' },
    ]);
  });

  // -----------------------------------------------------------------------
  // 4. error handling — 429 rate limit
  // -----------------------------------------------------------------------
  it('throws retryable ModelError on 429', async () => {
    const apiErr = new Error('rate limited');
    (apiErr as unknown as Record<string, unknown>).status = 429;
    mockCreate.mockRejectedValue(apiErr);

    await expect(async () => {
      await collectChunks(provider.generate(baseRequest()));
    }).rejects.toThrow(ModelError);

    try {
      await collectChunks(provider.generate(baseRequest()));
    } catch (e) {
      expect(e).toBeInstanceOf(ModelError);
      const err = e as ModelError;
      expect(err.provider).toBe('anthropic');
      expect(err.statusCode).toBe(429);
      expect(err.retryable).toBe(true);
    }
  });

  // -----------------------------------------------------------------------
  // 5. error handling — 529 overloaded
  // -----------------------------------------------------------------------
  it('throws retryable ModelError on 529 (overloaded)', async () => {
    const apiErr = new Error('overloaded');
    (apiErr as unknown as Record<string, unknown>).status = 529;
    mockCreate.mockRejectedValue(apiErr);

    try {
      await collectChunks(provider.generate(baseRequest()));
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ModelError);
      const err = e as ModelError;
      expect(err.provider).toBe('anthropic');
      expect(err.statusCode).toBe(529);
      expect(err.retryable).toBe(true);
    }
  });

  // -----------------------------------------------------------------------
  // 6. error handling — generic error
  // -----------------------------------------------------------------------
  it('throws non-retryable ModelError for generic errors', async () => {
    mockCreate.mockRejectedValue(new Error('something broke'));

    try {
      await collectChunks(provider.generate(baseRequest()));
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ModelError);
      const err = e as ModelError;
      expect(err.provider).toBe('anthropic');
      expect(err.retryable).toBe(false);
      expect(err.statusCode).toBeUndefined();
    }
  });

  // -----------------------------------------------------------------------
  // 7. abort signal is passed through
  // -----------------------------------------------------------------------
  it('passes the abort signal to client.messages.create', async () => {
    mockCreate.mockResolvedValue(asyncIter([
      { type: 'message_start', message: { usage: { input_tokens: 0 } } },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 0 },
      },
    ]));

    const controller = new AbortController();
    const request = baseRequest({ signal: controller.signal });

    await collectChunks(provider.generate(request));

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const [, secondArg] = mockCreate.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(secondArg).toHaveProperty('signal');
    expect(secondArg.signal).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // 8. default max_tokens is 4096
  // -----------------------------------------------------------------------
  it('uses default max_tokens of 4096 when maxTokens is undefined', async () => {
    mockCreate.mockResolvedValue(asyncIter([
      { type: 'message_start', message: { usage: { input_tokens: 0 } } },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 0 },
      },
    ]));

    await collectChunks(provider.generate(baseRequest()));

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const [createArgs] = mockCreate.mock.calls[0] as [Record<string, unknown>];
    expect(createArgs.max_tokens).toBe(4096);
  });

  it('uses provided maxTokens when set', async () => {
    mockCreate.mockResolvedValue(asyncIter([
      { type: 'message_start', message: { usage: { input_tokens: 0 } } },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 0 },
      },
    ]));

    await collectChunks(provider.generate(baseRequest({ maxTokens: 1024 })));

    const [createArgs] = mockCreate.mock.calls[0] as [Record<string, unknown>];
    expect(createArgs.max_tokens).toBe(1024);
  });

  // -----------------------------------------------------------------------
  // Bonus: tool schema mapping
  // -----------------------------------------------------------------------
  it('maps tool schemas to Anthropic tool format', async () => {
    mockCreate.mockResolvedValue(asyncIter([
      { type: 'message_start', message: { usage: { input_tokens: 0 } } },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 0 },
      },
    ]));

    const request = baseRequest({
      tools: [
        {
          name: 'get_weather',
          description: 'Get weather info',
          parameters: { properties: { location: { type: 'string' } }, required: ['location'] },
        },
      ],
    });

    await collectChunks(provider.generate(request));

    const [createArgs] = mockCreate.mock.calls[0] as [Record<string, unknown>];
    expect(createArgs.tools).toEqual([
      {
        name: 'get_weather',
        description: 'Get weather info',
        input_schema: {
          type: 'object',
          properties: { location: { type: 'string' } },
          required: ['location'],
        },
      },
    ]);
  });

  // -----------------------------------------------------------------------
  // Bonus: stream iteration error is wrapped
  // -----------------------------------------------------------------------
  it('wraps errors that occur during stream iteration', async () => {
    async function* failingStream() {
      yield { type: 'message_start', message: { usage: { input_tokens: 5 } } };
      throw Object.assign(new Error('stream broke'), { status: 500 });
    }

    mockCreate.mockResolvedValue(failingStream());

    try {
      await collectChunks(provider.generate(baseRequest()));
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ModelError);
      const err = e as ModelError;
      expect(err.provider).toBe('anthropic');
      expect(err.statusCode).toBe(500);
      expect(err.retryable).toBe(true);
    }
  });
});
