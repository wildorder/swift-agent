import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ModelRequest, ModelStreamChunk, ToolSchema } from '../../types.js';
import { createOpenAIProvider } from '../openai.js';
import { createAnthropicProvider } from '../anthropic.js';
import { createGoogleProvider } from '../google.js';

// ---------------------------------------------------------------------------
// SDK mocks — one file exercises all three providers' request builders.
// ---------------------------------------------------------------------------

const mockOpenAICreate = vi.fn();
const mockAnthropicCreate = vi.fn();
const mockGoogleStream = vi.fn();
const mockGetGenerativeModel = vi.fn(() => ({ generateContentStream: mockGoogleStream }));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockOpenAICreate } };
  },
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockAnthropicCreate };
  },
}));

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class MockGoogleGenAI {
    getGenerativeModel = mockGetGenerativeModel;
  },
}));

vi.mock('nanoid', () => ({ nanoid: () => 'synthetic' }));

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

const TOOL: ToolSchema = {
  name: 'get_weather',
  description: 'Get the weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
};

// A request that both defines the tool AND carries a prior tool result, so we
// can assert translation and result-correlation in one pass.
function requestWithToolResult(): ModelRequest {
  return {
    model: 'test-model',
    messages: [
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ callId: 'call_native_123', toolName: 'get_weather', arguments: { city: 'NYC' } }],
      },
      {
        role: 'tool',
        content: JSON.stringify({ tempF: 70 }),
        toolCallId: 'call_native_123',
        toolName: 'get_weather',
      },
    ],
    tools: [TOOL],
  };
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

describe('OpenAI tool contract', () => {
  beforeEach(() => mockOpenAICreate.mockReset());

  function toolOnlyStream() {
    return asyncIter([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_native_123', function: { name: 'get_weather', arguments: '{"city":"NYC"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: null,
      },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
    ]);
  }

  it('translates the tool to OpenAI function shape', async () => {
    mockOpenAICreate.mockResolvedValue(toolOnlyStream());
    const provider = createOpenAIProvider({ apiKey: 'k' });
    await collectChunks(provider.generate(requestWithToolResult()));

    const [params] = mockOpenAICreate.mock.calls[0] as [Record<string, unknown>];
    expect(params.tools).toEqual([
      { type: 'function', function: { name: TOOL.name, description: TOOL.description, parameters: TOOL.parameters } },
    ]);
  });

  it('correlates the tool result by provider call id (tool_call_id)', async () => {
    mockOpenAICreate.mockResolvedValue(toolOnlyStream());
    const provider = createOpenAIProvider({ apiKey: 'k' });
    await collectChunks(provider.generate(requestWithToolResult()));

    const [params] = mockOpenAICreate.mock.calls[0] as [{ messages: Array<Record<string, unknown>> }];
    const toolMsg = params.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toMatchObject({ role: 'tool', tool_call_id: 'call_native_123' });
  });

  it('always emits a terminal finish chunk for a tool-only response', async () => {
    mockOpenAICreate.mockResolvedValue(toolOnlyStream());
    const provider = createOpenAIProvider({ apiKey: 'k' });
    const chunks = await collectChunks(provider.generate(requestWithToolResult()));
    expect(chunks.at(-1)).toHaveProperty('type', 'finish');
    expect(chunks.some((c) => c.type === 'tool_call')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

describe('Anthropic tool contract', () => {
  beforeEach(() => mockAnthropicCreate.mockReset());

  function toolOnlyStream() {
    return asyncIter([
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city":"NYC"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ]);
  }

  it('translates the tool to Anthropic input_schema shape', async () => {
    mockAnthropicCreate.mockResolvedValue(toolOnlyStream());
    const provider = createAnthropicProvider({ apiKey: 'k' });
    await collectChunks(provider.generate(requestWithToolResult()));

    const [params] = mockAnthropicCreate.mock.calls[0] as [{ tools: Array<Record<string, unknown>> }];
    expect(params.tools).toEqual([
      {
        name: TOOL.name,
        description: TOOL.description,
        input_schema: { type: 'object', ...TOOL.parameters },
      },
    ]);
  });

  it('correlates the tool result by provider call id (tool_use_id)', async () => {
    mockAnthropicCreate.mockResolvedValue(toolOnlyStream());
    const provider = createAnthropicProvider({ apiKey: 'k' });
    await collectChunks(provider.generate(requestWithToolResult()));

    const [params] = mockAnthropicCreate.mock.calls[0] as [{ messages: Array<{ role: string; content: unknown }> }];
    const toolResultBlock = params.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((b: Record<string, unknown>) => b.type === 'tool_result');
    expect(toolResultBlock).toMatchObject({ type: 'tool_result', tool_use_id: 'call_native_123' });
  });

  it('always emits a terminal finish chunk for a tool-only response', async () => {
    mockAnthropicCreate.mockResolvedValue(toolOnlyStream());
    const provider = createAnthropicProvider({ apiKey: 'k' });
    const chunks = await collectChunks(provider.generate(requestWithToolResult()));
    expect(chunks.at(-1)).toHaveProperty('type', 'finish');
    expect(chunks.some((c) => c.type === 'tool_call')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

describe('Google tool contract', () => {
  beforeEach(() => {
    mockGoogleStream.mockReset();
    mockGetGenerativeModel.mockClear();
  });

  function toolOnlyStream() {
    return {
      stream: asyncIter([
        {
          candidates: [
            {
              content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'NYC' } } }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
        },
      ]),
    };
  }

  it('translates the tool to Google functionDeclarations shape', async () => {
    mockGoogleStream.mockResolvedValue(toolOnlyStream());
    const provider = createGoogleProvider({ apiKey: 'k' });
    await collectChunks(provider.generate(requestWithToolResult()));

    const [args] = mockGoogleStream.mock.calls[0] as [{ tools: Array<{ functionDeclarations: unknown[] }> }];
    expect(args.tools).toEqual([
      { functionDeclarations: [{ name: TOOL.name, description: TOOL.description, parameters: TOOL.parameters }] },
    ]);
  });

  it('correlates the tool result by function NAME, not the synthesized id', async () => {
    mockGoogleStream.mockResolvedValue(toolOnlyStream());
    const provider = createGoogleProvider({ apiKey: 'k' });
    await collectChunks(provider.generate(requestWithToolResult()));

    const [args] = mockGoogleStream.mock.calls[0] as [{ contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> }];
    const fnResponsePart = args.contents
      .flatMap((c) => c.parts)
      .find((p) => 'functionResponse' in p);
    const functionResponse = (fnResponsePart as { functionResponse: { name: string } }).functionResponse;
    expect(functionResponse.name).toBe('get_weather');
    expect(functionResponse.name).not.toBe('call_native_123');
  });

  it('always emits a terminal finish chunk for a tool-only response', async () => {
    mockGoogleStream.mockResolvedValue(toolOnlyStream());
    const provider = createGoogleProvider({ apiKey: 'k' });
    const chunks = await collectChunks(provider.generate(requestWithToolResult()));
    expect(chunks.at(-1)).toHaveProperty('type', 'finish');
    expect(chunks.some((c) => c.type === 'tool_call')).toBe(true);
  });
});
