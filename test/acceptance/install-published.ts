import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * WS-42 · GitHub Packages install harness — the SC-09 install PROOF.
 *
 * A REAL GitHub Packages install is the SOLE path that satisfies SC-09: there is
 * NO local-tarball stand-in. This harness (a) makes a throwaway consumer dir
 * OUTSIDE the workspace (so `workspace:*` is not short-circuited and the real
 * registry tarball is fetched by plain `npm`), (b) discovers which dist-tag to
 * install — WS-38's `pr` snapshot (`0.0.0-pr-<sha>`) on a PR, the stable
 * `latest` on `main` — (c) writes a consumer `package.json` + `.npmrc`
 * (`@swiftagent:registry=https://npm.pkg.github.com` +
 * `//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}`, the token from env,
 * NEVER committed), (d) runs a bounded `npm install`, (e) asserts the packages
 * resolve, imports them, typechecks the consumer against the shipped `.d.ts`,
 * and runs a one-shot happy-path drive.
 *
 * The resolved tag/version is logged LOUDLY so a CI reader knows exactly which
 * published artifact was exercised. If the registry is unreachable or nothing is
 * published under the expected tag, this FAILS LOUD — it NEVER falls back to a
 * local build.
 */

const REGISTRY = 'https://npm.pkg.github.com';
const PACKAGES = ['@swiftagent/sdk', '@swiftagent/react', '@swiftagent/shared'] as const;
const INSTALL_TIMEOUT_MS = 120_000;
const STEP_TIMEOUT_MS = 60_000;

export interface InstallTarget {
  /** dist-tag to install: `pr` on PR runs, `latest` on main/local. */
  tag: string;
  isPr: boolean;
}

export interface InstalledConsumer {
  consumerDir: string;
  tag: string;
  /** Resolved concrete versions per package, read from the installed manifests. */
  versions: Record<string, string>;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run a command with a hard timeout; on timeout the child is killed. */
function runBounded(
  command: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      // `shell:true` makes `npm`/`node` resolve cross-platform (npm.cmd on win32).
      shell: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf-8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf-8')));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${stderr}\n${String(err)}`, timedOut });
    });
  });
}

/**
 * Detect PR vs main from the CI context. On a PR (`GITHUB_EVENT_NAME` =
 * `pull_request`) install WS-38's `pr` snapshot; otherwise the stable `latest`.
 * `SWIFTAGENT_INSTALL_TAG` overrides for manual/local runs.
 */
export function resolveInstallTarget(): InstallTarget {
  const override = process.env['SWIFTAGENT_INSTALL_TAG'];
  if (override) return { tag: override, isPr: override === 'pr' };
  const isPr = process.env['GITHUB_EVENT_NAME'] === 'pull_request';
  return { tag: isPr ? 'pr' : 'latest', isPr };
}

/** True when a `read:packages` credential is present (CI or a local PAT). */
export function hasRegistryAuth(): boolean {
  return Boolean(process.env['NODE_AUTH_TOKEN']);
}

const CONSUMER_ENTRY = `import assert from 'node:assert/strict';
import { createAgentApp } from '@swiftagent/sdk';
import { createChatSession } from '@swiftagent/react';
import { SwiftAgentError, isSwiftAgentError } from '@swiftagent/shared';

// Prove the shipped ESM entry points resolve and export the public surface.
assert.equal(typeof createAgentApp, 'function', 'createAgentApp missing');
assert.equal(typeof createChatSession, 'function', 'createChatSession missing');
assert.equal(typeof SwiftAgentError, 'function', 'SwiftAgentError missing');
assert.equal(typeof isSwiftAgentError, 'function', 'isSwiftAgentError missing');

const wsUrl = process.env.SWIFT_WS_URL;
const token = process.env.SWIFT_TOKEN ?? '';
if (!wsUrl) {
  console.log('[consumer] published symbols resolved; no SWIFT_WS_URL — drive skipped');
  process.exit(0);
}

// Drive the INSTALLED @swiftagent/react client against the in-process server,
// using Node 22's global WebSocket (no extra dep). Bounded so it never hangs.
const client = createChatSession({ token, websocketUrl: wsUrl });
let settled = false;
const finish = (code, why) => {
  if (settled) return;
  settled = true;
  console.log('[consumer] ' + why);
  try { client.disconnect(); } catch {}
  process.exit(code);
};
const timer = setTimeout(() => finish(1, 'drive timed out'), 30000);
timer.unref?.();
client.onEvent((ev) => {
  if (ev.type === 'run_failed') finish(1, 'run_failed: ' + JSON.stringify(ev));
  if (ev.type === 'message_completed') finish(0, 'message_completed');
});
// sendMessage queues until the socket opens, then flushes — safe to call now.
client.sendMessage('hello from the published consumer');
`;

const CONSUMER_CHECK = `import { createAgentApp, type AgentApp } from '@swiftagent/sdk';
import { createChatSession } from '@swiftagent/react';
import { SwiftAgentError, isSwiftAgentError, type SwiftAgentErrorCode } from '@swiftagent/shared';

// Typecheck against the SHIPPED .d.ts — proves the published types resolve.
export function check(): void {
  const app: AgentApp = createAgentApp({ apiKey: 'k', baseUrl: 'http://127.0.0.1:3000' });
  void app.sessions.create;
  void createChatSession;
  const code: SwiftAgentErrorCode = 'UNAUTHORIZED';
  void code;
  void new SwiftAgentError('UNAUTHORIZED', 'x');
  void isSwiftAgentError;
}
`;

const CONSUMER_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      target: 'ES2022',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    },
    files: ['consumer-check.ts'],
  },
  null,
  2,
);

/**
 * Create the throwaway consumer dir and install the published packages from
 * GitHub Packages at the resolved dist-tag. Throws LOUD on any failure — never
 * degrades to a local build.
 */
