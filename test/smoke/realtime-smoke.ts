import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ChatEventSchema } from '@swiftagent/shared';
import { connectWs, type WsClient, type WsFrame } from '../support/ws-client.js';

/**
 * WS-35 · Deployed realtime smoke test (SC-10).
 *
 * Proves the deployed realtime path works end-to-end in the cloud — not just
 * that `/health` returns 200. It exercises the actual customer path against a
 * live environment:
 *
 *   POST {SMOKE_BASE_URL}/v1/sessions   (API-key auth: Authorization: Bearer …)
 *     → connect the returned `websocketUrl` (canonical `/v1/stream?token=<jwt>`)
 *     → send  { type: 'send_message', content }
 *     → assert the ChatEvent stream:  message_started → token(s) → message_completed
 *
 * Exits 0 on the expected sequence; non-zero (with captured diagnostics) on any
 * failure. Everything is BOUNDED so a realtime bug (which usually manifests as
 * *silence*) fails loud and never hangs: a connect timeout, a per-wait timeout,
 * an overall wall-clock watchdog, and a limited retry loop with backoff to
 * absorb ALB warm-up / task-registration races.
 *
 * Reuses the shared WS client (`test/support/ws-client.ts`) and the shared
 * `ChatEventSchema` (`@swiftagent/shared`) rather than re-implementing a socket
 * wrapper or hand-rolled frame-shape checks.
 *
 * This is deliberately the same flow WS-34's developer quickstart documents —
 * keep the two in lockstep.
 *
 * Required env:
 *   SMOKE_BASE_URL     deployed base URL, e.g. https://staging-api.swiftagent.dev
 *   SMOKE_API_KEY      a smoke API key used to auth POST /v1/sessions
 * Optional env:
 *   SMOKE_AGENT_NAME   seeded agent to target (default: smoke-echo)
 *   SMOKE_API_KEY_FILE fallback: path to a file holding the raw API key, read
 *                      ONLY when SMOKE_API_KEY is unset (WS-43 — the local
 *                      compose bootstrap writes ./.swiftagent-local/dev-api-key)
 *   REQUIRE_TOOLS=1    additionally assert a full tool round trip:
 *                      tool_call_started then tool_call_completed (matching
 *                      callId, success status) between message_started and
 *                      message_completed (WS-43 — the local `local-dev` agent's
 *                      fixture provider makes exactly one such pair per turn)
 *
 * TWO INVOCATION PATHS, one flow:
 *   cloud (`pnpm smoke:realtime`, deploy workflows): SMOKE_BASE_URL +
 *     SMOKE_API_KEY + SMOKE_AGENT_NAME=smoke-echo — behaviour is unchanged
 *     byte-for-byte; both additions above are opt-in and default off.
 *   local (`pnpm smoke:local` → local-smoke-entry.ts): no pre-supplied secrets —
 *     the key comes from the bootstrap-written key file, the agent is the
 *     self-provisioned `local-dev`, and REQUIRE_TOOLS=1 asserts the tool events.
 *
 * PROVISIONING ASSUMPTION (flagged, not invented): each environment is expected
 * to hold (a) a per-env `SMOKE_API_KEY` GitHub Actions secret, and (b) a seeded
 * streaming agent (`SMOKE_AGENT_NAME`, default `smoke-echo`) whose provider
 * deterministically emits token frames (an echo/stub — so `token` frames are
 * guaranteed without real model cost/nondeterminism).
 *
 * MINIMUM-BAR FALLBACK: if an environment lacks a seeded streaming agent, the
 * floor (SC-10 "at minimum a successful authenticated stream") is a successful
 * authenticated WS connect + an accepted `send_message` with no `error`/
 * `run_failed` frame within the budget. The DEFAULT below is stricter: it
 * asserts the full `message_started → token → message_completed` sequence. To
 * relax to the floor in an env without a streaming agent, set REQUIRE_TOKENS=0.
 */

// ---- Env -------------------------------------------------------------------

