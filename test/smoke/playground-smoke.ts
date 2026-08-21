import { z } from 'zod';
import { ChatEventSchema } from '@swiftagent/shared';
import { connectWs, type WsClient, type WsFrame } from '../support/ws-client.js';

/**
 * WS-49 · Playground live-URL smoke test (SC-08), on the realtime-smoke.ts
 * pattern: bounded everything, limited retries with backoff, diagnostics on
 * failure, `ChatEventSchema` validation of every relayed frame.
 *
 * Exercises the real visitor path against the DEPLOYED playground:
 *
 *   POST {PLAYGROUND_SMOKE_URL}/playground/session      (NO credential supplied)
 *     → assert the credential-free session_ready body (guest id + limits only)
 *     → connect ws(s)://…/playground/stream?gid=<guest>  (the ONLY socket)
 *     → send  { type: 'send', content: <a weather question> }   (mediator protocol)
 *     → assert the relayed stream: message_started → token(s) →
 *       tool_call_started → tool_call_completed (same callId, computable
 *       duration) → message_completed
 *
 * A mediator `refusal` frame fails the run loudly with its typed reason.
 *
 * Required env:
 *   PLAYGROUND_SMOKE_URL   deployed playground base URL, e.g. https://swift-agent-playground.fly.dev
 * Optional env:
 *   SMOKE_PROMPT           the message sent (default exercises get_weather)
 */

// ---- Bounds (everything is bounded — fail loud, never hang) -----------------

const OVERALL_BUDGET_MS = 90_000;
const CONNECT_TIMEOUT_MS = 15_000;
const WAIT_TIMEOUT_MS = 20_000;
const POST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 3_000;

const PROMPT = process.env.SMOKE_PROMPT ?? "What's the weather in Lisbon right now?";

