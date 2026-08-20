#!/usr/bin/env node
// WS-46 · create-swift-agent end-to-end proof (SC-06) — the committed command
// CI and local runs share:
//
//     node scripts/create-swift-agent-e2e.mjs
//
// Flow (real registry protocol end to end — never a file path):
//   1. build @swiftagent/{shared,sdk,react} + create-swift-agent
//   2. start the WS-45 Verdaccio registry and publish all four packages into it
//   3. in a temp dir, run `npx --registry <local> create-swift-agent my-agent
//      --provider anthropic --yes --no-install` with a FRESH npm cache, so npx
//      can only resolve the package through the registry protocol
//   4. npm-install the generated backend+frontend against the registry and
//      assert lockfile provenance (@swiftagent/* served by the local registry)
//   5. typecheck + build + lint the generated project (the no-restricted-imports
//      deep-import guard runs against real generated code)
//   6. build the server image from this repo, `docker compose up -d` the
//      GENERATED project's stack (single server service, WS-43 wiring +
//      self-provisioning bootstrap), wait for the backend to register, and
//      drive one streaming turn asserting tool_call_started AND
//      tool_call_completed (test/smoke/realtime-smoke.ts, REQUIRE_TOOLS=1)
//   7. tear everything down (compose down -v, registry stop) — guaranteed via
//      finally + signal handlers
//
// Knobs:
//   SWIFTAGENT_E2E_SKIP_STACK=1   stop after step 5 (no Docker) — debug only;
//                                 CI runs the full flow.
//   SWIFTAGENT_E2E_KEEP=1         keep the temp dir on exit (debugging).
//
// The registry is bound to 0.0.0.0 for the stack phase ONLY (the generated
// backend container npm-installs through the docker host-gateway). This is a
// CI/e2e context — see the SWIFTAGENT_LOCAL_REGISTRY_HOST note in
// scripts/local-registry.mjs.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const PORT = Number(process.env.SWIFTAGENT_LOCAL_REGISTRY_PORT ?? 4873);
const REGISTRY = `http://127.0.0.1:${PORT}`;
/** Registry URL as seen from inside the generated project's containers. */
const REGISTRY_FROM_CONTAINER = `http://host.docker.internal:${PORT}`;
const PROJECT_NAME = 'my-agent';
const SERVER_IMAGE = 'swift-agent-server:e2e';
const SKIP_STACK = process.env.SWIFTAGENT_E2E_SKIP_STACK === '1';
const KEEP = process.env.SWIFTAGENT_E2E_KEEP === '1';

const PUBLISH_DIRS = [
  'packages/shared',
  'packages/sdk',
  'packages/react',
  'packages/create-swift-agent',
];
const SCOPED = ['@swiftagent/shared', '@swiftagent/sdk', '@swiftagent/react'];

const log = (msg) => console.log(`[csa-e2e] ${msg}`);

/** Run a command, streaming output; throw on non-zero exit. */
function run(cmd, args, { cwd = ROOT, env = {}, label } = {}) {
  log(`$ ${label ?? [cmd, ...args].join(' ')}${cwd === ROOT ? '' : `  (in ${cwd})`}`);
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: true, // Windows .cmd shims; all args are shell-safe
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new Error(`command failed (exit=${result.status}): ${cmd} ${args.join(' ')}`);
  }
}

async function pollUntil(desc, timeoutMs, intervalMs, probe) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) {
      log(`ready: ${desc}`);
      return;
    }
    if (Date.now() > deadline) throw new Error(`timed out (${timeoutMs}ms) waiting for ${desc}`);
    await sleep(intervalMs);
  }
}

