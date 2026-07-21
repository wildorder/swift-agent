import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { z } from 'zod';
import { createAgentApp, defineAgent, tool } from '@swiftagent/sdk';
import { ChatEventSchema, isSwiftAgentError, type SwiftAgentError } from '@swiftagent/shared';
import { connectWs, type WsClient, type WsFrame } from '../support/ws-client.js';
import { startAcceptanceServer, type AcceptanceServer } from './support/acceptance-server.js';

/**
 * WS-42 · Quickstart Acceptance Flow (SC-09) — the program's executable
 * definition of "a working agent in minutes."
 *
 * Against a Testcontainers-Postgres-backed, locally-booted REST + WS stack (the
 * committed Drizzle migrations applied by `test/setup-db.ts`), this drives the
 * documented quickstart through the PUBLIC SDK — `createAgentApp` →
 * `app.sessions.create` → `connectWs(websocketUrl)` → `send_message` — and
 * asserts the ordered `ChatEvent` sequence
 * `message_started → token(≥1) → tool_call_started → tool_call_completed →
 * message_completed`, every frame validated with `ChatEventSchema`, treating
 * `run_failed`/`error`/malformed frames as failures. The tool round-trip is a
 * REAL round-trip through the SDK tool runner (the `echo` tool), produced by the
 * deterministic `fake/deterministic` provider via
 * `byTurn(toolTurn('echo',…), textTurn(…))` — no real provider key.
 *
 * Everything is BOUNDED (connect timeout, per-wait timeout, an overall per-
 * scenario wall-clock budget) and the happy path is raced against a
 * `run_failed`/`error` watcher, because a realtime bug manifests as *silence*.
 * Diagnostics (frames, WS close code, typed error) print on failure.
 *
 * NOTE: this file lives under the typecheck/lint-EXCLUDED `test/` tree (project
 * convention) — it is validated by RUNNING it (`pnpm test:acceptance`), not by
 * the monorepo `pnpm typecheck` / `pnpm lint` gates. The published-package
 * consumer IS typechecked, but by its own `tsc` against the shipped `.d.ts`
 * (see `install-registry.acceptance.test.ts`).
 */

// ── Bounds (everything is bounded — fail loud, never hang) ───────────────────
const OPEN_TIMEOUT_MS = 15_000;
const WAIT_TIMEOUT_MS = 15_000;
/** Hard per-scenario wall-clock ceiling — the failure watcher force-fails at it. */
const SCENARIO_BUDGET_MS = 45_000;

/** Validate an inbound frame against the shared union; malformed = failure. */
function assertValidFrame(frame: WsFrame): void {
  const parsed = ChatEventSchema.safeParse(frame);
  if (!parsed.success) {
    throw new Error(
      `received malformed/unknown ChatEvent frame ${JSON.stringify(frame)}: ${parsed.error.message}`,
    );
  }
}

/**
 * A watcher that rejects when a terminal `run_failed`/`error` frame arrives, and
 * otherwise stays pending (its own timeout is swallowed) so it can be safely
 * `Promise.race`d against the happy-path sequence without winning on timeout.
 */
function watchForFailure(client: WsClient): Promise<never> {
  return client
    .waitFor((frame) => frame.type === 'run_failed' || frame.type === 'error', SCENARIO_BUDGET_MS)
    .then(
      (frame) => {
        throw new Error(
          frame.type === 'run_failed'
            ? `run_failed: code=${String(frame.code)} message=${String(frame.message)}`
            : `gateway error frame: ${JSON.stringify(frame)}`,
        );
      },
      () => new Promise<never>(() => {}),
    );
}

/** Print the captured frames on any failure so CI can read *why*. */
function printFrames(client: WsClient): void {
  console.error(`---- acceptance diagnostics: ${client.frames.length} frame(s) ----`);
  for (const frame of client.frames) console.error(`  ${JSON.stringify(frame)}`);
  console.error('------------------------------------------------');
}

