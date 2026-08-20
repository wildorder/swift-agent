import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * create-swift-agent · generation core (WS-46).
 *
 * Everything in this module is pure file-system + string work — no TTY, no
 * network — so the unit tests can drive it directly. The CLI (`cli.ts`) is a
 * thin flag/prompt shell around {@link generateProject}.
 *
 * Generation is copy + targeted substitution over the packaged `templates/`
 * tree (shipped via the `files` allowlist — templates are real files, not
 * string blobs). Two file names are stored under tooling-safe aliases and
 * renamed on generation, because `npm pack` unconditionally drops `.gitignore`
 * files and dot-env files are easy to trip tooling on:
 *
 *   `_gitignore`  → `.gitignore`
 *   `env.example` → `.env.example`
 */

export const PROVIDERS = {
  anthropic: { model: 'anthropic/claude-sonnet', keyEnv: 'ANTHROPIC_API_KEY' },
  openai: { model: 'openai/gpt-4o', keyEnv: 'OPENAI_API_KEY' },
  google: { model: 'google/gemini-1.5-flash', keyEnv: 'GOOGLE_API_KEY' },
} as const;

export type ProviderId = keyof typeof PROVIDERS;

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function isProviderId(value: string): value is ProviderId {
  return Object.hasOwn(PROVIDERS, value);
}

/**
 * Validate a directory-safe, npm-safe project name. Returns an error message
 * (never throws) or null when the name is valid.
 */
export function validateProjectName(name: string): string | null {
  if (!name) return 'Project name is required.';
  if (name.length > 100) return 'Project name must be 100 characters or fewer.';
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
    return (
      `Invalid project name "${name}": use lowercase letters, digits, ".", "_" and "-", ` +
      'starting with a letter or digit (it becomes a directory and an npm package name).'
    );
  }
  return null;
}

/** File-name aliases that keep templates from tripping packing/tooling. */
const RENAMES: Record<string, string> = {
  _gitignore: '.gitignore',
  'env.example': '.env.example',
};

export interface GenerateOptions {
  /** Validated project name — also the generated agent's registered name. */
  name: string;
  provider: ProviderId;
  /** Optional model-provider API key, written into the generated `.env` only. */
  providerKey?: string | undefined;
  /** Directory the project directory is created inside (usually `process.cwd()`). */
  targetDir: string;
  /** The packaged templates root (usually `<package>/templates`). */
  templatesDir: string;
}

export interface GenerateResult {
  projectDir: string;
  /** Project-relative paths of every file written, sorted. */
  files: string[];
}

function substitute(content: string, vars: Record<string, string>): string {
  let out = content;
  for (const [token, value] of Object.entries(vars)) {
    out = out.replaceAll(token, value);
  }
  return out;
}

function copyTree(
  srcDir: string,
  destDir: string,
  vars: Record<string, string>,
  written: string[],
  relBase: string,
): void {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = join(srcDir, entry.name);
    const destName = RENAMES[entry.name] ?? entry.name;
    const rel = relBase ? `${relBase}/${destName}` : destName;
    if (entry.isDirectory()) {
      copyTree(srcPath, join(destDir, destName), vars, written, rel);
      continue;
    }
    const rendered = substitute(readFileSync(srcPath, 'utf8'), vars);
    writeFileSync(join(destDir, destName), rendered, 'utf8');
    written.push(rel);
  }
}

/**
 * Generate a project from the canonical template. Throws an `Error` with a
 * clear, actionable message on an invalid name or an existing directory.
 */
export function generateProject(opts: GenerateOptions): GenerateResult {
  const nameError = validateProjectName(opts.name);
  if (nameError) throw new Error(nameError);

  const provider = PROVIDERS[opts.provider];
  const projectDir = join(opts.targetDir, opts.name);
  if (existsSync(projectDir)) {
    throw new Error(
      `Directory "${opts.name}" already exists in ${opts.targetDir} — ` +
        'choose a different project name or remove the existing directory.',
    );
  }
  if (!existsSync(opts.templatesDir)) {
    throw new Error(`Template directory not found: ${opts.templatesDir} (broken installation?)`);
  }

  const vars: Record<string, string> = {
    __PROJECT_NAME__: opts.name,
    __DEFAULT_MODEL__: provider.model,
    __PROVIDER_KEY_ENV__: provider.keyEnv,
  };

  const files: string[] = [];
  try {
    copyTree(opts.templatesDir, projectDir, vars, files, '');

    // The real `.env` (never committed — the generated .gitignore covers it):
    // the rendered .env.example with the collected provider key filled in.
    const envExample = readFileSync(join(projectDir, '.env.example'), 'utf8');
    const env = opts.providerKey
      ? envExample.replace(`${provider.keyEnv}=`, `${provider.keyEnv}=${opts.providerKey}`)
      : envExample;
    writeFileSync(join(projectDir, '.env'), env, 'utf8');
    files.push('.env');
  } catch (err) {
    // Leave no half-written project behind on failure (best effort).
    try {
      rmSync(projectDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    throw err;
  }

  files.sort();
  return { projectDir, files };
}
