import type { AddressInfo } from 'node:net';
import { buildApp, type AppContext } from '@swiftagent/api';
import {
  createRuntimeHarness,
  seededTool,
  type RuntimeHarness,
  type GatewayHandle,
} from '../../support/runtime-harness.js';
import { byTurn, textTurn, toolTurn } from '../../support/fake-provider.js';
import { startFakeRunner, type FakeRunnerHandle } from '../../support/fake-runner.js';

/**
 * WS-42 · Composed acceptance stack.
 *
 * Wraps `createRuntimeHarness()` (the REAL runtime — repos, the deterministic
 * `fake/deterministic` provider, the scoped-token tool-executor resolver, and
 * `RunExecutionService`) into a single listening REST + WebSocket stack on
 * concrete ephemeral ports, so the public SDK (`createAgentApp({ baseUrl })`)
 * and a headless WS client can drive it over real HTTP/WS — exactly as a real
 * consumer would against `apps/server`.
 *
 * Two listeners (REST via `buildApp`, gateway via the harness) are intentional
 * and simplest: the SDK talks the control plane via `baseUrl` (REST) and the
 * client connects to the returned `websocketUrl` (gateway). The KEY difference
 * from `harness.buildRestApp` is that we build the REST app with
 * `publicWebsocketUrl` pointed at the gateway's REAL port (the harness helper
 * hardcodes `ws://127.0.0.1:0/…`, a placeholder that would never connect), so
 * the `websocketUrl` returned by `POST /v1/sessions` is directly connectable —
 * the whole point of driving through the public SDK.
 *
 * No runtime-loop or SDK-surface change: this only COMPOSES existing package
 * entry points and seeds through the harness repos/registry. The stub agent is
 * selected purely by the persisted model string `fake/deterministic`.
 */

/** The deterministic tool-then-text script that produces the tool round-trip. */
const ECHO_THEN_TEXT = byTurn(toolTurn('echo', { v: 1 }), textTurn('Hi from acceptance'));

export interface SeededEchoAgent {
  workspaceId: string;
  /** Workspace API key for `createAgentApp({ apiKey })`. */
  apiKey: string;
  /** Agent name for `app.sessions.create({ agentName })`. */
  agentName: string;
  /** The live SDK tool runner hosting the real `echo` tool. */
  runner: FakeRunnerHandle;
}

export interface AcceptanceServer {
  /** `http://127.0.0.1:<port>` — pass as the SDK's `baseUrl`. */
  baseUrl: string;
  /** `ws://127.0.0.1:<port>/v1/stream` — the gateway (token appended by the API). */
  websocketBaseUrl: string;
  harness: RuntimeHarness;
  /**
   * Seed a fresh workspace + API key, start a real `echo` tool runner, seed a
   * `fake/deterministic` agent wired to it, and arm the tool-then-text
   * responder. Returns the handles the SDK drive needs.
   */
  seedEchoAgent(opts?: { agentName?: string }): Promise<SeededEchoAgent>;
  teardown(): Promise<void>;
}

/** Boot the composed REST + gateway stack on ephemeral ports. */
export async function startAcceptanceServer(): Promise<AcceptanceServer> {
  const harness = await createRuntimeHarness();
  // One execution service shared by REST + WS — one session lock, one registry,
  // mirroring `apps/server`.
  const runService = harness.createRunService();

  // Gateway first: its real port becomes the REST app's advertised websocketUrl.
  const gateway: GatewayHandle = await harness.buildGateway(runService);

  // REST app built DIRECTLY (not via harness.buildRestApp) so we can point
  // `publicWebsocketUrl` at the gateway's real port and then listen on a real
  // TCP port the SDK's fetch client can reach.
  const restCtx: AppContext = await buildApp({
    runExecutionService: runService,
    repos: harness.repos,
    jwtSecret: harness.jwtSecret,
    publicWebsocketUrl: gateway.wsBaseUrl,
    logger: false,
  });
  await restCtx.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = restCtx.app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const runners: FakeRunnerHandle[] = [];

  return {
    baseUrl,
    websocketBaseUrl: gateway.wsBaseUrl,
    harness,

    async seedEchoAgent(opts) {
      const { workspaceId, apiKey } = await harness.seedWorkspaceWithKey();
      const runner = await startFakeRunner({ publicKey: harness.keys.publicKey, workspaceId });
      runners.push(runner);

      const agent = await harness.seedAgent({
        workspaceId,
        name: opts?.agentName,
        model: harness.fakeModel, // 'fake/deterministic'
        tools: [seededTool('echo')],
        toolRunnerUrl: runner.url,
      });

      // Turn 0 → tool_call(echo); after the tool result, turn 1 → text + finish.
      harness.fake.setResponder(ECHO_THEN_TEXT);

      return { workspaceId, apiKey, agentName: agent.name, runner };
    },

    async teardown() {
      while (runners.length) await runners.pop()!.teardown();
      // Close our own REST app first (the harness only tracks the ones IT built).
      await restCtx.app.close();
      await harness.teardown();
    },
  };
}
