import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateProject, validateProjectName } from '../generate.js';

const TEMPLATES_DIR = join(fileURLToPath(new URL('../..', import.meta.url)), 'templates');

let targetDir: string;

beforeEach(() => {
  targetDir = mkdtempSync(join(tmpdir(), 'csa-gen-'));
});

afterEach(() => {
  rmSync(targetDir, { recursive: true, force: true });
});

describe('validateProjectName', () => {
  it('accepts directory-safe names', () => {
    expect(validateProjectName('my-agent')).toBeNull();
    expect(validateProjectName('agent2.x_y')).toBeNull();
  });

  it('rejects unsafe names with a clear message', () => {
    expect(validateProjectName('')).toMatch(/required/);
    expect(validateProjectName('My Agent')).toMatch(/Invalid project name/);
    expect(validateProjectName('-lead')).toMatch(/Invalid project name/);
    expect(validateProjectName('../escape')).toMatch(/Invalid project name/);
  });
});

describe('generateProject', () => {
  it('produces the full tree with the name substituted (SC-06)', () => {
    const { projectDir, files } = generateProject({
      name: 'my-agent',
      provider: 'anthropic',
      providerKey: 'sk-ant-test',
      targetDir,
      templatesDir: TEMPLATES_DIR,
    });

    // The full tree: backend, frontend, compose, env, README, gitignore.
    for (const expected of [
      'README.md',
      '.gitignore',
      '.env.example',
      '.env',
      'docker-compose.yml',
      'backend/package.json',
      'backend/tsconfig.json',
      'backend/eslint.config.js',
      'backend/src/server.ts',
      'frontend/package.json',
      'frontend/tsconfig.json',
      'frontend/eslint.config.js',
      'frontend/vite.config.ts',
      'frontend/index.html',
      'frontend/src/main.tsx',
      'frontend/src/App.tsx',
    ]) {
      expect(files, `expected ${expected} in generated file list`).toContain(expected);
      expect(existsSync(join(projectDir, expected)), `${expected} exists on disk`).toBe(true);
    }

    // Name substitution.
    const backendPkg = JSON.parse(readFileSync(join(projectDir, 'backend/package.json'), 'utf8'));
    expect(backendPkg.name).toBe('my-agent-backend');
    const frontendPkg = JSON.parse(readFileSync(join(projectDir, 'frontend/package.json'), 'utf8'));
    expect(frontendPkg.name).toBe('my-agent-frontend');
    const server = readFileSync(join(projectDir, 'backend/src/server.ts'), 'utf8');
    expect(server).toContain("name: 'my-agent'");
    expect(server).toContain("'anthropic/claude-sonnet'");
    expect(server).not.toContain('__PROJECT_NAME__');
    expect(readFileSync(join(projectDir, 'README.md'), 'utf8')).toContain('# my-agent');

    // No unsubstituted tokens anywhere.
    for (const rel of files) {
      const content = readFileSync(join(projectDir, rel), 'utf8');
      expect(content, `no template tokens left in ${rel}`).not.toMatch(/__[A-Z_]+__/);
    }
  });

  it('declares real semver @swiftagent/* deps — never workspace:*', () => {
    const { projectDir } = generateProject({
      name: 'semver-check',
      provider: 'anthropic',
      targetDir,
      templatesDir: TEMPLATES_DIR,
    });
    const backendPkg = JSON.parse(readFileSync(join(projectDir, 'backend/package.json'), 'utf8'));
    const frontendPkg = JSON.parse(readFileSync(join(projectDir, 'frontend/package.json'), 'utf8'));
    for (const [name, range] of [
      ...Object.entries(backendPkg.dependencies as Record<string, string>),
      ...Object.entries(frontendPkg.dependencies as Record<string, string>),
    ]) {
      expect(range, `${name} must be a real semver range`).not.toMatch(/workspace:|file:|link:/);
    }
    expect(backendPkg.dependencies['@swiftagent/sdk']).toMatch(/^\^?\d+\.\d+\.\d+/);
    expect(backendPkg.dependencies['@swiftagent/shared']).toMatch(/^\^?\d+\.\d+\.\d+/);
    expect(frontendPkg.dependencies['@swiftagent/react']).toMatch(/^\^?\d+\.\d+\.\d+/);
  });

  it('writes the provider key into .env only (never .env.example)', () => {
    const { projectDir } = generateProject({
      name: 'env-check',
      provider: 'openai',
      providerKey: 'sk-openai-secret',
      targetDir,
      templatesDir: TEMPLATES_DIR,
    });
    const env = readFileSync(join(projectDir, '.env'), 'utf8');
    expect(env).toContain('OPENAI_API_KEY=sk-openai-secret');
    const example = readFileSync(join(projectDir, '.env.example'), 'utf8');
    expect(example).toContain('OPENAI_API_KEY=');
    expect(example).not.toContain('sk-openai-secret');
    // .env is gitignored so the key is never committed.
    expect(readFileSync(join(projectDir, '.gitignore'), 'utf8')).toMatch(/^\.env$/m);
  });

  it('leaves the provider key line empty when no key is given', () => {
    const { projectDir } = generateProject({
      name: 'no-key',
      provider: 'google',
      targetDir,
      templatesDir: TEMPLATES_DIR,
    });
    expect(readFileSync(join(projectDir, '.env'), 'utf8')).toMatch(/^GOOGLE_API_KEY=$/m);
  });

  it('fails with a clear error on an existing directory and leaves it untouched', () => {
    mkdirSync(join(targetDir, 'taken'));
    expect(() =>
      generateProject({
        name: 'taken',
        provider: 'anthropic',
        targetDir,
        templatesDir: TEMPLATES_DIR,
      }),
    ).toThrow(/already exists/);
    expect(existsSync(join(targetDir, 'taken'))).toBe(true);
  });

  it('fails with a clear error on an invalid name', () => {
    expect(() =>
      generateProject({
        name: 'Bad Name',
        provider: 'anthropic',
        targetDir,
        templatesDir: TEMPLATES_DIR,
      }),
    ).toThrow(/Invalid project name/);
  });
});
