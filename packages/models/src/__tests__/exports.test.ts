import { describe, it, expect } from 'vitest';
import {
  type ModelProvider,
  type ModelRequest,
  type ModelStreamChunk,
  ModelError,
  normalizeError,
  parseModelString,
  formatModelString,
  ProviderRegistry,
  mergeSignals,
  ModelRequestSchema,
  ModelStreamChunkSchema,
} from '../index.js';

describe('package exports', () => {
  it('exports all expected types and values', () => {
    // Values (runtime exports)
    expect(ModelError).toBeDefined();
    expect(normalizeError).toBeTypeOf('function');
    expect(parseModelString).toBeTypeOf('function');
    expect(formatModelString).toBeTypeOf('function');
    expect(ProviderRegistry).toBeTypeOf('function');
    expect(mergeSignals).toBeTypeOf('function');
    expect(ModelRequestSchema).toBeDefined();
    expect(ModelStreamChunkSchema).toBeDefined();
  });

  it('ModelStreamChunk is narrowable via discriminated union', () => {
    const chunks: ModelStreamChunk[] = [
      { type: 'token', text: 'Hello' },
      { type: 'tool_call', toolName: 'search', callId: 'tc_1', arguments: { q: 'test' } },
      { type: 'finish', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } },
    ];

    for (const chunk of chunks) {
      switch (chunk.type) {
        case 'token':
          expect(chunk.text).toBeTypeOf('string');
          break;
        case 'tool_call':
          expect(chunk.toolName).toBeTypeOf('string');
          expect(chunk.callId).toBeTypeOf('string');
          break;
        case 'finish':
          expect(chunk.finishReason).toBeTypeOf('string');
          expect(chunk.usage).toBeDefined();
          break;
      }
    }
  });

  it('ModelProvider interface is implementable', async () => {
    const provider: ModelProvider = {
      async *generate(_req: ModelRequest): AsyncGenerator<ModelStreamChunk, void, undefined> {
        yield { type: 'token', text: 'hi' };
        yield { type: 'finish', finishReason: 'stop', usage: {} };
      },
    };

    const chunks: ModelStreamChunk[] = [];
    for await (const chunk of provider.generate({
      model: 'test',
      messages: [{ role: 'user', content: 'hello' }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveProperty('type', 'token');
    expect(chunks[1]).toHaveProperty('type', 'finish');
  });
});
