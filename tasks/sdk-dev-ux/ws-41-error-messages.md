# WS-41: Setup & Runtime Error Messages

## Goal

Make Swift Agent's setup and runtime failures **actionable** instead of opaque. Today the SDK throws raw `Error`s at setup time (missing `apiKey`, missing runner-token env, duplicate tool name) and surfaces HTTP failures as an untyped `SdkHttpError` whose message is a bare `HTTP 401 Unauthorized: POST /v1/agents` — no `code`, no remediation, no way for a caller to branch on the failure class. On the client, `lastError` is populated from whatever lands in `onError`, which for a socket failure is a raw DOM `Event` (stringified to `[object Event]`) and for a `run_failed` event is only the server's free-text `message`.

This workstream:

1. Replaces the raw setup `throw new Error(...)` sites in `packages/sdk/src/app.ts` with `SwiftAgentError(VALIDATION, ...)` whose message **names the offending env key / config field and states the fix** (missing `apiKey`, missing `RUNNER_TOKEN_PUBLIC_KEY`, missing `RUNNER_WORKSPACE_ID`, duplicate tool name, malformed agent/tool config with the failing field named).
2. Maps `SdkHttpError` and `fetch` failures in `packages/sdk/src/client.ts` to typed `SwiftAgentError`s (UNAUTHORIZED / NOT_FOUND / CONFLICT / RATE_LIMIT / PROVIDER_ERROR / INTERNAL / CONNECTION_ERROR / TIMEOUT) with actionable messages, preserving `.cause`, so SDK consumers can `isSwiftAgentError(e)` and read `.code`.
3. Ensures the tool-runner returns **bounded, readable** structured errors on a handler throw / validation failure / timeout (respecting `RUNNER_MAX_ERROR_BYTES`) and never leaks a raw stack to the wire.
4. Makes the React client's `lastError` a **typed, human-readable string** for connection failure, auth rejection (gateway close codes / `AUTH_REQUIRED`), and `run_failed` — never a raw DOM `Event` or `[object Event]`.
5. Adds a minimal "error reference" doc-comment (code → meaning → remediation) co-located with the error type, without duplicating WS-40's README work.

The `SwiftAgentError` class, the `SwiftAgentErrorCode` const map, `CODE_TO_STATUS`, and `isSwiftAgentError` **already exist** in `@swiftagent/shared` (pasted verbatim below) — this workstream **consumes and routes** them, it does **not** redesign them. No new error code is required by WS-41; if one is genuinely needed it must be added to **both** the const map and `CODE_TO_STATUS` in lockstep (see Design Notes).

## Traceability

- **SC-07:** Setup errors (missing/invalid API key, missing env keys, malformed agent/tool config) produce actionable messages naming the offending key/field and the remediation. — Delivered by the `app.ts` throw-site replacements (Steps 2–4) and the malformed-config wrap (Step 4); covered by Tests 1–5.
- **SC-08:** Runtime errors (connection/auth, tool-runner unreachable, tool-handler throw, model/provider failure) surface as typed, human-readable errors through the SDK and the React client's `lastError`. — Delivered by the `client.ts` `SdkHttpError`→`SwiftAgentError` mapping (Step 5), the tool-runner bounded-error hardening (Step 6), and the React `lastError` typing (Steps 7–8); covered by Tests 6–14.
- **SC-10:** Monorepo type-checking, linting, unit tests, and integration tests pass. — `pnpm typecheck` + `pnpm lint` + `pnpm test` (+ `pnpm test:integration` where Docker is available) green after this change (Step 9); covered by Acceptance Criteria 10.

## Dependencies

- **WS-36 — Finalized SDK surface (in-program):** WS-36 relocates `SdkHttpError`, `ControlPlaneClient`, `startToolRunner`, `ToolRunnerRequestSchema`, `SdkAgentConfigSchema` from the `@swiftagent/sdk` **root barrel** to a declared `@swiftagent/sdk/internal` subpath, and prunes `chatReducer`/`initialChatState`/`ChatState`/`ChatAction`/`InternalAction` from the `@swiftagent/react` root barrel. **Coordination:** WS-41 does **not** add any new value export to the SDK root barrel. `SwiftAgentError` / `SwiftAgentErrorCode` / `isSwiftAgentError` are re-exported from **`@swiftagent/shared`** (already public) — consumers import error types from there, so WS-41's public error contract is orthogonal to WS-36's barrel audit. If WS-36 has already landed when this workstream starts, import `SdkHttpError` from `./types.js` intra-package (unchanged) and do not touch the barrels; if WS-41 lands first, keep `SdkHttpError` where it is and let WS-36 relocate it. Neither ordering requires a code change in the other.
- **WS-37 — Versioning/Compat policy (in-program, lockstep-code overlap):** WS-37 adds a **new** `INCOMPATIBLE_VERSION` code to `SwiftAgentErrorCode` **and** `CODE_TO_STATUS: 409` in `packages/shared/src/types/errors.ts`. WS-41 does **not** add a code by default. If both workstreams end up editing `errors.ts`, they touch **disjoint** entries; whoever lands second must re-read the file (CLAUDE.md rule 9) and preserve the other's entry. Do **not** reuse `INCOMPATIBLE_VERSION` for a WS-41 concern.

