import { describe, it, expect } from 'vitest';
import { createEchoProvider } from '../echo.js';
import type { ModelRequest, ModelStreamChunk } from '../../types.js';

const config = { apiKey: 'unused' };

async function collect(req: ModelRequest): Promise<ModelStreamChunk[]> {
  const chunks: ModelStreamChunk[] = [];
  for await (const chunk of createEchoProvider(config).generate(req)) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('echo provider', () => {
  it('streams the last user message as tokens then a single finish', async () => {
    const chunks = await collect({
      model: 'echo/echo',
      messages: [
        { role: 'system', content: 'ignored' },
        { role: 'user', content: 'hello world' },
      ],
    });

    const tokens = chunks.filter((c) => c.type === 'token');
    const finishes = chunks.filter((c) => c.type === 'finish');

    expect(tokens.length).toBeGreaterThan(0);
    expect(finishes).toHaveLength(1);
    // Tokens concatenate back to the source (whitespace runs preserved).
    expect(tokens.map((t) => (t.type === 'token' ? t.text : '')).join('')).toBe('hello world');
    // finish is terminal (last chunk).
    expect(chunks[chunks.length - 1].type).toBe('finish');
  });

  it('always emits at least one token, even for an empty prompt', async () => {
    const chunks = await collect({
      model: 'echo/echo',
      messages: [{ role: 'user', content: '   ' }],
    });
    expect(chunks.filter((c) => c.type === 'token').length).toBeGreaterThan(0);
  });

  it('falls back to a default when there is no user message', async () => {
    const chunks = await collect({
      model: 'echo/echo',
      messages: [{ role: 'system', content: 'no user turn' }],
    });
    const text = chunks
      .filter((c) => c.type === 'token')
      .map((t) => (t.type === 'token' ? t.text : ''))
      .join('');
    expect(text).toBe('echo');
  });

  it('reports usage on the finish chunk', async () => {
    const chunks = await collect({
      model: 'echo/echo',
      messages: [{ role: 'user', content: 'one two three' }],
    });
    const finish = chunks.find((c) => c.type === 'finish');
    expect(finish?.type === 'finish' && finish.usage.outputTokens).toBeGreaterThan(0);
  });

  it('throws if the abort signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      collect({
        model: 'echo/echo',
        messages: [{ role: 'user', content: 'hi' }],
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/);
  });
});