async function httpOk(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Assert @swiftagent/* entries in a consumer lockfile resolved from the local registry. */
function assertProvenance(consumerDir, names) {
  const lockPath = join(consumerDir, 'package-lock.json');
  if (!existsSync(lockPath)) throw new Error(`no package-lock.json in ${consumerDir}`);
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const entries = lock.packages ?? {};
  for (const name of names) {
    const entry = entries[`node_modules/${name}`];
    if (!entry) throw new Error(`lockfile ${lockPath} has no entry for ${name}`);
    if (typeof entry.resolved !== 'string' || !entry.resolved.startsWith(`${REGISTRY}/`)) {
      throw new Error(
        `PROVENANCE FAILURE: ${name} resolved from "${entry.resolved}" — expected ${REGISTRY}/…`,
      );
    }
    log(`provenance OK: ${name} ← ${entry.resolved}`);
  }
}

/**
 * npx provenance: the fresh cache's _cacache index must record the
 * create-swift-agent tarball as served by the local registry (with a fresh
 * cache and a local-or-404 registry rule, there is no other source — this
 * makes the mechanism visible in the transcript).
 */
function assertNpxProvenance(cacheDir) {
  const indexDir = join(cacheDir, '_cacache', 'index-v5');
  if (!existsSync(indexDir)) throw new Error(`npx cache index missing: ${indexDir}`);
  const stack = [indexDir];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(p);
        continue;
      }
      const content = readFileSync(p, 'utf8');
      if (content.includes('create-swift-agent') && content.includes(`127.0.0.1:${PORT}`)) {
        log(`npx provenance OK: cache index records create-swift-agent from ${REGISTRY}`);
        return;
      }
    }
  }
  throw new Error('npx provenance: no cache-index record of create-swift-agent from the local registry');
}

