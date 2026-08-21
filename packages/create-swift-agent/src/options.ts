import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { PROVIDER_IDS, isProviderId, validateProjectName, type ProviderId } from './generate.js';

/**
 * create-swift-agent · flag parsing + prompt resolution (WS-46).
 *
 * Kept separate from the bin entry (`cli.ts`) so unit tests can drive both the
 * flag path and the interactive path with injected streams — no TTY, no
 * process.exit, no filesystem.
 *
 * Non-interactive contract (SC-06): with `--yes` — or when stdin is not a TTY —
 * resolution NEVER blocks on a prompt. Missing name → a thrown Error with a
 * clear message; missing provider → the default (`anthropic`).
 */

export interface CliOptions {
  name?: string | undefined;
  provider?: string | undefined;
  providerKey?: string | undefined;
  yes: boolean;
  install: boolean;
  help: boolean;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      provider: { type: 'string' },
      'provider-key': { type: 'string' },
      yes: { type: 'boolean', default: false },
      // parseArgs has no automatic `--no-` negation; declare it explicitly.
      'no-install': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.name !== undefined && positionals.length > 0 && positionals[0] !== values.name) {
    throw new Error(
      `Conflicting project names: positional "${positionals[0]}" vs --name "${values.name}".`,
    );
  }
  if (positionals.length > 1) {
    throw new Error(`Unexpected extra arguments: ${positionals.slice(1).join(' ')}`);
  }
  return {
    name: values.name ?? positionals[0],
    provider: values.provider,
    providerKey: values['provider-key'],
    yes: values.yes,
    install: !values['no-install'],
    help: values.help,
  };
}

export interface ResolvedOptions {
  name: string;
  provider: ProviderId;
  providerKey: string | undefined;
}

/**
 * The prompt seam: the CLI passes a readline-backed prompter
 * ({@link createReadlinePrompter}); tests pass a scripted one. `null` means
 * non-interactive — resolution then never blocks on anything.
 */
export interface Prompter {
  question(query: string): Promise<string>;
  write(message: string): void;
  close(): void;
}

/** Readline-backed prompter over arbitrary streams (the CLI uses stdin/stdout). */
export function createReadlinePrompter(input: Readable, output: Writable): Prompter {
  const rl = createInterface({ input, output });
  return {
    question: (query) => rl.question(query),
    write: (message) => {
      output.write(message);
    },
    close: () => rl.close(),
  };
}

export const DEFAULT_PROVIDER: ProviderId = 'anthropic';

/**
 * Resolve name/provider/key from flags, prompting only when a prompter is
 * given. Throws with a clear message when a required value is missing or
 * invalid in non-interactive mode — never blocks waiting on a TTY.
 */
export async function resolveOptions(
  parsed: CliOptions,
  prompter: Prompter | null,
): Promise<ResolvedOptions> {
  let name = parsed.name;
  let provider: ProviderId | undefined;
  let providerKey = parsed.providerKey;

  if (parsed.provider !== undefined) {
    if (!isProviderId(parsed.provider)) {
      throw new Error(
        `Unknown provider "${parsed.provider}" — expected one of: ${PROVIDER_IDS.join(', ')}.`,
      );
    }
    provider = parsed.provider;
  }
  if (name !== undefined) {
    const err = validateProjectName(name);
    if (err) throw new Error(err);
  }

  if (!prompter) {
    if (name === undefined) {
      throw new Error(
        'A project name is required in non-interactive mode: ' +
          'create-swift-agent <name> [--provider anthropic|openai|google] [--provider-key <key>] --yes',
      );
    }
    return { name, provider: provider ?? DEFAULT_PROVIDER, providerKey };
  }

  try {
    while (name === undefined) {
      const answer = (await prompter.question('Project name: ')).trim();
      const err = validateProjectName(answer);
      if (err) {
        prompter.write(`${err}\n`);
        continue;
      }
      name = answer;
    }
    while (provider === undefined) {
      const answer = (
        await prompter.question(`Model provider (${PROVIDER_IDS.join('/')}) [${DEFAULT_PROVIDER}]: `)
      ).trim();
      if (answer === '') {
        provider = DEFAULT_PROVIDER;
      } else if (isProviderId(answer)) {
        provider = answer;
      } else {
        prompter.write(
          `Unknown provider "${answer}" — expected one of: ${PROVIDER_IDS.join(', ')}.\n`,
        );
      }
    }
    if (providerKey === undefined) {
      const answer = (
        await prompter.question('Provider API key (optional — written to .env, never committed): ')
      ).trim();
      providerKey = answer === '' ? undefined : answer;
    }
  } finally {
    prompter.close();
  }
  return { name, provider, providerKey };
}
