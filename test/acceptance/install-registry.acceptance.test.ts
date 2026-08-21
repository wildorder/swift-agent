import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createAgentApp } from '@swiftagent/sdk';
import { connectWs } from '../support/ws-client.js';
import { startAcceptanceServer, type AcceptanceServer } from './support/acceptance-server.js';
import {
  installPublishedPackages,
  importAndDrive,
  typecheckConsumer,
  installProofEnabled,
  resolveInstallTarget,
} from './install-published.js';

/**
 * WS-42/WS-44 · Install-from-registry proof — the ONLY path that satisfies the
 * "installs the published packages" criterion; there is NO local-tarball
 * fallback.
 *
 * Installs `@swiftagent/{sdk,react,shared}` from the parameterized registry
 * (`SWIFTAGENT_INSTALL_REGISTRY`, default public npm `registry.npmjs.org`)
 * into a throwaway consumer — the `pr` snapshot on PRs, the stable `latest`
 * otherwise — asserts they resolve, typechecks the consumer against the
 * SHIPPED `.d.ts`, imports the public symbols, and runs the consumer's one
 * happy-path drive (via the INSTALLED `@swiftagent/react` client) against the
 * in-process server. The resolved tag/version is logged loudly. A missing
 * publish / unreachable registry FAILS the test.
 *
 * OPT-IN GATE (not a fallback): after the WS-44 public-posture flip and before
 * the owner fires the release trigger (see RELEASING.md), NOTHING exists under
 * `@swiftagent/*` on `registry.npmjs.org` — a default-on run would fail every
 * CI run while asserting a published version exists (which no surface may
 * claim). The proof therefore runs ONLY when `SWIFTAGENT_RUN_INSTALL_PROOF=1`
 * is set, and loud-skips otherwise. WS-45 re-enables it per PR against its
 * local Verdaccio registry via `SWIFTAGENT_INSTALL_REGISTRY` (+ its dummy
 * `NODE_AUTH_TOKEN`) + `SWIFTAGENT_RUN_INSTALL_PROOF=1`. This is distinct from
 * "degrading to a local build" — which never happens.
 */

const RUN_PROOF = installProofEnabled();

describe.skipIf(!RUN_PROOF)('install-from-registry proof', () => {
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

      // (1) Real registry install into a throwaway consumer.
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

// A loud breadcrumb when the whole proof is skipped, so a green run never
// silently implies the registry install was exercised.
describe.runIf(!RUN_PROOF)('install-from-registry proof (skipped)', () => {
  it('is SKIPPED because SWIFTAGENT_RUN_INSTALL_PROOF is not set to 1 (explicit opt-in)', () => {
    console.warn(
      '[install-registry] SKIPPED — SWIFTAGENT_RUN_INSTALL_PROOF is not "1". The registry ' +
        'install proof is opt-in until a published version exists (public npm after the ' +
        'RELEASING.md trigger, or WS-45\'s local registry via SWIFTAGENT_INSTALL_REGISTRY).',
    );
    expect(RUN_PROOF).toBe(false);
  });
});