async function main() {
  // ── 1. Build the four publishable packages ─────────────────────────────────
  run(PNPM, [
    '--filter', '@swiftagent/sdk...',
    '--filter', '@swiftagent/react...',
    '--filter', 'create-swift-agent',
    'build',
  ]);

  const work = mkdtempSync(join(tmpdir(), 'csa-e2e-'));
  const npmCache = join(work, 'npm-cache'); // FRESH cache: no stale-cache masking
  const consumerBase = join(work, 'consumer');
  const projectDir = join(consumerBase, PROJECT_NAME);
  // Isolated userconfig: pin the registry + the dummy token Verdaccio ignores,
  // and shield the run from any global ~/.npmrc.
  const npmrc = join(work, 'npmrc');
  writeFileSync(
    npmrc,
    `registry=${REGISTRY}/\n//127.0.0.1:${PORT}/:_authToken=swiftagent-local-dummy\n`,
    'utf8',
  );
  const npmEnv = {
    npm_config_registry: `${REGISTRY}/`,
    npm_config_cache: npmCache,
    npm_config_userconfig: npmrc,
  };

  let registryStarted = false;
  let composeUp = false;
  const composeEnv = {
    SWIFT_AGENT_SERVER_IMAGE: SERVER_IMAGE,
    NPM_CONFIG_REGISTRY: `${REGISTRY_FROM_CONTAINER}/`,
  };

  const teardown = async () => {
    if (composeUp) {
      try {
        run('docker', ['compose', 'down', '-v', '--remove-orphans'], {
          cwd: projectDir,
          env: composeEnv,
        });
      } catch (err) {
        console.error(`[csa-e2e] compose teardown failed: ${err.message}`);
      }
      composeUp = false;
    }
    if (registryStarted) {
      try {
        run('node', ['scripts/local-registry.mjs', 'stop']);
      } catch (err) {
        console.error(`[csa-e2e] registry teardown failed: ${err.message}`);
      }
      registryStarted = false;
    }
    if (!KEEP) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    else log(`kept temp dir: ${work}`);
  };
  const onSignal = () => {
    void teardown().finally(() => process.exit(130));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    // ── 2. Registry up + publish all four packages into it ───────────────────
    run('node', ['scripts/local-registry.mjs', 'start'], {
      env: SKIP_STACK ? {} : { SWIFTAGENT_LOCAL_REGISTRY_HOST: '0.0.0.0' },
    });
    registryStarted = true;
    run('node', ['scripts/local-registry.mjs', 'publish', ...PUBLISH_DIRS]);

    // ── 3. REAL npx resolution against the registry (never a file path) ──────
    mkdirSync(consumerBase, { recursive: true });
    run(
      NPX,
      [
        '--yes',
        '--registry', `${REGISTRY}/`,
        'create-swift-agent',
        PROJECT_NAME,
        '--provider', 'anthropic',
        '--provider-key', 'test-key-not-real',
        '--yes',
        '--no-install',
      ],
      { cwd: consumerBase, env: npmEnv },
    );
    for (const f of ['docker-compose.yml', '.env', 'backend/src/server.ts', 'frontend/src/App.tsx']) {
      if (!existsSync(join(projectDir, f))) throw new Error(`generated project missing ${f}`);
    }
    log(`generated project OK: ${projectDir}`);
    assertNpxProvenance(npmCache);

    // ── 4. Install the generated project FROM the registry + provenance ──────
    run(NPM, ['install', '--no-audit', '--no-fund'], { cwd: join(projectDir, 'backend'), env: npmEnv });
    run(NPM, ['install', '--no-audit', '--no-fund'], { cwd: join(projectDir, 'frontend'), env: npmEnv });
    assertProvenance(join(projectDir, 'backend'), ['@swiftagent/sdk', '@swiftagent/shared']);
    assertProvenance(join(projectDir, 'frontend'), ['@swiftagent/react', '@swiftagent/shared']);

    // ── 5. Generated project gates: typecheck, build, lint (guard active) ────
    for (const part of ['backend', 'frontend']) {
      const cwd = join(projectDir, part);
      run(NPM, ['run', 'typecheck'], { cwd, env: npmEnv });
      run(NPM, ['run', 'build'], { cwd, env: npmEnv });
      run(NPM, ['run', 'lint'], { cwd, env: npmEnv });
    }
    log('generated project installs, type-checks, builds, and lints ✓');

    if (SKIP_STACK) {
      log('SWIFTAGENT_E2E_SKIP_STACK=1 — skipping the compose/streaming phase');
      return;
    }

    // ── 6. The generated stack: compose up → bootstrap → streaming tool turn ─
    // The host-side install above recorded lockfile `resolved` URLs at
    // 127.0.0.1:<port>, which the backend CONTAINER cannot reach (its loopback
    // is the server's netns) — and npm honors resolved URLs over the
    // configured registry. Drop the lock so the container re-resolves through
    // NPM_CONFIG_REGISTRY (the same Verdaccio registry, via the docker
    // host-gateway). Real users never hit this: their lockfiles resolve to
    // registry.npmjs.org, reachable from everywhere.
    rmSync(join(projectDir, 'backend', 'package-lock.json'), { force: true });
    run('docker', ['build', '-f', 'apps/server/Dockerfile', '-t', SERVER_IMAGE, '.']);
    // Mark the stack up BEFORE `up` runs: `up -d` failing on a one-shot
    // service (e.g. bootstrap exit 1) still leaves containers behind that
    // teardown must remove — and their logs are the diagnostics we need.
    composeUp = true;
    try {
      run('docker', ['compose', 'up', '-d'], { cwd: projectDir, env: composeEnv });
    } catch (err) {
      try {
        run('docker', ['compose', 'logs', '--tail', '150'], { cwd: projectDir, env: composeEnv });
      } catch {
        /* diagnostics only */
      }
      throw err;
    }

    const keyFile = join(projectDir, '.swiftagent-local', 'dev-api-key');
    try {
      await pollUntil('bootstrap-minted dev API key', 240_000, 2_000, () =>
        Promise.resolve(existsSync(keyFile)),
      );
      // The backend container npm-installs (through the registry) then
      // registers the agent and opens /api/session — poll it, bounded.
      await pollUntil('generated backend /api/session', 360_000, 3_000, () =>
        httpOk('http://127.0.0.1:4000/api/session'),
      );

      // One streaming turn with a REAL tool round trip: message_started →
      // token(s) → tool_call_started → tool_call_completed(completed) →
      // message_completed (bounded waits; WS-43 smoke module).
      run(PNPM, ['exec', 'tsx', 'test/smoke/realtime-smoke.ts'], {
        env: {
          SMOKE_BASE_URL: 'http://localhost:3000',
          SMOKE_AGENT_NAME: PROJECT_NAME,
          SMOKE_API_KEY_FILE: keyFile,
          REQUIRE_TOOLS: '1',
        },
      });
    } catch (err) {
      // Dump the stack's logs BEFORE teardown so a red run is debuggable.
      try {
        run('docker', ['compose', 'logs', '--tail', '150'], { cwd: projectDir, env: composeEnv });
      } catch {
        /* diagnostics only */
      }
      throw err;
    }
    log('E2E PASSED — npx via registry, install provenance, generated gates, streaming tool turn ✓');
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await teardown();
  }
}

main().catch((err) => {
  console.error(`[csa-e2e] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
