#!/usr/bin/env node
// Publish dry-run gate for the three publishable packages (WS-38).
//
// Runs `pnpm pack` for @swiftagent/{sdk,react,shared}, then asserts on each
// produced tarball WITHOUT touching a live registry — this exercises everything
// up to the actual upload. Kept as a single committed command so the CI gate
// (.github/workflows/ci.yml) and the local check never diverge:
//
//     node scripts/verify-pack.mjs
//
// Assertions (see tasks/sdk-dev-ux/ws-38-package-publishing-pipeline.md §Tests):
//   1. Tarball ships every path the `exports` map references (JS + d.ts), plus
//      README.md and package.json — and NOTHING else forbidden (src/, tests,
//      tsconfig, .turbo/, CommonJS *.cjs).
//   2. `workspace:*` deps were rewritten to a concrete version at pack time.
//   3. Dual ESM JS + type-declaration outputs are present for every entry point.
//   4. Publish metadata is correct: no `private`, public npm registry
//      (registry.npmjs.org) with `access: public` and `license: Apache-2.0`
//      (WS-44 public posture), `files` allowlist, non-empty
//      repository/license/description; and the exports/main/types block is
//      byte-identical to the on-disk source.
//   5. Each tarball ships `package/LICENSE` and `package/NOTICE`, byte-identical
//      to the repository-root files (Apache-2.0 §4(a) requires the license to
//      travel with every distributed copy; identity prevents silent drift).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REGISTRY = 'https://registry.npmjs.org';
const ACCESS = 'public';
const LICENSE_ID = 'Apache-2.0';
// pnpm is a `.cmd` shim on Windows; name it explicitly so execFileSync resolves
// it without a shell (CI runs on Linux where the bare name is correct).
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

const PACKAGES = [
  { name: '@swiftagent/sdk', dir: 'packages/sdk' },
  { name: '@swiftagent/react', dir: 'packages/react' },
  { name: '@swiftagent/shared', dir: 'packages/shared' },
];

/** @type {string[]} */
const failures = [];
const fail = (pkg, msg) => failures.push(`  ✗ [${pkg}] ${msg}`);
const ok = (pkg, msg) => console.log(`  ✓ [${pkg}] ${msg}`);

function run(cmd, args, cwd = ROOT) {
  // shell:true is required for Windows `.cmd` shims (pnpm) under current Node;
  // all args here are space-free and shell-safe on both cmd.exe and /bin/sh.
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true });
}