## Context Files (Agent MUST read before implementing)

Per **CLAUDE.md** rule 6/9, re-read each file immediately before editing it (do not trust memory or this paste after 10+ messages). Per rule 10, when routing/renaming any symbol, grep **separately** for direct refs, type-level refs, string literals, dynamic imports, re-exports/barrels, and tests.

- `CLAUDE.md` — mechanical overrides. Binding here: **rule 4** forced verification (`pnpm typecheck` + `pnpm lint` + `pnpm test`, fix ALL), **rule 9** re-read before/after each edit, **rule 10** no-semantic-search grep discipline.
- `packages/shared/src/types/errors.ts` — `SwiftAgentError`, `SwiftAgentErrorCode`, `CODE_TO_STATUS`, `isSwiftAgentError`. The error contract to consume. Pasted verbatim below. Do **not** redesign it.
- `packages/shared/src/config.ts` — `ENV_KEYS` (single source of truth for env var names) and `loadConfig` (Zod-validated). Pasted below.
- `packages/shared/src/types/runner-protocol.ts` — `RUNNER_PROTOCOL_VERSION`, `RUNNER_MAX_ERROR_BYTES` (8 KiB), and the request/response envelope schemas. Pasted (relevant parts) below.
- `packages/shared/src/types/events.ts` — `RunFailedEvent` (`type`/`runId`/`sessionId`/`code`/`message`/`cause?`) and `ChatEventSchema`. Pasted below.
- `packages/sdk/src/app.ts` — the raw `throw new Error(...)` setup sites (`apiKey`, `RUNNER_TOKEN_PUBLIC_KEY`, `RUNNER_WORKSPACE_ID`, duplicate tool name). Pasted below.
- `packages/sdk/src/client.ts` — `ControlPlaneClient.request` throws `SdkHttpError` on non-2xx; `fetch` can reject (network) or the body parse can fail. Pasted below.
- `packages/sdk/src/tool-runner.ts` — `executeTool` normalizes handler throw / timeout to a `HandlerOutcome`; `capError` bounds messages to `RUNNER_MAX_ERROR_BYTES`. Pasted below.
- `packages/sdk/src/types.ts` — `SdkHttpError` class, `CreateAgentAppConfig`, `SdkAgentConfigSchema`, `ToolDefinition`, `ToolRegistry`.
- `packages/sdk/src/index.ts` — SDK root barrel (coordinate with WS-36; do not add value exports here for WS-41).
- `packages/react/src/client.ts` — `createChatSession`: `ws.onmessage` parse-failure → `onError`; `ws.onclose`/`ws.onerror` (reconnect). WS-34 owns the URL/reconnect logic — do not regress it. Pasted below.
- `packages/react/src/hooks/use-connection.ts` — wraps `createChatSession`; sets `lastError` from `onError` via `err instanceof Error ? err.message : String(err)`. Pasted below.
- `packages/react/src/hooks/use-agent-chat.ts` — exposes `lastError` from `useConnection` and dispatches `ChatEvent`s into the reducer.
- `packages/react/src/state.ts` — `chatReducer`; `run_failed` sets `lastError: action.message`. Pasted (relevant case) below.
- `packages/react/src/types.ts` — `lastError: string | null` on `UseAgentChatResult`; `onError?: (error: unknown) => void`.
- `tasks/sdk-dev-ux/ws-34-client-docs-alignment.md` — the client URL/reconnect contract WS-41 must **not** break.
- `tasks/sdk-dev-ux/ws-36-sdk-api-finalization.md`, `tasks/sdk-dev-ux/ws-37-versioning-compat-policy.md` — read for the barrel/lockstep coordination described in Dependencies. Do not edit.

## Package

- **`packages/shared`** — only if a doc-comment "error reference" is added to `errors.ts` (no code-behavior change; no new code unless one is genuinely required and added in lockstep).
- **`packages/sdk`** — primary: `app.ts` setup throws, `client.ts` HTTP/network mapping, `tool-runner.ts` bounded-error hardening.
- **`packages/react`** — `client.ts` / `use-connection.ts` / `state.ts` so `lastError` is a typed readable string on connection/auth/`run_failed`.
- **`packages/api`** — **out of scope.** The runner/gateway already emit structured `{ code, message }` shapes; WS-41 changes only how the **SDK/client** produce and surface errors. Do not add an API pass-through.

## Files Touched

