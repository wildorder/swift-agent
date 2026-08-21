import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  createReadlinePrompter,
  parseCliArgs,
  resolveOptions,
  type Prompter,
} from '../options.js';

/**
 * The interactive path is driven via injected prompters/streams — no real TTY
 * anywhere in this file (SC-06).
 */

/** A scripted prompter: answers each question from a fixed queue. */
function scriptedPrompter(answers: string[]): Prompter & { asked: string[]; closed: boolean } {
  const queue = [...answers];
  const prompter = {
    asked: [] as string[],
    closed: false,
    question(query: string): Promise<string> {
      prompter.asked.push(query);
      const next = queue.shift();
      if (next === undefined) throw new Error(`prompt with no scripted answer: ${query}`);
      return Promise.resolve(next);
    },
    write(_message: string): void {
      /* discard notices */
    },
    close(): void {
      prompter.closed = true;
    },
  };
  return prompter;
}

describe('parseCliArgs', () => {
  it('parses positional name plus flags', () => {
    const parsed = parseCliArgs([
      'my-agent',
      '--provider',
      'openai',
      '--provider-key',
      'sk-x',
      '--yes',
    ]);
    expect(parsed).toMatchObject({
      name: 'my-agent',
      provider: 'openai',
      providerKey: 'sk-x',
      yes: true,
      install: true,
      help: false,
    });
  });

  it('parses --name and --no-install', () => {
    const parsed = parseCliArgs(['--name', 'my-agent', '--no-install']);
    expect(parsed.name).toBe('my-agent');
    expect(parsed.install).toBe(false);
  });

  it('rejects conflicting positional and --name values', () => {
    expect(() => parseCliArgs(['one', '--name', 'two'])).toThrow(/Conflicting project names/);
  });

  it('rejects extra positionals', () => {
    expect(() => parseCliArgs(['one', 'two'])).toThrow(/Unexpected extra arguments/);
  });
});

describe('resolveOptions (non-interactive)', () => {
  it('resolves flags without any prompter', async () => {
    const resolved = await resolveOptions(
      parseCliArgs(['my-agent', '--provider', 'google', '--provider-key', 'g-key', '--yes']),
      null,
    );
    expect(resolved).toEqual({ name: 'my-agent', provider: 'google', providerKey: 'g-key' });
  });

  it('defaults the provider to anthropic', async () => {
    const resolved = await resolveOptions(parseCliArgs(['my-agent', '--yes']), null);
    expect(resolved.provider).toBe('anthropic');
    expect(resolved.providerKey).toBeUndefined();
  });

  it('never blocks: a missing name throws with a clear message', async () => {
    await expect(resolveOptions(parseCliArgs(['--yes']), null)).rejects.toThrow(
      /project name is required in non-interactive mode/,
    );
  });

  it('rejects an unknown provider', async () => {
    await expect(resolveOptions(parseCliArgs(['x', '--provider', 'nope']), null)).rejects.toThrow(
      /Unknown provider "nope"/,
    );
  });

  it('rejects an invalid project name', async () => {
    await expect(resolveOptions(parseCliArgs(['Bad Name!', '--yes']), null)).rejects.toThrow(
      /Invalid project name/,
    );
  });
});

describe('resolveOptions (interactive, injected prompter)', () => {
  it('collects name, provider, and key from prompts', async () => {
    const prompter = scriptedPrompter(['my-agent', 'openai', 'sk-test']);
    const resolved = await resolveOptions(parseCliArgs([]), prompter);
    expect(resolved).toEqual({ name: 'my-agent', provider: 'openai', providerKey: 'sk-test' });
    expect(prompter.asked).toHaveLength(3);
    expect(prompter.closed).toBe(true);
  });

  it('applies defaults on empty answers and resolves identically to flags', async () => {
    const prompted = await resolveOptions(parseCliArgs([]), scriptedPrompter(['my-agent', '', '']));
    const flagged = await resolveOptions(parseCliArgs(['my-agent', '--yes']), null);
    expect(prompted).toEqual(flagged);
  });

  it('re-prompts on an invalid name or provider, then accepts valid ones', async () => {
    const prompter = scriptedPrompter(['Bad Name!', 'good-name', 'not-a-provider', 'google', '']);
    const resolved = await resolveOptions(parseCliArgs([]), prompter);
    expect(resolved).toEqual({ name: 'good-name', provider: 'google', providerKey: undefined });
    expect(prompter.asked).toHaveLength(5);
  });

  it('does not prompt for values already supplied as flags', async () => {
    const prompter = scriptedPrompter(['sk-g']);
    const resolved = await resolveOptions(
      parseCliArgs(['my-agent', '--provider', 'google']),
      prompter,
    );
    expect(resolved).toEqual({ name: 'my-agent', provider: 'google', providerKey: 'sk-g' });
    expect(prompter.asked).toHaveLength(1);
  });
});

describe('createReadlinePrompter (injected streams, no TTY)', () => {
  it('reads an answer line from the input stream', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const prompter = createReadlinePrompter(input, output);
    const pending = prompter.question('Project name: ');
    input.write('stream-agent\n');
    await expect(pending).resolves.toBe('stream-agent');
    prompter.close();
  });
});
