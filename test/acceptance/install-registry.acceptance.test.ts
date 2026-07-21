import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createAgentApp } from '@swiftagent/sdk';
import { connectWs } from '../support/ws-client.js';
import { startAcceptanceServer, type AcceptanceServer } from './support/acceptance-server.js';
import {
  installPublishedPackages,
  importAndDrive,
  typecheckConsumer,
  hasRegistryAuth,
  resolveInstallTarget,
} from './install-published.js';

/**
 * WS-42 · Install-from-registry proof (SC-09) — the ONLY path that satisfies the
 * "installs the published packages" criterion; there is NO local-tarball
 * fallback.
 *
 * Installs `@swiftagent/{sdk,react,shared}` from GitHub Packages
 * (`npm.pkg.github.com`) into a throwaway consumer — WS-38's `pr` snapshot on
 * PRs, the stable `latest` on `main` — asserts they resolve, typechecks the
 * consumer against the SHIPPED `.d.ts`, imports the public symbols, and runs the
 * consumer's one happy-path drive (via the INSTALLED `@swiftagent/react`
 * client) against the in-process server. The resolved tag/version is logged
 * loudly. A missing publish / unreachable registry FAILS the test.
 *
 * CREDENTIAL GATE (not a fallback): installing from a PRIVATE registry is
 * impossible without a `read:packages` credential. When `NODE_AUTH_TOKEN` is
 * absent (typical local dev without a PAT) this scenario SKIPS with a loud note
 * so `pnpm test:acceptance` stays green locally; in CI the token is
 * `secrets.GITHUB_TOKEN`, so it RUNS and fails loud on any real install failure.
 * This is distinct from "degrading to a local build" — which never happens.
 */

const AUTH = hasRegistryAuth();

describe.skipIf(!AUTH)('WS-42 install-from-registry proof', () => {
  let server: AcceptanceServer;

  beforeAll(async () => {
    server = await startAcceptanceServer();
  });

  afterAll(async () => {
    if (server) await server.teardown();
  });

  it(
    'installs the published packages, typechecks the shipped .d.ts, and drives a happy path',
    async () => {
      const { tag } = resolveInstallTarget();
      console.log(`[install-registry] install proof running against dist-tag "${tag}"`);

      // (1) Real GitHub Packages install into a throwaway consumer.
      const { consumerDir, versions } = await installPublishedPackages();
      for (const [pkg, version] of Object.entries(versions)) {
        expect(version, `${pkg} must resolve to a concrete version`).toBeTruthy();
      }

      // (2) Typecheck the consumer against the shipped .d.ts.
      await typecheckConsumer(consumerDir);

      // (3) Capstone: mint a real session against the in-process server (via the
      // workspace SDK), then have the INSTALLED consumer client drive it.
      const { apiKey, agentName } = await server.seedEchoAgent();
      const app = createAgentApp({ apiKey, baseUrl: server.baseUrl });
      const session = await app.sessions.create({ agentName });
      try {
        await importAndDrive(consumerDir, {
          baseUrl: server.baseUrl,
          websocketUrl: session.websocketUrl,
          token: session.clientToken,
        });
      } finally {
        await app.close();
      }
    },
    120_000,
  );

  it('exercises the same in-process gateway a raw client reaches (sanity)', async () => {
    // A tiny raw-WS sanity check that the seeded agent streams — keeps the
    // install test's failure surface separable from a server-boot failure.
    const { apiKey, agentName } = await server.seedEchoAgent();
    const app = createAgentApp({ apiKey, baseUrl: server.baseUrl });
    const session = await app.sessions.create({ agentName });
    const client = await connectWs(session.websocketUrl, 15_000);
    try {
      client.send({ type: 'send_message', content: 'sanity' });
      await client.waitForType('message_completed', 15_000);
      expect(client.framesOfType('tool_call_completed')).toHaveLength(1);
    } finally {
      await client.close();
      await app.close();
    }
  });
});

// A loud breadcrumb when the whole proof is skipped, so a green local run never
// silently implies the registry install was exercised.
describe.runIf(!AUTH)('WS-42 install-from-registry proof (skipped)', () => {
  it('is SKIPPED because NODE_AUTH_TOKEN is absent (set a read:packages PAT to run)', () => {
    console.warn(
      '[install-registry] SKIPPED — NODE_AUTH_TOKEN not set; the registry install proof ' +
        'requires a read:packages credential. It runs in CI (secrets.GITHUB_TOKEN).',
    );
    expect(AUTH).toBe(false);
  });
});
