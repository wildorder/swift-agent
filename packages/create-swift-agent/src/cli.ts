#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import { PROVIDER_IDS, generateProject } from './generate.js';
import {
  DEFAULT_PROVIDER,
  createReadlinePrompter,
  parseCliArgs,
  resolveOptions,
  type CliOptions,
  type ResolvedOptions,
} from './options.js';

/**
 * create-swift-agent · bin entry (WS-46).
 *
 * This file is the `bin` target and ALWAYS runs `main()` when executed —
 * `npx create-swift-agent` invokes it through a `.bin` shim/symlink whose
 * argv[1] does not reliably equal the module's real path, so no
 * "run-when-invoked-directly" guard is used. All unit-testable logic lives in
 * `options.ts` (flags/prompts) and `generate.ts` (generation); tests import
 * those modules, never this one.
 *
 * Flags (all optional; missing values are prompted for on a TTY):
 *   [name] | --name <name>       project/agent name (directory-safe, validated)
 *   --provider <id>              anthropic | openai | google
 *   --provider-key <key>         model-provider API key → written into .env only
 *   --yes                        accept defaults; never prompt
 *   --no-install                 skip `npm install` in backend/ and frontend/
 *   --help                       usage
 */

const USAGE = `Usage: create-swift-agent [name] [options]

Scaffold a runnable Swift Agent project (SDK backend with one Zod-schema tool,
a Vite/React chat frontend, and a single-server local docker compose stack).

Options:
  --name <name>          project name (also accepted as the first positional)
  --provider <id>        model provider: ${PROVIDER_IDS.join(' | ')} (default: ${DEFAULT_PROVIDER})
  --provider-key <key>   provider API key — written into the generated .env only
  --yes                  non-interactive: accept defaults, never prompt
  --no-install           skip npm install in backend/ and frontend/
  --help                 show this help
`;

function npmInstall(dir: string, output: Writable): boolean {
  output.write(`\nInstalling dependencies in ${dir} …\n`);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['install', '--no-audit', '--no-fund'], {
    cwd: dir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  return result.status === 0;
}

async function main(argv: string[]): Promise<number> {
  let parsed: CliOptions;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    console.error(`create-swift-agent: ${(err as Error).message}`);
    console.error(USAGE);
    return 1;
  }
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }

  const interactive = !parsed.yes && process.stdin.isTTY === true;
  let resolved: ResolvedOptions;
  try {
    resolved = await resolveOptions(
      parsed,
      interactive ? createReadlinePrompter(process.stdin, process.stdout) : null,
    );
  } catch (err) {
    console.error(`create-swift-agent: ${(err as Error).message}`);
    return 1;
  }

  // dist/cli.js → package root → templates/ (shipped via the files allowlist).
  const templatesDir = join(fileURLToPath(new URL('..', import.meta.url)), 'templates');
  let projectDir: string;
  try {
    const result = generateProject({
      name: resolved.name,
      provider: resolved.provider,
      providerKey: resolved.providerKey,
      targetDir: process.cwd(),
      templatesDir,
    });
    projectDir = result.projectDir;
    console.log(`\nCreated ${resolved.name}/ (${result.files.length} files)`);
  } catch (err) {
    console.error(`create-swift-agent: ${(err as Error).message}`);
    return 1;
  }

  let installOk = true;
  if (parsed.install) {
    installOk =
      npmInstall(join(projectDir, 'backend'), process.stdout) &&
      npmInstall(join(projectDir, 'frontend'), process.stdout);
    if (!installOk) {
      console.error(
        'create-swift-agent: npm install failed — run it manually in backend/ and frontend/.',
      );
    }
  }

  console.log(`
Next steps:

  cd ${resolved.name}
  docker compose up -d        # postgres + redis + Swift Agent server + your agent backend
                              # (first run mints a dev API key into ./.swiftagent-local/)
  cd frontend && npm run dev  # open the printed Vite URL and chat

The compose stack runs the zero-key deterministic fixture model out of the box.
To use your real ${resolved.provider} model, set COMPOSE_AGENT_MODEL in .env —
see README.md for details.
`);
  return parsed.install && !installOk ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`create-swift-agent: unexpected error: ${String(err)}`);
    process.exit(1);
  },
);