// Collect the dist/* paths an exports map references, split into js vs types.
function entryPointsFromExports(exportsMap) {
  const js = new Set();
  const types = new Set();
  const walk = (node) => {
    if (typeof node === 'string') {
      if (node.endsWith('.d.ts')) types.add(node.replace(/^\.\//, 'package/'));
      else if (node.endsWith('.js')) js.add(node.replace(/^\.\//, 'package/'));
      return;
    }
    if (node && typeof node === 'object') for (const v of Object.values(node)) walk(v);
  };
  walk(exportsMap);
  return { js: [...js], types: [...types] };
}

function verifyTarball(pkg, tarball, tmp) {
  const list = run('tar', ['--force-local', '-tzf', tarball])
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    // pnpm emits a spurious `package/./dist/index.js` alias alongside the real
    // `package/dist/index.js`; normalise it so path checks are unambiguous.
    .map((l) => l.replace('package/./', 'package/'));

  const packedJson = JSON.parse(run('tar', ['--force-local', '-xzOf', tarball, 'package/package.json']));
  const sourceJson = JSON.parse(readFileSync(join(ROOT, pkg.dir, 'package.json'), 'utf8'));

  // ── §1/§3: entry points from the exports map ship both JS and d.ts ──
  const { js, types } = entryPointsFromExports(packedJson.exports ?? {});
  for (const f of [...js, ...types]) {
    if (list.includes(f)) ok(pkg.name, `ships ${f.replace('package/', '')}`);
    else fail(pkg.name, `missing exports target ${f.replace('package/', '')}`);
  }
  if (!list.includes('package/README.md')) fail(pkg.name, 'missing README.md');
  if (!list.includes('package/package.json')) fail(pkg.name, 'missing package.json');

  // ── §1/§3: forbidden content must NOT leak into the tarball ──
  const forbidden = list.filter(
    (f) =>
      f.startsWith('package/src/') ||
      /\.test\.(js|d\.ts)$/.test(f) ||
      /(^|\/)__tests__\//.test(f) ||
      /tsconfig.*\.json$/.test(f) ||
      f.includes('/.turbo/') ||
      f.endsWith('.cjs'),
  );
  if (forbidden.length) fail(pkg.name, `forbidden files in tarball: ${forbidden.join(', ')}`);
  else ok(pkg.name, 'no src/tests/tsconfig/.turbo/CJS leaked');

  // ── §2: workspace:* rewritten to a concrete version ──
  const shared = packedJson.dependencies?.['@swiftagent/shared'];
  if (shared !== undefined) {
    if (shared === 'workspace:*' || shared.startsWith('workspace:'))
      fail(pkg.name, `@swiftagent/shared not resolved (still "${shared}")`);
    else if (/^[\^~]?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(shared))
      ok(pkg.name, `@swiftagent/shared resolved to concrete "${shared}"`);
    else fail(pkg.name, `@swiftagent/shared has unexpected version "${shared}"`);
  }

  // ── §4: publish metadata correctness ──
  if ('private' in packedJson) fail(pkg.name, 'packed manifest still has "private"');
  if (packedJson.publishConfig?.registry !== REGISTRY)
    fail(pkg.name, `publishConfig.registry is "${packedJson.publishConfig?.registry}", expected ${REGISTRY}`);
  if (packedJson.publishConfig?.access !== ACCESS)
    fail(pkg.name, `publishConfig.access is "${packedJson.publishConfig?.access}", expected "${ACCESS}"`);
  if (packedJson.license !== LICENSE_ID)
    fail(pkg.name, `license is "${packedJson.license}", expected "${LICENSE_ID}"`);
  if (!Array.isArray(packedJson.files) || !packedJson.files.includes('dist') || !packedJson.files.includes('README.md'))
    fail(pkg.name, 'files allowlist must contain "dist" and "README.md"');

  // ── §5: LICENSE + NOTICE ship in the tarball, byte-identical to the root ──
  for (const legal of ['LICENSE', 'NOTICE']) {
    if (!list.includes(`package/${legal}`)) {
      fail(pkg.name, `missing ${legal} in tarball`);
      continue;
    }
    const packed = run('tar', ['--force-local', '-xzOf', tarball, `package/${legal}`]);
    const root = readFileSync(join(ROOT, legal), 'utf8');
    if (packed === root) ok(pkg.name, `${legal} byte-identical to root ${legal}`);
    else fail(pkg.name, `${legal} in tarball differs from root ${legal} (copies drifted)`);
  }
  for (const field of ['repository', 'license', 'description', 'author']) {
    const v = packedJson[field];
    if (!v || (typeof v === 'object' && Object.keys(v).length === 0)) fail(pkg.name, `empty/missing "${field}"`);
  }

  // ── §4: exports/main/types byte-identical to the on-disk (WS-36-owned) source ──
  for (const field of ['exports', 'main', 'types']) {
    if (JSON.stringify(packedJson[field]) !== JSON.stringify(sourceJson[field]))
      fail(pkg.name, `packed "${field}" differs from on-disk source (WS-36 surface perturbed)`);
  }
  ok(pkg.name, 'metadata + surface correct');
}

function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'sa-pack-'));
  console.log(`Packing into ${tmp}\n`);

  for (const pkg of PACKAGES) {
    console.log(`── ${pkg.name} ──`);
    // `pnpm pack` has no --filter form; run it from the package directory.
    run(PNPM, ['pack', '--pack-destination', tmp], join(ROOT, pkg.dir));
    const tarball = readdirSync(tmp)
      .filter((f) => f.endsWith('.tgz'))
      .map((f) => join(tmp, f))
      .find((f) => f.includes(pkg.name.split('/')[1]));
    if (!tarball) {
      fail(pkg.name, 'no tarball produced by pnpm pack');
      continue;
    }
    verifyTarball(pkg, tarball, tmp);
    console.log('');
  }

  if (failures.length) {
    console.error('\nPACK DRY-RUN FAILED:\n' + failures.join('\n'));
    process.exit(1);
  }
  console.log('Pack dry-run gate: all assertions passed. ✓');
}

main();
