import { describe, it, expect } from 'vitest';
import { createToolFixtureProvider } from '../providers/tool-fixture.js';
import { ModelStreamChunkSchema } from '../types.js';
import type { ModelRequest, ModelStreamChunk } from '../types.js';

const config = { apiKey: 'fixture-provider-no-key' };

async function collect(req: ModelRequest): Promise<ModelStreamChunk[]> {
  const chunks: ModelStreamChunk[] = [];
  for await (const chunk of createToolFixtureProvider(config).generate(req)) {
    chunks.push(chunk);
  }
  return chunks;
}

const TURN0_REQUEST: ModelRequest = {
  model: 'fixture/tool-call',
  messages: [
    { role: 'system', content: 'local dev agent' },
    { role: 'user', content: 'ping' },
  ],
};

const TURN1_REQUEST: ModelRequest = {
  model: 'fixture/tool-call',
  messages: [
    { role: 'user', content: 'ping' },
    { role: 'assistant', content: '{"text":"","toolCalls":[]}' },
    { role: 'tool', content: '{"result":"hello"}', toolCallId: 'tc_1', toolName: 'local_echo' },
  ],
};

describe('tool-fixture provider', () => {
  it('turn 0: tokens, exactly one local_echo tool_call, then exactly one finish (in order)', async () => {
    const chunks = await collect(TURN0_REQUEST);

    // Every chunk parses under the shared stream-chunk contract.
    for (const chunk of chunks) {
      expect(ModelStreamChunkSchema.safeParse(chunk).success).toBe(true);
    }

    const tokens = chunks.filter((c) => c.type === 'token');
    const toolCalls = chunks.filter((c) => c.type === 'tool_call');
    const finishes = chunks.filter((c) => c.type === 'finish');

    expect(tokens.length).toBeGreaterThanOrEqual(1);
    expect(toolCalls).toHaveLength(1);
    expect(finishes).toHaveLength(1);

    const toolCall = toolCalls[0];
    if (toolCall.type !== 'tool_call') throw new Error('unreachable');
    expect(toolCall.toolName).toBe('local_echo');
    expect(toolCall.callId).toBeTruthy();
    expect(typeof toolCall.callId).toBe('string');
    expect(toolCall.arguments).toEqual({ message: 'hello from the local fixture', shout: false });

    // Ordering contract: token* → tool_call* → exactly one terminal finish.
    const kinds = chunks.map((c) => c.type);
    expect(kinds.indexOf('tool_call')).toBeGreaterThan(kinds.lastIndexOf('token') - tokens.length);
    expect(kinds[kinds.length - 1]).toBe('finish');
    expect(kinds.indexOf('tool_call')).toBeGreaterThan(kinds.indexOf('token'));
  });

  it('turn 1 (tool-role message present): tokens then finish {stop}, no tool_call', async () => {
    const chunks = await collect(TURN1_REQUEST);

    for (const chunk of chunks) {
      expect(ModelStreamChunkSchema.safeParse(chunk).success).toBe(true);
    }

    expect(chunks.filter((c) => c.type === 'tool_call')).toHaveLength(0);
    expect(chunks.filter((c) => c.type === 'token').length).toBeGreaterThan(0);

    const finishes = chunks.filter((c) => c.type === 'finish');
    expect(finishes).toHaveLength(1);
    const finish = finishes[0];
    if (finish.type !== 'finish') throw new Error('unreachable');
    expect(finish.finishReason).toBe('stop');
    expect(chunks[chunks.length - 1].type).toBe('finish');
  });

  it('is deterministic: identical requests produce chunk-for-chunk identical output', async () => {
    const first = await collect(TURN0_REQUEST);
    const second = await collect(TURN0_REQUEST);
    expect(second).toEqual(first);

    const firstFinal = await collect(TURN1_REQUEST);
    const secondFinal = await collect(TURN1_REQUEST);
    expect(secondFinal).toEqual(firstFinal);
  });

  it('throws if the abort signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(collect({ ...TURN0_REQUEST, signal: controller.signal })).rejects.toThrow(
      /aborted/,
    );
  });

  it('throws when aborted mid-stream', async () => {
    const controller = new AbortController();
    const stream = createToolFixtureProvider(config).generate({
      ...TURN1_REQUEST,
      signal: controller.signal,
    });
    const first = await stream.next();
    expect(first.done).toBe(false);
    controller.abort();
    await expect(async () => {
      for await (const _chunk of stream) {
        /* drain until the abort throws */
      }
    }).rejects.toThrow(/aborted/);
  });
});