- `packages/sdk/src/app.ts` **(MODIFY)** — replace the four raw `throw new Error(...)` sites with `SwiftAgentError(VALIDATION, <actionable message>)`; wrap malformed agent/tool config via `SdkAgentConfigSchema` (or the tool schema) into a `SwiftAgentError(VALIDATION, ...)` naming the failing field.
- `packages/sdk/src/client.ts` **(MODIFY)** — in `request`, wrap `fetch` rejection as `CONNECTION_ERROR`/`TIMEOUT`; map the non-2xx `SdkHttpError` to a typed `SwiftAgentError` (via a small `httpErrorToSwiftAgentError` helper) with an actionable message and `cause` set to the original `SdkHttpError`.
- `packages/sdk/src/types.ts` **(MODIFY, minimal)** — `SdkHttpError` stays as-is (internal wire error). Only add a JSDoc line noting it is wrapped into `SwiftAgentError` by `client.ts`. No shape change.
- `packages/sdk/src/tool-runner.ts` **(MODIFY)** — ensure `executeTool` never returns a raw stack: the handler-throw branch already uses `err.message`; add an explicit comment + a guard so a non-`Error` throw is stringified safely, and confirm every wire error path routes through `capError`. (Largely hardening + one guard; see Step 6.)
- `packages/react/src/client.ts` **(MODIFY)** — in `ws.onclose`, capture the WebSocket close `code`/`reason` and surface a typed, readable error through a new internal `emitError` path (feeding `onError`) for abnormal/auth closes; keep WS-34's reconnect/backoff and URL logic untouched.
- `packages/react/src/hooks/use-connection.ts` **(MODIFY, minimal)** — the `onError` → `setLastError(err instanceof Error ? err.message : String(err))` mapping already yields a string; ensure a passed `SwiftAgentError` yields its `.message` (it is an `Error`, so this already holds) and that a raw `Event` is never stringified to `[object Event]` (the client change in the line above prevents raw `Event`s from reaching here). No signature change.
- `packages/react/src/state.ts` **(MODIFY, minimal)** — `run_failed` already sets `lastError: action.message`; optionally prefix with the `code` for readability (`[${action.code}] ${action.message}`) — decide in Step 8, keep it a plain string.
- `packages/shared/src/types/errors.ts` **(MODIFY, doc-only)** — add a concise block doc-comment mapping each `SwiftAgentErrorCode` → meaning → remediation (the "error reference"). No behavioral change. Coordinate with WS-40 so this is a short code doc, not a duplicate README.
- `packages/sdk/src/__tests__/app.test.ts`, `packages/sdk/src/__tests__/client.test.ts`, `packages/sdk/src/__tests__/tool-runner.test.ts` **(NEW or MODIFY)** — verify with a glob for the existing test locations/names before creating; reuse the existing harness/mocks.
- `packages/react/src/__tests__/client.test.ts` (or the existing react test file) **(NEW or MODIFY)** — `lastError` typing tests; locate the existing file by glob first.

> Confirm exact test-file paths/names with `Glob` (`packages/sdk/**/*.test.ts`, `packages/react/**/*.test.ts`) before writing — do not invent a new harness if one exists.

## Existing Interfaces to Consume

### `SwiftAgentError` + code map (VERBATIM) — `packages/shared/src/types/errors.ts`

```ts
export const SwiftAgentErrorCode = {
  VALIDATION: 'VALIDATION',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMIT: 'RATE_LIMIT',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  INTERNAL: 'INTERNAL',
  TIMEOUT: 'TIMEOUT',
  CONNECTION_ERROR: 'CONNECTION_ERROR',
} as const;

export type SwiftAgentErrorCode = typeof SwiftAgentErrorCode[keyof typeof SwiftAgentErrorCode];

const CODE_TO_STATUS: Record<SwiftAgentErrorCode, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMIT: 429,
  PROVIDER_ERROR: 502,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  INTERNAL: 500,
  TIMEOUT: 504,
  CONNECTION_ERROR: 503,
};

export class SwiftAgentError extends Error {
  readonly code: SwiftAgentErrorCode;
  readonly statusCode: number;
  override readonly cause?: unknown;

  constructor(
    code: SwiftAgentErrorCode,
    message: string,
    options?: { cause?: unknown; statusCode?: number },
  ) {
    super(message);
    this.name = 'SwiftAgentError';
    this.code = code;
    this.statusCode = options?.statusCode ?? CODE_TO_STATUS[code];
    this.cause = options?.cause;
  }

  toJSON(): { code: SwiftAgentErrorCode; message: string; statusCode: number } {
    return { code: this.code, message: this.message, statusCode: this.statusCode };
  }
}

export function isSwiftAgentError(value: unknown): value is SwiftAgentError {
  return value instanceof SwiftAgentError;
}
```

Exported from `@swiftagent/shared` (`packages/shared/src/index.ts`):

```ts
export { SwiftAgentErrorCode, SwiftAgentError, isSwiftAgentError } from './types/errors.js';
```

### `ENV_KEYS` + `loadConfig` (relevant) — `packages/shared/src/config.ts`

```ts
export const ENV_KEYS = {
  // ...
  RUNNER_TOKEN_PUBLIC_KEY: 'RUNNER_TOKEN_PUBLIC_KEY',
  RUNNER_AUDIENCE: 'RUNNER_AUDIENCE',
  RUNNER_WORKSPACE_ID: 'RUNNER_WORKSPACE_ID',
  TOOL_RUNNER_PUBLIC_URL: 'TOOL_RUNNER_PUBLIC_URL',
  // ...
} as const;

// Zod-validated; throws ZodError on missing/invalid required vars.
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  return ConfigSchema.parse(env);
}
```