const AGENT_NAME = process.env.SMOKE_AGENT_NAME ?? 'smoke-echo';
/** Default asserts the full stream; set REQUIRE_TOKENS=0 for the minimum bar. */
const REQUIRE_TOKENS = process.env.REQUIRE_TOKENS !== '0';
/** Opt-in (WS-43): additionally assert a tool_call_started/completed round trip. */
const REQUIRE_TOOLS = process.env.REQUIRE_TOOLS === '1';

// ---- Bounds (everything is bounded — fail loud, never hang) -----------------

/** Hard wall-clock ceiling across ALL retries; the watchdog force-exits at it. */
const OVERALL_BUDGET_MS = 90_000;
/** WS open (upgrade/handshake) timeout for a single attempt. */
const CONNECT_TIMEOUT_MS = 15_000;
/** Per-`waitForType` timeout for each expected frame. */
const WAIT_TIMEOUT_MS = 15_000;
/** POST /v1/sessions timeout. */
const POST_TIMEOUT_MS = 15_000;
/** Whole-flow retries (attempts), to absorb warm-up races. */
const MAX_ATTEMPTS = 3;
/** Linear backoff base between attempts (multiplied by the attempt number). */
const BACKOFF_MS = 3_000;

const SESSION_RESPONSE_SCHEMA = z.object({
  sessionId: z.string(),
  websocketUrl: z.string(),
});

/** A failure whose `fatal` flag suppresses further retries (e.g. bad key). */
class SmokeError extends Error {
  constructor(
    message: string,
    readonly fatal = false,
  ) {
    super(message);
    this.name = 'SmokeError';
  }
}

// ---- Diagnostics (printed on any failure so CI can read *why*) --------------

interface Diagnostics {
  attempt: number;
  postStatus?: number;
  postBody?: string;
  wsCloseCode?: number;
  wsCloseReason?: string;
  frames: WsFrame[];
}

const diag: Diagnostics = { attempt: 0, frames: [] };

function printDiagnostics(): void {
  console.error('---- realtime smoke diagnostics ----');
  console.error(`attempts made: ${diag.attempt}`);
  if (REQUIRE_TOOLS) {
    // WS-43: when the tool round trip is asserted, summarize exactly which tool
    // events arrived so a missing-event failure is readable at a glance (the
    // full frame dump below remains the ground truth).
    const started = diag.frames.filter((f) => f.type === 'tool_call_started');
    const completed = diag.frames.filter((f) => f.type === 'tool_call_completed');
    console.error(
      `REQUIRE_TOOLS=1: tool_call_started=${started.length} tool_call_completed=${completed.length}`,
    );
  }
  if (diag.postStatus !== undefined) {
    console.error(`POST /v1/sessions status: ${diag.postStatus}`);
  }
  if (diag.postBody !== undefined) {
    console.error(`POST /v1/sessions body: ${diag.postBody}`);
  }
  if (diag.wsCloseCode !== undefined) {
    console.error(`WS close: code=${diag.wsCloseCode} reason=${JSON.stringify(diag.wsCloseReason ?? '')}`);
  }
  console.error(`frames received (${diag.frames.length}):`);
  for (const frame of diag.frames) {
    console.error(`  ${JSON.stringify(frame)}`);
  }
  console.error('------------------------------------');
}

// ---- Helpers ---------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve the API key: SMOKE_API_KEY wins (cloud path, unchanged); when it is
 * unset, SMOKE_API_KEY_FILE names a file whose trimmed contents are the key
 * (WS-43 local path — the compose bootstrap writes the generated dev key there).
 */
function resolveApiKey(): string | undefined {
  const direct = process.env.SMOKE_API_KEY;
  if (direct) return direct;
  const keyFile = process.env.SMOKE_API_KEY_FILE;
  if (!keyFile) return undefined;
  try {
    const contents = readFileSync(keyFile, 'utf-8').trim();
    return contents || undefined;
  } catch (err) {
    console.error(
      `realtime smoke: failed to read SMOKE_API_KEY_FILE (${keyFile}): ${(err as Error).message}`,
    );
    return undefined;
  }
}