export async function installPublishedPackages(): Promise<InstalledConsumer> {
  if (!hasRegistryAuth()) {
    throw new Error(
      'NODE_AUTH_TOKEN is not set — a read:packages token is REQUIRED to install from ' +
        `${REGISTRY}. This install proof does NOT fall back to a local build.`,
    );
  }
  const { tag, isPr } = resolveInstallTarget();
  console.log(
    `[install-published] resolving @swiftagent/* from ${REGISTRY} at dist-tag "${tag}" ` +
      `(context=${isPr ? 'pull_request' : 'main/local'})`,
  );

  const consumerDir = await mkdtemp(join(tmpdir(), 'swiftagent-consumer-'));

  // Consumer package.json: install each package at the resolved dist-tag. Plain
  // npm (below) fetches the real registry tarball. `typescript` powers the
  // shipped-.d.ts typecheck.
  const pkg = {
    name: 'swiftagent-acceptance-consumer',
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies: Object.fromEntries(PACKAGES.map((p) => [p, tag])),
    devDependencies: { typescript: '^5.5.0' },
  };
  await writeFile(join(consumerDir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf-8');

  // Consumer .npmrc: scope map + token from env. The `${NODE_AUTH_TOKEN}` is a
  // literal npm variable reference — npm expands it at install time; the token
  // is NEVER written to disk.
  const npmrc =
    `@swiftagent:registry=${REGISTRY}\n` +
    `//npm.pkg.github.com/:_authToken=\${NODE_AUTH_TOKEN}\n` +
    'audit=false\nfund=false\n';
  await writeFile(join(consumerDir, '.npmrc'), npmrc, 'utf-8');

  await writeFile(join(consumerDir, 'consumer-entry.mjs'), CONSUMER_ENTRY, 'utf-8');
  await writeFile(join(consumerDir, 'consumer-check.ts'), CONSUMER_CHECK, 'utf-8');
  await writeFile(join(consumerDir, 'tsconfig.json'), CONSUMER_TSCONFIG, 'utf-8');

  console.log(`[install-published] npm install (bounded ${INSTALL_TIMEOUT_MS}ms) in ${consumerDir}`);
  const install = await runBounded('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: consumerDir,
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  if (install.code !== 0) {
    throw new Error(
      `npm install from ${REGISTRY} FAILED (exit=${install.code}, timedOut=${install.timedOut}). ` +
        'Registry unreachable or nothing published under tag ' +
        `"${tag}". This does NOT fall back to a local build.\n` +
        `stdout:\n${install.stdout}\nstderr:\n${install.stderr}`,
    );
  }

  // Assert resolution + capture the concrete versions from the installed manifests.
  const versions: Record<string, string> = {};
  for (const p of PACKAGES) {
    const manifestPath = join(consumerDir, 'node_modules', p, 'package.json');
    await access(manifestPath).catch(() => {
      throw new Error(`Published package ${p} did not resolve in the consumer node_modules`);
    });
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { version: string };
    versions[p] = manifest.version;
  }
  console.log(
    `[install-published] RESOLVED from ${REGISTRY} @ "${tag}": ` +
      PACKAGES.map((p) => `${p}@${versions[p]}`).join(', '),
  );

  return { consumerDir, tag, versions };
}

/** Import + assert the published symbols (and optionally run the drive). */
export async function importAndDrive(
  consumerDir: string,
  driveEnv?: { baseUrl?: string; websocketUrl?: string; token?: string },
): Promise<void> {
  const env: NodeJS.ProcessEnv = {};
  if (driveEnv?.baseUrl) env['SWIFT_BASE_URL'] = driveEnv.baseUrl;
  if (driveEnv?.websocketUrl) env['SWIFT_WS_URL'] = driveEnv.websocketUrl;
  if (driveEnv?.token) env['SWIFT_TOKEN'] = driveEnv.token;

  const res = await runBounded('node', ['consumer-entry.mjs'], {
    cwd: consumerDir,
    timeoutMs: STEP_TIMEOUT_MS,
    env,
  });
  if (res.code !== 0) {
    throw new Error(
      `Published-consumer import/drive FAILED (exit=${res.code}, timedOut=${res.timedOut}).\n` +
        `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    );
  }
  console.log(`[install-published] consumer drive OK:\n${res.stdout.trim()}`);
}

/** Typecheck the consumer against the shipped `.d.ts` via its own installed tsc. */
export async function typecheckConsumer(consumerDir: string): Promise<void> {
  const tscPath = join('node_modules', 'typescript', 'bin', 'tsc');
  const res = await runBounded('node', [tscPath, '--noEmit', '-p', 'tsconfig.json'], {
    cwd: consumerDir,
    timeoutMs: STEP_TIMEOUT_MS,
  });
  if (res.code !== 0) {
    throw new Error(
      `Consumer typecheck against the shipped .d.ts FAILED (exit=${res.code}).\n` +
        `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    );
  }
  console.log('[install-published] consumer typecheck against shipped .d.ts OK');
}

// ── Standalone entrypoint: `tsx test/acceptance/install-published.ts` ────────
async function main(): Promise<void> {
  const { consumerDir, tag, versions } = await installPublishedPackages();
  await typecheckConsumer(consumerDir);
  await importAndDrive(consumerDir); // symbols-only (no in-process server here)
  console.log(
    `[install-published] PASSED — tag="${tag}" ` +
      PACKAGES.map((p) => `${p}@${versions[p]}`).join(', '),
  );
}

// Only run when invoked directly (not when imported by the suite).
if (process.argv[1] && process.argv[1].endsWith('install-published.ts')) {
  main().catch((err: unknown) => {
    console.error(`[install-published] FAILED: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  });
}