### Current raw setup throws (VERBATIM) — `packages/sdk/src/app.ts`

```ts
export function createAgentApp(config: CreateAgentAppConfig): AgentApp {
  if (!config.apiKey) {
    throw new Error('apiKey is required');
  }
  // ...
  agent(definition: AgentDefinition): AgentApp {
    for (const t of definition.tools) {
      if (toolsByName.has(t.name)) {
        throw new Error(
          `Duplicate tool name "${t.name}" — already registered by another agent`,
        );
      }
      toolsByName.set(t.name, t as ToolDefinition);
    }
    agents.push(definition);
    return app;
  },
  // ...
  async listen(port?: number): Promise<void> {
    // ...
    const publicKeyMaterial = config.runnerPublicKey ?? process.env[ENV_KEYS.RUNNER_TOKEN_PUBLIC_KEY];
    if (!publicKeyMaterial) {
      throw new Error(
        `Runner verification requires ${ENV_KEYS.RUNNER_TOKEN_PUBLIC_KEY} (PEM or JWK)`,
      );
    }
    const expectedWorkspaceId = config.runnerWorkspaceId ?? process.env[ENV_KEYS.RUNNER_WORKSPACE_ID];
    if (!expectedWorkspaceId) {
      throw new Error(`Runner verification requires ${ENV_KEYS.RUNNER_WORKSPACE_ID}`);
    }
    // ...
  }
}
```

### `SdkHttpError` + `request` (VERBATIM) — `packages/sdk/src/types.ts` and `client.ts`

```ts
// types.ts
export class SdkHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'SdkHttpError';
  }
}
```

```ts
// client.ts — the current throw site (no network/timeout handling, no typing)
private async request(method: string, path: string, body?: unknown): Promise<unknown> {
  const url = `${this.baseUrl}${path}`;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${this.apiKey}`,
    'Accept': 'application/json',
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);                       // ← can REJECT on network/DNS/refused
  const responseBody: unknown = await res.json().catch(() => null);

  if (!res.ok) {
    throw new SdkHttpError(
      `HTTP ${res.status} ${res.statusText}: ${method} ${path}`,
      res.status,
      responseBody,
    );
  }
  return responseBody;
}
```

### Tool-runner handler-throw normalization (VERBATIM) — `packages/sdk/src/tool-runner.ts`

```ts
/** Constant-time-ish cap; truncates an error message to the protocol byte bound. */
function capError(message: string): string {
  if (Buffer.byteLength(message, 'utf-8') <= RUNNER_MAX_ERROR_BYTES) return message;
  return Buffer.from(message, 'utf-8').subarray(0, RUNNER_MAX_ERROR_BYTES).toString('utf-8');
}

async function executeTool(
  execute: (input: unknown, ctx: ToolContext) => Promise<unknown>,
  input: unknown,
  ctx: ToolContext,
  toolName: string,
  toolTimeoutMs: number,
): Promise<HandlerOutcome> {
  try {
    const result = await Promise.race([
      execute(input, ctx),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new ToolTimeoutError(toolName, toolTimeoutMs)), toolTimeoutMs);
      }),
    ]);
    return { ok: true, result };
  } catch (err) {
    if (err instanceof ToolTimeoutError) {
      return { ok: false, status: 504, code: 'TIMEOUT', message: err.message };
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { ok: false, status: 500, code: 'EXECUTION_ERROR', message };
  }
}
```

The wire error path already routes through `capError` in the route handler:

```ts
return reply.status(outcome.status).send({
  version: RUNNER_PROTOCOL_VERSION,
  error: { code: outcome.code, message: capError(outcome.message) },
});
```

`RUNNER_MAX_ERROR_BYTES = 8 * 1024` (from `packages/shared/src/types/runner-protocol.ts`).

### `RunFailedEvent` (VERBATIM) — `packages/shared/src/types/events.ts`

```ts
export type RunFailedEvent = {
  type: 'run_failed';
  runId: string;
  sessionId: string;
  code: string;
  message: string;
  cause?: unknown;
};
```

### React `lastError` surface (VERBATIM)

```ts
// packages/react/src/hooks/use-connection.ts — onError → lastError
onError: (err) => {
  setLastError(err instanceof Error ? err.message : String(err));
  options?.onError?.(err);
},
```

```ts
// packages/react/src/client.ts — parse failure and close (reconnect owned by WS-34)
ws.onmessage = (event: MessageEvent): void => {
  try {
    const data: unknown = JSON.parse(String(event.data));
    const parsed = ChatEventSchema.parse(data);
    for (const handler of eventHandlers) handler(parsed);
  } catch (err) {
    onError?.(err);
  }
};

ws.onclose = (): void => {                 // ← close code/reason currently discarded
  ws = null;
  setStatus('disconnected');
  if (!intentionalClose) {
    scheduleReconnect();
  }
};

