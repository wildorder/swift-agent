import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * SC-11 · Born-public posture: this package joins the four-package public
 * roster already carrying the WS-44 public-release posture — it is never swept.
 * (scripts/verify-pack.mjs asserts the same from the packed tarball.)
 */

const PKG_DIR = fileURLToPath(new URL('../..', import.meta.url));

describe('create-swift-agent package posture (SC-11)', () => {
  const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >;

  it('is unscoped so `npx create-swift-agent` resolves', () => {
    expect(pkg.name).toBe('create-swift-agent');
  });

  it('is born public-postured', () => {
    expect(pkg).not.toHaveProperty('private');
    expect(pkg.license).toBe('Apache-2.0');
    const publishConfig = pkg.publishConfig as Record<string, unknown>;
    expect(publishConfig.registry).toBe('https://registry.npmjs.org');
    expect(publishConfig.access).toBe('public');
  });

  it('maps the bin and ships dist + templates via the files allowlist', () => {
    expect(pkg.bin).toEqual({ 'create-swift-agent': './dist/cli.js' });
    const files = pkg.files as string[];
    for (const required of ['dist', 'templates', 'README.md', 'LICENSE', 'NOTICE']) {
      expect(files).toContain(required);
    }
  });

  it('has zero runtime dependencies (every dep ships to every npx user)', () => {
    expect(pkg.dependencies).toBeUndefined();
  });
});