// The mediator's session_ready shape (kept in lockstep with
// apps/playground/backend/src/mediator/protocol.ts — the smoke inlines it the
// same way realtime-smoke.ts inlines the session response schema).
const SESSION_READY_SCHEMA = z
  .object({
    type: z.literal('session_ready'),
    guestId: z.string().min(1),
    sessionId: z.string().min(1),
    expiresAt: z.string().min(1),
    limits: z
      .object({
        messagesPerSession: z.number().int().positive(),
        tokensPerSession: z.number().int().positive(),
        messageMaxChars: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

const MEDIATOR_FRAME_TYPES = new Set(['session_ready', 'refusal']);
/** Keys that must NEVER appear in any browser-bound payload. (`"token"` is a
 * legitimate ChatEvent *type value*, so the credential check targets the
 * credential-bearing keys.) */
const FORBIDDEN_KEYS = ['clientToken', 'websocketUrl', 'apiKey'];

class SmokeError extends Error {
  constructor(
    message: string,
    readonly fatal = false,
  ) {
    super(message);
    this.name = 'SmokeError';
  }
}

// ---- Diagnostics ------------------------------------------------------------

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
  console.error('---- playground smoke diagnostics ----');
  console.error(`attempts made: ${diag.attempt}`);
  if (diag.postStatus !== undefined) console.error(`POST /playground/session status: ${diag.postStatus}`);
  if (diag.postBody !== undefined) console.error(`POST /playground/session body: ${diag.postBody}`);
  if (diag.wsCloseCode !== undefined) {
    console.error(`WS close: code=${diag.wsCloseCode} reason=${JSON.stringify(diag.wsCloseReason ?? '')}`);
  }
  console.error(`frames received (${diag.frames.length}):`);
  for (const frame of diag.frames) console.error(`  ${JSON.stringify(frame)}`);
  console.error('--------------------------------------');
}

// ---- Helpers ----------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireEnv(): { baseUrl: string } {
  const baseUrl = process.env.PLAYGROUND_SMOKE_URL;
  if (!baseUrl) {
    console.error('playground smoke: missing required env: PLAYGROUND_SMOKE_URL');
    process.exit(1);
  }
  return { baseUrl: baseUrl.replace(/\/+$/, '') };
}

/** Relayed frames must be valid ChatEvents; mediator frames are checked separately. */
function assertValidChatEvent(frame: WsFrame): void {
  const parsed = ChatEventSchema.safeParse(frame);
  if (!parsed.success) {
    throw new SmokeError(
      `received malformed/unknown relayed frame ${JSON.stringify(frame)}: ${parsed.error.message}`,
    );
  }
}

function assertCredentialFree(serialized: string, where: string): void {
  for (const key of FORBIDDEN_KEYS) {
    if (serialized.includes(`"${key}"`)) {
      throw new SmokeError(`${where} leaked a credential-shaped key ${JSON.stringify(key)}: ${serialized}`, true);
    }
  }
}

// ---- Flow -------------------------------------------------------------------

/** POST /playground/session with NO credential; returns the guest payload. */
async function mintGuestSession(baseUrl: string): Promise<z.infer<typeof SESSION_READY_SCHEMA>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/playground/session`, {
      method: 'POST',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  diag.postStatus = res.status;
  diag.postBody = text.slice(0, 2_000);

  if (res.status === 429) {
    // The per-IP limiter answered with the typed refusal — retryable, not a bug.
    throw new SmokeError(`per-IP rate limited (429): ${text.slice(0, 300)}`);
  }
  if (res.status !== 200) {
    throw new SmokeError(`POST /playground/session returned ${res.status} (expected 200)`);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SmokeError('POST /playground/session returned a non-JSON body');
  }
  const parsed = SESSION_READY_SCHEMA.safeParse(json);
  if (!parsed.success) {
    throw new SmokeError(`session_ready body malformed: ${parsed.error.message}`);
  }
  // SC-09: the guest mint is credential-free — nothing token-shaped in the body.
  assertCredentialFree(text, 'session mint body');
  return parsed.data;
}

/**
 * A watcher that throws on a terminal `run_failed` or mediator `refusal`
 * frame, and otherwise stays pending forever (safe to Promise.race).
 */
function watchForFailure(client: WsClient): Promise<never> {
  return client
    .waitFor((frame) => frame.type === 'run_failed' || frame.type === 'refusal', OVERALL_BUDGET_MS)
    .then(
      (frame) => {
        throw new SmokeError(
          frame.type === 'run_failed'
            ? `run_failed: code=${String(frame.code)} message=${String(frame.message)}`
            : `mediator refusal: reason=${String(frame.reason)} message=${String(frame.message)}`,
        );
      },
      () => new Promise<never>(() => {}),
    );
}

/** The SC-08 assertion: streamed tokens + a visible tool call with a duration. */
async function assertStream(client: WsClient): Promise<void> {
  // The mediator confirms attachment before anything else.
  const ready = await client.waitForType('session_ready', WAIT_TIMEOUT_MS);
  assertCredentialFree(JSON.stringify(ready), 'session_ready frame');

  client.send({ type: 'send', content: PROMPT });

  const started = await client.waitForType('message_started', WAIT_TIMEOUT_MS);
  assertValidChatEvent(started);

  const token = await client.waitForType('token', WAIT_TIMEOUT_MS);
  assertValidChatEvent(token);

  const toolStarted = await client.waitForType('tool_call_started', WAIT_TIMEOUT_MS);
  assertValidChatEvent(toolStarted);
  const toolStartedAt = Date.now();

  const toolCompleted = await client.waitFor(
    (frame) => frame.type === 'tool_call_completed' && frame.callId === toolStarted.callId,
    WAIT_TIMEOUT_MS,
  );
  assertValidChatEvent(toolCompleted);
  const durationMs = Date.now() - toolStartedAt;

  if (toolCompleted.status !== 'completed') {
    throw new SmokeError(
      `tool call ${String(toolStarted.callId)} (${String(toolStarted.toolName)}) finished with status ${JSON.stringify(toolCompleted.status)} (expected 'completed')`,
    );
  }

  const completed = await client.waitForType('message_completed', WAIT_TIMEOUT_MS);
  assertValidChatEvent(completed);

  // Every relayed (non-mediator) frame received was a valid ChatEvent.
  for (const frame of client.frames) {
    if (typeof frame.type === 'string' && MEDIATOR_FRAME_TYPES.has(frame.type)) continue;
    assertValidChatEvent(frame);
    assertCredentialFree(JSON.stringify(frame), 'relayed frame');
  }

  console.log(
    `tool call ${String(toolStarted.toolName)} (${String(toolStarted.callId)}) completed in ~${durationMs}ms (arrival-timestamp delta)`,
  );
}

async function runOnce(baseUrl: string, guestId: string): Promise<void> {
  const wsBase = baseUrl.replace(/^http/, 'ws');
  const client = await connectWs(
    `${wsBase}/playground/stream?gid=${encodeURIComponent(guestId)}`,
    CONNECT_TIMEOUT_MS,
  );
  diag.frames = client.frames;
  diag.wsCloseCode = undefined;
  diag.wsCloseReason = undefined;
  client.socket.on('close', (code: number, reason: Buffer) => {
    diag.wsCloseCode = code;
    diag.wsCloseReason = reason.toString('utf-8');
  });

  try {
    await Promise.race([assertStream(client), watchForFailure(client)]);
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  const { baseUrl } = requireEnv();
  console.log(`playground smoke: base=${baseUrl} budget=${OVERALL_BUDGET_MS}ms prompt=${JSON.stringify(PROMPT)}`);

  const watchdog = setTimeout(() => {
    console.error(`playground smoke: exceeded overall budget of ${OVERALL_BUDGET_MS}ms — forcing exit`);
    printDiagnostics();
    process.exit(1);
  }, OVERALL_BUDGET_MS);

  let passed = false;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    diag.attempt = attempt;
    try {
      const guest = await mintGuestSession(baseUrl);
      console.log(`attempt ${attempt}/${MAX_ATTEMPTS}: minted guest ${guest.guestId} (session ${guest.sessionId}); connecting WS…`);
      await runOnce(baseUrl, guest.guestId);
      passed = true;
      break;
    } catch (err) {
      lastError = err;
      console.error(`attempt ${attempt}/${MAX_ATTEMPTS} failed: ${(err as Error).message}`);
      if (err instanceof SmokeError && err.fatal) {
        console.error('failure is fatal — not retrying');
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
      'playground smoke: PASSED — credential-free mint → session_ready → message_started → token(s) → tool_call_started → tool_call_completed(completed, computable duration) → message_completed',
    );
    process.exit(0);
  }

  console.error(`playground smoke: FAILED after ${diag.attempt} attempt(s): ${(lastError as Error | undefined)?.message}`);
  printDiagnostics();
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error(`playground smoke: unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  printDiagnostics();
  process.exit(1);
});