function requireEnv(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.SMOKE_BASE_URL;
  const apiKey = resolveApiKey();
  const missing: string[] = [];
  if (!baseUrl) missing.push('SMOKE_BASE_URL');
  if (!apiKey) missing.push('SMOKE_API_KEY (or SMOKE_API_KEY_FILE)');
  if (!baseUrl || !apiKey) {
    console.error(`realtime smoke: missing required env: ${missing.join(', ')}`);
    process.exit(1);
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey };
}

/** Validate an inbound frame against the shared union; malformed = failure. */
function assertValidFrame(frame: WsFrame): void {
  const parsed = ChatEventSchema.safeParse(frame);
  if (!parsed.success) {
    throw new SmokeError(
      `received malformed/unknown ChatEvent frame ${JSON.stringify(frame)}: ${parsed.error.message}`,
    );
  }
}

// ---- Flow ------------------------------------------------------------------

/** POST /v1/sessions with API-key auth; returns the consumed session fields. */
async function createSession(baseUrl: string, apiKey: string): Promise<z.infer<typeof SESSION_RESPONSE_SCHEMA>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ agentName: AGENT_NAME }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  diag.postStatus = res.status;
  diag.postBody = text.slice(0, 2_000);

  if (res.status !== 201) {
    // 401/403 will never recover on retry — mark fatal to fail fast.
    const fatal = res.status === 401 || res.status === 403;
    throw new SmokeError(`POST /v1/sessions returned ${res.status} (expected 201)`, fatal);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SmokeError('POST /v1/sessions returned a non-JSON body');
  }
  const parsed = SESSION_RESPONSE_SCHEMA.safeParse(json);
  if (!parsed.success) {
    throw new SmokeError(`POST /v1/sessions body missing sessionId/websocketUrl: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * A watcher that throws when a terminal `run_failed`/`error` frame arrives, and
 * otherwise stays pending forever (its own timeout rejection is swallowed) so it
 * can be safely `Promise.race`d against the happy-path sequence without spuriously
 * winning on timeout.
 */
function watchForFailure(client: WsClient): Promise<never> {
  return client
    .waitFor((frame) => frame.type === 'run_failed' || frame.type === 'error', OVERALL_BUDGET_MS)
    .then(
      (frame) => {
        throw new SmokeError(
          frame.type === 'run_failed'
            ? `run_failed: code=${String(frame.code)} message=${String(frame.message)}`
            : `gateway error frame: ${JSON.stringify(frame)}`,
        );
      },
      () => new Promise<never>(() => {}),
    );
}

/** Ping-handshake bounds (see comment in assertStream). */
const PING_HANDSHAKE_ATTEMPTS = 20;
const PING_HANDSHAKE_INTERVAL_MS = 500;

/** The happy path: send a message and assert the streamed ChatEvent sequence. */
async function assertStream(client: WsClient): Promise<void> {
  // GATEWAY ATTACH RACE (found by WS-43, defect pre-exists in
  // packages/gateway/src/plugin.ts): the /v1/stream handler performs async
  // work (JWT verify + Redis channel subscribe) BEFORE attaching its
  // socket.on('message') listener, so a frame sent immediately after the
  // client's 'open' can be silently dropped — easily hit on localhost where
  // RTT is ~0. The gateway answers {type:'ping'} with {type:'pong'} from that
  // same listener, so a pong proves the listener is attached. Handshake with
  // bounded ping retries before sending; if no pong ever arrives, proceed and
  // let the normal frame timeouts fail loud.
  for (let i = 0; i < PING_HANDSHAKE_ATTEMPTS; i++) {
    client.send({ type: 'ping' });
    try {
      await client.waitForType('pong', PING_HANDSHAKE_INTERVAL_MS);
      break;
    } catch {
      // No pong yet — listener may not be attached; retry.
    }
  }

  client.send({ type: 'send_message', content: 'ping from realtime smoke' });

  const started = await client.waitForType('message_started', WAIT_TIMEOUT_MS);
  assertValidFrame(started);

  if (REQUIRE_TOKENS) {
    const token = await client.waitForType('token', WAIT_TIMEOUT_MS);
    assertValidFrame(token);
  }

  if (REQUIRE_TOOLS) {
    // WS-43: assert a real tool round trip — started then completed, the same
    // callId across the pair, and a success status.
    const toolStarted = await client.waitForType('tool_call_started', WAIT_TIMEOUT_MS);
    assertValidFrame(toolStarted);
    const toolCompleted = await client.waitForType('tool_call_completed', WAIT_TIMEOUT_MS);
    assertValidFrame(toolCompleted);

    if (toolCompleted.callId !== toolStarted.callId) {
      throw new SmokeError(
        `tool_call_completed callId ${JSON.stringify(toolCompleted.callId)} does not match tool_call_started callId ${JSON.stringify(toolStarted.callId)}`,
      );
    }
    if (toolCompleted.status !== 'completed') {
      throw new SmokeError(
        `tool call ${String(toolStarted.callId)} (${String(toolStarted.toolName)}) finished with status ${JSON.stringify(toolCompleted.status)} (expected 'completed')`,
      );
    }
  }

  const completed = await client.waitForType('message_completed', WAIT_TIMEOUT_MS);
  assertValidFrame(completed);
}

/** A single end-to-end attempt: connect → send → assert. */
async function runOnce(websocketUrl: string): Promise<void> {
  const client = await connectWs(websocketUrl, CONNECT_TIMEOUT_MS);
  // Share the live frame buffer so diagnostics reflect this attempt, and capture
  // the WS close code/reason (e.g. 4001/4002/4003 auth rejects).
  diag.frames = client.frames;
  diag.wsCloseCode = undefined;
  diag.wsCloseReason = undefined;
  client.socket.on('close', (code: number, reason: Buffer) => {
    diag.wsCloseCode = code;
    diag.wsCloseReason = reason.toString('utf-8');
  });

  try {
    // Race the sequence against a failure watcher so a run_failed/error frame
    // fails fast instead of stalling on a waitForType timeout.
    await Promise.race([assertStream(client), watchForFailure(client)]);
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  const { baseUrl, apiKey } = requireEnv();
  console.log(
    `realtime smoke: base=${baseUrl} agent=${AGENT_NAME} requireTokens=${REQUIRE_TOKENS} requireTools=${REQUIRE_TOOLS} budget=${OVERALL_BUDGET_MS}ms`,
  );

  const watchdog = setTimeout(() => {
    console.error(`realtime smoke: exceeded overall budget of ${OVERALL_BUDGET_MS}ms — forcing exit`);
    printDiagnostics();
    process.exit(1);
  }, OVERALL_BUDGET_MS);

  let passed = false;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    diag.attempt = attempt;
    try {
      const { sessionId, websocketUrl } = await createSession(baseUrl, apiKey);
      console.log(`attempt ${attempt}/${MAX_ATTEMPTS}: created session ${sessionId}; connecting WS…`);
      await runOnce(websocketUrl);
      passed = true;
      break;
    } catch (err) {
      lastError = err;
      console.error(`attempt ${attempt}/${MAX_ATTEMPTS} failed: ${(err as Error).message}`);
      if (err instanceof SmokeError && err.fatal) {
        console.error('failure is fatal (auth) — not retrying');
        break;
      }
      if (attempt < MAX_ATTEMPTS) {
        const backoff = BACKOFF_MS * attempt;
        console.error(`retrying in ${backoff}ms…`);
        await delay(backoff);
      }
    }
  }

  clearTimeout(watchdog);

  if (passed) {
    console.log(
      REQUIRE_TOOLS
        ? 'realtime smoke: PASSED — message_started → token(s) → tool_call_started → tool_call_completed(completed) → message_completed'
        : 'realtime smoke: PASSED — message_started → token(s) → message_completed',
    );
    process.exit(0);
  }

  console.error(`realtime smoke: FAILED after ${diag.attempt} attempt(s): ${(lastError as Error | undefined)?.message}`);
  printDiagnostics();
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error(`realtime smoke: unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  printDiagnostics();
  process.exit(1);
});