describe('WS-42 quickstart acceptance', () => {
  let server: AcceptanceServer;

  beforeAll(async () => {
    server = await startAcceptanceServer();
  });

  afterAll(async () => {
    await server.teardown();
  });

  it(
    'drives define agent → create session → connect → stream (with a real tool round-trip)',
    async () => {
      const { apiKey, agentName } = await server.seedEchoAgent();

      // Mirror the documented quickstart's SDK construction. The tool + agent are
      // built through the real public surface (`tool`/`defineAgent`), proving the
      // shapes compile and run; execution resolves against the seeded agent + the
      // real SDK tool runner (see the acceptance-server note on why we do not call
      // `app.listen()` — that would start a second, separately-keyed runner).
      const echoTool = tool({
        name: 'echo',
        description: 'Echo the input back to the caller',
        inputSchema: z.object({}).passthrough(),
        execute: async (input: unknown) => ({ echoed: input }),
      });
      const app = createAgentApp({ apiKey, baseUrl: server.baseUrl });
      app.agent(defineAgent({ name: agentName, model: 'fake/deterministic', tools: [echoTool] }));

      // ── define agent → create session ──
      const session = await app.sessions.create({ agentName });
      expect(session.sessionId).toMatch(/^ses_/);
      expect(session.clientToken).toBeTruthy();
      expect(session.websocketUrl).toContain('token=');

      // ── connect via the client → send a message → assert the stream ──
      const client = await connectWs(session.websocketUrl, OPEN_TIMEOUT_MS);
      client.socket.on('close', (code: number, reason: Buffer) => {
        // Captured for diagnostics; auth rejects surface as 4001/4002/4003.
        if (code !== 1000 && code !== 1001) {
          console.error(`WS close: code=${code} reason=${JSON.stringify(reason.toString('utf-8'))}`);
        }
      });

      try {
        client.send({ type: 'send_message', content: 'hello from quickstart' });

        const assertStream = async (): Promise<void> => {
          const started = await client.waitForType('message_started', WAIT_TIMEOUT_MS);
          assertValidFrame(started);

          const token = await client.waitForType('token', WAIT_TIMEOUT_MS);
          assertValidFrame(token);

          const tcStarted = await client.waitForType('tool_call_started', WAIT_TIMEOUT_MS);
          assertValidFrame(tcStarted);

          const tcDone = await client.waitForType('tool_call_completed', WAIT_TIMEOUT_MS);
          assertValidFrame(tcDone);

          const completed = await client.waitForType('message_completed', WAIT_TIMEOUT_MS);
          assertValidFrame(completed);
        };

        // Race the sequence against the failure watcher so a run_failed/error
        // frame fails fast rather than stalling on a waitForType timeout.
        await Promise.race([assertStream(), watchForFailure(client)]);

        // ── SC-09 tool round-trip: it is REAL, not a bare frame ──
        const started = client.framesOfType('tool_call_started');
        const completed = client.framesOfType('tool_call_completed');
        expect(started).toHaveLength(1);
        expect(completed).toHaveLength(1);
        expect(started[0]!.toolName).toBe('echo');
        expect(completed[0]!.toolName).toBe('echo');
        // Same callId links the started/completed halves of ONE invocation.
        const callId = started[0]!.callId as string;
        expect(typeof callId).toBe('string');
        expect(completed[0]!.callId).toBe(callId);
        // A terminal status proves the runner actually ran the tool.
        expect(completed[0]!.status).toBeDefined();

        // Final ordering sanity: message_started precedes message_completed.
        const types = client.frames.map((f) => f.type);
        expect(types.indexOf('message_started')).toBeLessThan(types.indexOf('message_completed'));
        expect(types.indexOf('tool_call_started')).toBeLessThan(types.indexOf('tool_call_completed'));
      } catch (err) {
        printFrames(client);
        throw err;
      } finally {
        await client.close();
        await app.close();
      }
    },
    SCENARIO_BUDGET_MS,
  );

  // ── Negative path (SC-09 / WS-41): a typed, human-readable error ───────────
  //
  // WS-41 has landed: `createAgentApp` throws `SwiftAgentError(VALIDATION)` on a
  // missing apiKey, and `ControlPlaneClient` maps every non-2xx / transport
  // failure to a typed `SwiftAgentError` (status-derived `.code`, actionable
  // `.message`, raw wire error preserved as `.cause`). So we assert the STRONG
  // contract directly: the throw `isSwiftAgentError`, carries the expected
  // machine-readable `.code`, and a human-readable `.message` — never
  // `[object Event]` / a bare `HTTP 401`.
  function assertSwiftAgentError(
    err: unknown,
    expectedCode: string,
    opts: { expectStatus?: number } = {},
  ): asserts err is SwiftAgentError {
    expect(isSwiftAgentError(err)).toBe(true);
    const e = err as SwiftAgentError;
    expect(e.code).toBe(expectedCode);
    // Human-readable message — not the notorious `[object Event]` or empty.
    expect(typeof e.message).toBe('string');
    expect(e.message.length).toBeGreaterThan(0);
    expect(e.message).not.toBe('[object Event]');
    if (opts.expectStatus !== undefined) {
      expect(e.statusCode).toBe(opts.expectStatus);
    }
  }

  it('rejects an empty apiKey with SwiftAgentError(VALIDATION) naming apiKey', () => {
    let thrown: unknown;
    try {
      createAgentApp({ apiKey: '' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    assertSwiftAgentError(thrown, 'VALIDATION');
    expect((thrown as SwiftAgentError).message.toLowerCase()).toContain('apikey');
  });

  it('surfaces SwiftAgentError(UNAUTHORIZED) on a bad API key (not an opaque failure)', async () => {
    // Seed a real agent so the ONLY thing wrong is the key — isolates the 401.
    const { agentName } = await server.seedEchoAgent();
    const app = createAgentApp({ apiKey: 'ak_totally-bogus-key', baseUrl: server.baseUrl });

    let thrown: unknown;
    try {
      await app.sessions.create({ agentName });
    } catch (err) {
      thrown = err;
    } finally {
      await app.close();
    }

    expect(thrown).toBeDefined();
    assertSwiftAgentError(thrown, 'UNAUTHORIZED', { expectStatus: 401 });
  });

  // ── Bounded / fail-loud (SC-09): a broken target fails within budget ───────
  it(
    'fails loud with SwiftAgentError(CONNECTION_ERROR) against an unreachable server (does not hang)',
    async () => {
      // Point the SDK at a closed port on loopback — no listener accepts it.
      const app = createAgentApp({ apiKey: 'ak_whatever', baseUrl: 'http://127.0.0.1:1' });
      const start = Date.now();
      let thrown: unknown;
      try {
        await app.sessions.create({ agentName: 'nobody' });
      } catch (err) {
        thrown = err;
      } finally {
        await app.close();
      }
      const elapsed = Date.now() - start;
      // Connection refused → a typed CONNECTION_ERROR, not silence and not a raw
      // ECONNREFUSED Error. WS-41 names the baseUrl in the message.
      assertSwiftAgentError(thrown, 'CONNECTION_ERROR');
      expect(elapsed).toBeLessThan(SCENARIO_BUDGET_MS); // bounded: it did not hang
    },
    SCENARIO_BUDGET_MS,
  );
});