ws.onerror = (): void => {
  // onclose will fire after onerror — reconnection handled there
};
```

```ts
// packages/react/src/state.ts — run_failed sets lastError from the event message
case 'run_failed': {
  return {
    ...state,
    isStreaming: false,
    lastError: action.message,
    messages: state.messages.map((m) =>
      m.status === 'streaming' ? { ...m, status: 'complete' as const } : m,
    ),
  };
}
```

The gateway emits an `AUTH_REQUIRED` error frame and closes with code `4001` on a missing/invalid token (established in WS-34's gateway paste):

```ts
socket.send(JSON.stringify(toErrorEvent('AUTH_REQUIRED', 'Missing token query parameter')));
socket.close(4001, 'Missing token');
```

## Design Notes

### Status ↔ code mapping (the one WS-41 owns: HTTP status → `SwiftAgentErrorCode`)

Used by the new `httpErrorToSwiftAgentError` helper in `packages/sdk/src/client.ts`. It is the **inverse routing** of `CODE_TO_STATUS`, resolved for the ranges the control plane actually returns:

| HTTP status | `SwiftAgentErrorCode` | Actionable message guideline |
|---|---|---|
| 400 | `VALIDATION` | Name the endpoint/field; "check the request payload for `<path>`". Prefer the server body's `message` if present. |
| 401 | `UNAUTHORIZED` | "Authentication failed — check `SWIFT_AGENT_API_KEY` / the workspace API key passed to `createAgentApp`." |
| 403 | `FORBIDDEN` | "The API key lacks permission for `<method> <path>` — check the key's workspace scope." |
| 404 | `NOT_FOUND` | Name the resource: "`<method> <path>` not found — verify the session/agent/run id." |
| 409 | `CONFLICT` | Surface the server's message; "the resource already exists or is in a conflicting state." |
| 429 | `RATE_LIMIT` | "Rate limited — retry after backing off." |
| 500 | `INTERNAL` | "The server encountered an internal error — retry; if persistent, contact support." |
| 502 / 503 / 504 | `PROVIDER_ERROR` (502), `CONNECTION_ERROR` (503), `TIMEOUT` (504) | Upstream/model-provider or gateway failure — "the model provider or an upstream dependency failed; retry." |
| other 5xx | `INTERNAL` | Fallback. |
| `fetch` rejects (network/DNS/ECONNREFUSED) | `CONNECTION_ERROR` | "Could not reach the Swift Agent server at `<baseUrl>` — is it running and is `baseUrl` correct?" |
| `fetch` abort / request timeout | `TIMEOUT` | "The request to `<baseUrl><path>` timed out." |

Rules for the helper:
- **Prefer the server body's message when structured.** If `body` parses to `{ code?, message? }` (it often does — the API/runner emit `{ code, message }`), incorporate the server `message` and, when the server `code` is a known `SwiftAgentErrorCode`, honor it over the status-derived one. Otherwise derive `code` from `status` per the table.
- **Always set `cause` to the original `SdkHttpError`** (or the raw `fetch` rejection) so no context is lost. `SwiftAgentError` already carries `cause`.
- **Do not leak internals into the message** — keep it one human sentence + the naming/remediation hint. The raw status/path stays available via `.cause`.

### Actionable-message guidelines (setup, `app.ts`)

Each replaced throw must **name the offending key/field** and **state the fix**, e.g.:
- `apiKey` missing → `SwiftAgentError(VALIDATION, 'createAgentApp requires an "apiKey" — pass your workspace API key (e.g. process.env.SWIFT_AGENT_API_KEY) to createAgentApp({ apiKey }).')`
- `RUNNER_TOKEN_PUBLIC_KEY` missing → `SwiftAgentError(VALIDATION, \`Runner verification requires the ${ENV_KEYS.RUNNER_TOKEN_PUBLIC_KEY} env var (PEM/SPKI or JWK JSON) or the runnerPublicKey option — set one before calling app.listen().\`)`
- `RUNNER_WORKSPACE_ID` missing → `SwiftAgentError(VALIDATION, \`Runner verification requires the ${ENV_KEYS.RUNNER_WORKSPACE_ID} env var (the runner's ws_ workspace id) or the runnerWorkspaceId option.\`)`
- Duplicate tool name → `SwiftAgentError(VALIDATION, \`Duplicate tool name "${t.name}" — each tool name must be unique across all agents registered on this app; rename one.\`)` (keep `CONFLICT`? No — this is a developer config mistake caught at build time, so `VALIDATION` is correct; `CONFLICT` is for server-side resource state.)
- **Malformed agent/tool config:** where an agent/tool is added, run it through `SdkAgentConfigSchema` (agent) or validate the tool shape, and on a Zod failure wrap into `SwiftAgentError(VALIDATION, \`Invalid agent config: <first issue path> — <issue message>\`, { cause: zodError })`, naming the failing field from `zodError.issues[0].path`. Keep it to the first (or a short joined list of) issue(s) so the message stays readable and bounded.

### Tool-runner: bounded, no-stack (SC-08)

The runner already (a) caps every wire error via `capError` to `RUNNER_MAX_ERROR_BYTES`, and (b) uses `err.message` (never `err.stack`) in `executeTool`. WS-41 hardens this:
- Confirm the non-`Error` throw branch stringifies safely (it uses the literal `'Unknown error'` today — keep that; do **not** `String(err)` an arbitrary object into the wire, as it can leak). Add a comment stating the deliberate no-stack, no-arbitrary-object policy.
- Confirm the `setErrorHandler` fallback (`{ code: 'INTERNAL', message: capError(err.message) }`) also never emits a stack — it uses `err.message`, which is correct; leave it.
- Note the runner returns wire `code`s (`TIMEOUT`, `EXECUTION_ERROR`, `VALIDATION`, `NOT_FOUND`, `UNAUTHORIZED`, `INTERNAL`) that are the **runner protocol** codes, not `SwiftAgentErrorCode`. That is intentional — the runner speaks the runner protocol; the **runtime executor** (in `packages/api`/runtime, out of scope here) maps those to a `run_failed` event. WS-41 does not change the runner's protocol codes.

### React `lastError`: typed & readable, don't break WS-34 (SC-08)

Three failure sources must yield a **plain readable string** on `lastError`, never `[object Event]`:
1. **`run_failed` event** — already routed through the reducer to `lastError: action.message`. Optionally prefix `[${code}] ` for readability (Step 8). Keep a string.
2. **Malformed frame** (`ws.onmessage` parse throw) — already reaches `onError` with a real `Error`; `use-connection` maps it to `err.message`. Good; just confirm.
3. **Connection/auth failure** — the gap. `ws.onclose` currently discards `code`/`reason`, and `ws.onerror` fires with a raw DOM `Event`. **Fix:** in `ws.onclose(event)`, read `event.code`/`event.reason`; for an **abnormal or auth** close (`code === 4001`, any `4xxx` app-close, or a non-1000 close while not `intentionalClose`) call a small internal `emitError(...)` that invokes `onError` with a real `Error` (or `SwiftAgentError(UNAUTHORIZED/CONNECTION_ERROR, ...)`) carrying a readable message like `Connection closed (4001): Missing token — check the client token / websocketUrl.` Do **not** pass the raw `Event` to `onError`. **Do not** change `scheduleReconnect`, the backoff math, the `messageQueue` flush, the `createWebSocket` injection, or the URL resolution — those are WS-34's contract. The only new behavior is emitting a typed readable error alongside the existing reconnect on an abnormal close.
   - Since `@swiftagent/react` already depends on `@swiftagent/shared` (for `ChatEventSchema`), importing `SwiftAgentError` there is free; prefer it over a bare `Error` so `lastError` derivation stays uniform. `use-connection` maps any `Error`/`SwiftAgentError` to `.message`, so the string stays clean either way.

### Lockstep-code rule (only if a new code is unavoidable)

WS-41 should need **no** new code — every failure fits an existing `SwiftAgentErrorCode`. If review reveals a genuine gap, add the new key to **both** `SwiftAgentErrorCode` and `CODE_TO_STATUS` in the same edit (the `Record<SwiftAgentErrorCode, number>` type makes `tsc` fail if you update only one), re-export nothing new (they're already barrel-exported), and coordinate with WS-37 so you do not collide with `INCOMPATIBLE_VERSION`. Document the justification in the PR.

### Error-reference doc (minimal, coordinate with WS-40)

Add a single block doc-comment above `SwiftAgentErrorCode` in `packages/shared/src/types/errors.ts` mapping each code → one-line meaning → one-line remediation. This lives in-code (discoverable at the type) and is intentionally terse; the fuller prose reference is **WS-40's** README job — do not duplicate it. If WS-40 has already added a README error table, this doc-comment simply points to it in one line.

## Implementation Steps

1. **Re-read (CLAUDE.md 6/9).** Immediately re-read `packages/shared/src/types/errors.ts`, `config.ts`, `packages/sdk/src/app.ts`, `client.ts`, `types.ts`, `tool-runner.ts`; and `packages/react/src/client.ts`, `hooks/use-connection.ts`, `state.ts`, `types.ts`. Confirm the pasted code matches reality. Glob `packages/sdk/**/*.test.ts` and `packages/react/**/*.test.ts` to locate existing test files/harnesses.

2. **`app.ts` — apiKey.** Replace `throw new Error('apiKey is required')` with `throw new SwiftAgentError(SwiftAgentErrorCode.VALIDATION, '<actionable message naming apiKey + fix>')`. Import `SwiftAgentError`, `SwiftAgentErrorCode` from `@swiftagent/shared`.

3. **`app.ts` — runner env + duplicate tool.** Replace the `RUNNER_TOKEN_PUBLIC_KEY`, `RUNNER_WORKSPACE_ID`, and duplicate-tool-name `throw new Error(...)` with `SwiftAgentError(VALIDATION, ...)` per the Actionable-message guidelines, each naming the `ENV_KEYS.*` constant / tool name and the remediation.

4. **`app.ts` — malformed agent/tool config.** In `agent(definition)` (and/or the ergonomic config path), validate via `SdkAgentConfigSchema` (import from `./types.js`) — or the tool's `inputSchema` shape — and on a Zod failure throw `SwiftAgentError(VALIDATION, \`Invalid agent config: <path> — <message>\`, { cause: zodError })`, naming the first failing field. Do not over-validate already-typed internal shapes; target the developer-supplied config surface.

5. **`client.ts` — HTTP + network mapping.** Add a private/module `httpErrorToSwiftAgentError(err, ctx)` implementing the status↔code table. In `request`: wrap the `await fetch(...)` in try/catch → on rejection throw `SwiftAgentError(CONNECTION_ERROR|TIMEOUT, <"could not reach <baseUrl>"| "timed out">, { cause: err })`. Keep the existing `SdkHttpError` throw **internal** to `request` but immediately convert it: build the `SdkHttpError`, then `throw httpErrorToSwiftAgentError(sdkHttpError, { method, path, baseUrl })`. Preserve `.cause` (the `SdkHttpError`, which still carries `status`/`body` for advanced callers). Prefer the server body's `{ code, message }` when structured (see Design Notes).

6. **`tool-runner.ts` — bounded/no-stack hardening.** Confirm (and comment) that `executeTool` uses `err.message` (never `.stack`) and the non-`Error` branch keeps the literal `'Unknown error'` (do not `String(err)` an arbitrary object to the wire). Confirm every `reply.*.send({ error: { ... } })` message goes through `capError`. Add a one-line comment documenting the `RUNNER_MAX_ERROR_BYTES` bound + no-stack policy. This step is mostly assertion-via-test + a comment; only add a guard if a path is found that could emit a stack or an unbounded string.

7. **`react/client.ts` — typed close/error.** Change `ws.onclose` to `ws.onclose = (event: CloseEvent): void => { ... }`; keep the existing `ws = null; setStatus('disconnected'); if (!intentionalClose) scheduleReconnect();` **unchanged**, and **add**: when `!intentionalClose` and the close is abnormal/auth (`event.code === 4001` or `event.code >= 4000` or `event.code !== 1000`), call `onError?.(new SwiftAgentError(<UNAUTHORIZED for 4001, else CONNECTION_ERROR>, \`Connection closed (${event.code})${event.reason ? ': ' + event.reason : ''} — <remediation>\`))`. Import `SwiftAgentError`/`SwiftAgentErrorCode` from `@swiftagent/shared`. Leave `ws.onerror` as-is (its raw `Event` must **not** be forwarded to `onError`). Do not touch reconnect/backoff/queue/URL logic (WS-34).

8. **`react/state.ts` — readable run_failed (optional prefix).** Optionally change `lastError: action.message` to `lastError: \`[${action.code}] ${action.message}\`` for readability, keeping it a plain string. If you keep it as `action.message`, document why. No shape change to `ChatState.lastError` (`string | null`).

9. **Verify (CLAUDE.md 4 — forced verification).** From the repo root run `pnpm typecheck`, then `pnpm lint`, then `pnpm test`, then (where Docker is available) `pnpm test:integration`. Fix **all** errors. Cross-check any pre-existing failure against the user-memory notes (server vitest exit 1; api `/health`+`/workspaces`; root `test/` tree not typechecked) and confirm it is unrelated before proceeding. Report exact commands + results.

10. **Doc-comment + coordination.** Add the terse error-reference block doc-comment to `errors.ts` (Design Notes). Grep (CLAUDE.md rule 10) for every `throw new Error(` under `packages/sdk/src` to confirm no setup throw was missed, and for every `SdkHttpError` reference to confirm the mapping is the sole surfacing path. Confirm no new value export was added to the SDK root barrel (WS-36 coordination).

## Tests

Vitest; reuse existing harnesses/mocks. Locate the real test files by glob first (Step 1).

**Setup errors (SC-07) — `packages/sdk`:**

1. **Missing `apiKey`.** `createAgentApp({ apiKey: '' })` (or omitted) throws; assert `isSwiftAgentError(e)`, `e.code === 'VALIDATION'`, and `e.message` contains `apiKey`.
2. **Missing `RUNNER_TOKEN_PUBLIC_KEY`.** With no `runnerPublicKey` option and the env var unset, `app.listen()` throws `SwiftAgentError(VALIDATION)` whose message contains the string `RUNNER_TOKEN_PUBLIC_KEY`.
3. **Missing `RUNNER_WORKSPACE_ID`.** With the public key present but no workspace id (option or env), `app.listen()` throws `SwiftAgentError(VALIDATION)` whose message contains `RUNNER_WORKSPACE_ID`.
4. **Duplicate tool name.** Registering two agents that share a tool name throws `SwiftAgentError(VALIDATION)` whose message contains the duplicated tool name.
5. **Malformed agent config.** Adding an agent with an invalid config (e.g. empty `name`, or `temperature` out of `[0,2]`) throws `SwiftAgentError(VALIDATION)` whose message names the failing field (path) and whose `.cause` is the underlying `ZodError`.

**Runtime HTTP mapping (SC-08) — `packages/sdk/src/client.ts`** (mock `fetch`):

6. **401 → UNAUTHORIZED.** A 401 response makes `request` (via any public method, e.g. `getSession`) throw `SwiftAgentError`; assert `e.code === 'UNAUTHORIZED'`, `e.statusCode === 401`, message mentions the API key, and `e.cause instanceof SdkHttpError` with `.status === 401`.
7. **404 → NOT_FOUND / 409 → CONFLICT / 429 → RATE_LIMIT / 500 → INTERNAL / 502 → PROVIDER_ERROR.** Table-driven: each status maps to the expected `code` and `statusCode`, with `cause` preserved.
8. **Server-supplied structured body honored.** When the mocked response body is `{ code: 'FORBIDDEN', message: 'key lacks scope' }` with HTTP 403, the thrown error's `code === 'FORBIDDEN'` and message includes the server message.
9. **Network refusal → CONNECTION_ERROR.** Mock `fetch` to reject (e.g. `TypeError: fetch failed`); assert the thrown error is `SwiftAgentError(CONNECTION_ERROR)`, message names the `baseUrl`, and `.cause` is the original rejection.

**Tool-runner bounded error (SC-08) — `packages/sdk/src/tool-runner.ts`:**

10. **Handler throw → bounded structured error, no stack.** A tool whose `execute` throws `new Error('boom\n<stack-like>')` yields a runner error response `{ error: { code: 'EXECUTION_ERROR', message } }` where `message` equals the thrown `.message` (not the stack) and `Buffer.byteLength(message) <= RUNNER_MAX_ERROR_BYTES`.
11. **Over-long handler message is capped.** A handler throwing a message > 8 KiB yields a wire `message` with `Buffer.byteLength(...) <= RUNNER_MAX_ERROR_BYTES` (via `capError`).
12. **Handler timeout → TIMEOUT.** A handler exceeding `toolTimeoutMs` yields `{ error: { code: 'TIMEOUT', message } }` naming the tool + timeout; message is bounded.

**React `lastError` (SC-08) — `packages/react`:**

13. **`run_failed` → readable string.** Dispatch a `run_failed` event through the reducer (or drive the hook with a mocked socket emitting it); assert `lastError` is the (optionally `[code]`-prefixed) `message` string — never `[object Object]`/`[object Event]`.
14. **Auth/abnormal close → typed readable error, reconnect preserved.** With the injected `createWebSocket` mock, fire `onclose` with `{ code: 4001, reason: 'Missing token' }` (non-intentional); assert `onError` received an `Error`/`SwiftAgentError` (not a raw `Event`), `use-connection` sets `lastError` to a readable string containing `4001`, **and** `scheduleReconnect` still fires (WS-34 backoff unbroken — assert the factory is re-invoked after the delay with mock timers). A normal `{ code: 1000 }` close does **not** set `lastError`.

## Acceptance Criteria

1. Every setup `throw new Error(...)` in `packages/sdk/src/app.ts` (`apiKey`, `RUNNER_TOKEN_PUBLIC_KEY`, `RUNNER_WORKSPACE_ID`, duplicate tool name) is now a `SwiftAgentError(VALIDATION, ...)` whose message **names the offending key/field and states the remediation** (Tests 1–4). A grep for `throw new Error(` under `packages/sdk/src` shows no remaining setup throw.
2. Malformed developer-supplied agent/tool config throws `SwiftAgentError(VALIDATION)` naming the failing field, with the `ZodError` preserved as `.cause` (Test 5).
3. `ControlPlaneClient` surfaces all non-2xx and network/timeout failures as `SwiftAgentError` — never a bare `SdkHttpError` or raw `fetch` rejection to the caller — with `code`/`statusCode` per the status↔code table, an actionable message, and `.cause` preserved (Tests 6–9). `isSwiftAgentError(e)` is `true` for every thrown runtime error.
4. When the server returns a structured `{ code, message }` body, the mapping honors a known server `code` and includes the server `message` (Test 8).
5. The tool-runner returns **bounded** (`<= RUNNER_MAX_ERROR_BYTES`), **stack-free** structured errors for handler throw, over-long message, and timeout; a raw stack never reaches the wire (Tests 10–12).
6. The React client's `lastError` is a **plain readable string** for `run_failed`, malformed frames, and connection/auth closes; a raw DOM `Event` is never forwarded to `onError` nor stringified to `[object Event]` (Tests 13–14).
7. WS-34's client behavior is intact: URL resolution, `createWebSocket` injection, exponential-backoff reconnect, offline message queue/flush, and `disconnect()` idempotency are unchanged and still pass their existing tests (Test 14 guards reconnect).
8. No new value export is added to the `@swiftagent/sdk` or `@swiftagent/react` **root barrels** by this workstream (WS-36 coordination); error types are imported from `@swiftagent/shared`. If a new `SwiftAgentErrorCode` was unavoidable, it was added to **both** the const map and `CODE_TO_STATUS` in lockstep (and does not collide with WS-37's `INCOMPATIBLE_VERSION`).
9. `packages/shared/src/types/errors.ts` carries a terse error-reference doc-comment (code → meaning → remediation) that does not duplicate WS-40's README.
10. `pnpm typecheck`, `pnpm lint`, and `pnpm test` pass from the repo root (and `pnpm test:integration` where Docker is available); the exact commands and results are reported. Any pre-existing failure is identified against the user-memory notes and confirmed unrelated (**SC-10**).
