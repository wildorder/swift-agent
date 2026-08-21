# WS-34: Client & Documentation Alignment

## Goal

Conform the client SDK (`@swiftagent/react`) and the public documentation to the single canonical WebSocket URL contract locked by the program: `wss://<host>/v1/stream?token=<jwt>`. Today the client's `createChatSession` (a) hardcodes a wrong default endpoint (`wss://api.swiftagent.dev/ws`, path `/ws` instead of `/v1/stream`), (b) builds the connection URL by naive string concatenation that appends a redundant `sessionId` query parameter and risks a double-`?` if the base URL already carries a query string, and (c) ignores the fact that `POST /v1/sessions` already returns a fully-tokenized `websocketUrl`. The gateway reads **only** `?token=` from the query and derives `sessionId` from the JWT claims, so the extra `sessionId` param is dead weight. This workstream makes the client consume the API-provided `websocketUrl` verbatim as the source of truth, replaces string concatenation with the `URL`/`URLSearchParams` API for any token-appending path, drops the redundant `sessionId` param, removes the wrong hardcoded default, and updates every doc/example that shows a connection endpoint so nothing references `/ws`. This workstream conforms the **client** to the gateway's query-param contract; it does **not** change that contract.

## Traceability

- **SC-02:** Session creation returns, and the SDK consumes, one canonical WebSocket URL of the form `wss://<host>/v1/stream?token=<jwt>`.
- **SC-08:** The React/vanilla SDK consumes the API-provided canonical URL using safe URL construction; the redundant `sessionId` query parameter and the double-`?` construction bug are removed.
- **SC-09:** Site docs and the quickstart document the canonical `/v1/stream` endpoint (validated against deployed dev via WS-35, not duplicated here).
- **SC-12:** Monorepo type-checking, linting, and unit tests pass.

## Dependencies

- **WS-30** — Unified Realtime Server: establishes the canonical `/v1/stream` path on the unified public port (3000).
- **WS-32** — Environment URL Configuration & Startup Validation: `POST /v1/sessions` returns a correct per-environment `websocketUrl` of the form `wss://<host>/v1/stream?token=<jwt>`; the silent `ws://localhost:3001` default is removed upstream.

## Context Files (Agent MUST read before implementing)

- `CLAUDE.md` — mechanical overrides (forced verification, no-semantic-search grep discipline, edit integrity).
- `packages/react/src/client.ts` — the `createChatSession` factory; contains `DEFAULT_WS_URL` and the buggy URL concatenation (see "Existing Interfaces to Consume").
- `packages/react/src/types.ts` — `CreateChatSessionOptions`, `ChatSessionClient`, `ConnectionStatus`, `UseAgentChatArgs`.
- `packages/react/src/hooks/use-connection.ts` — wraps `createChatSession`; passes `sessionId`, `token`, `websocketUrl` through and is keyed on those three values in a `useEffect` dep array.
- `packages/react/src/hooks/use-agent-chat.ts` — forwards `websocketUrl`/`sessionId`/`token` to `useConnection`.
- `packages/react/src/index.ts` — public barrel; confirms exported surface.
- `packages/gateway/src/server.ts` — CONFIRM the gateway reads only `url.searchParams.get('token')` and derives `sessionId` from `claims` (see paste below). Do NOT modify.
- `packages/api/src/routes/sessions.ts` — the canonical `websocketUrl = \`${publicWebsocketUrl}?token=${clientToken}\`` construction the client should consume.
- `swift-agent.md` (lines ~180–236) and `docs/vision.md` (lines ~180–236) — the product vision SDK examples that show `sessions.create` returning `websocketUrl` and a React hook that never wires it through.
- `docs/as-built.md` and `docs/snapshots/*.md` — already document `GET /v1/stream?token=<client-jwt>` correctly (no `/ws` reference); use as the canonical phrasing to match, do not regress them.

## Package

- `packages/react` — the client fix (primary).
- `packages/api` — only if the `websocketUrl` response formatting needs a matching tweak to satisfy the client contract (see Design Notes; the current `?token=` formatting is expected to already be correct, so this is likely a no-op — do not gratuitously touch it).
- `docs/` (and `swift-agent.md` / `docs/vision.md`) — endpoint/quickstart alignment.

## Files Touched

- `packages/react/src/client.ts` **(MODIFY)** — consume API `websocketUrl` verbatim; safe `URL`-based token append for the fallback path; drop `sessionId` param; remove/repoint `DEFAULT_WS_URL`.
- `packages/react/src/types.ts` **(MODIFY)** — tighten JSDoc on `CreateChatSessionOptions.websocketUrl`/`token`/`sessionId` to document the canonical contract; no breaking shape change.
- `packages/react/test/client.test.ts` **(NEW or MODIFY)** — URL-construction and reconnection unit tests (match the existing test file name/location in `packages/react` — verify with a glob before creating a new file).
- `swift-agent.md` **(MODIFY)** — show wiring the API-returned `websocketUrl` into the client; ensure any endpoint mention is `/v1/stream`.
- `docs/vision.md` **(MODIFY)** — same alignment as `swift-agent.md` (the two files carry the identical example block).
- `docs/programs/realtime-cloud-delivery-program.md` — read-only reference; do NOT edit here (owned by the program planning docs).

> There is **no** standalone `quickstart.md` / `getting-started.md` in the repo today (confirmed by glob). The "quickstart" content lives inside the `swift-agent.md` / `docs/vision.md` example blocks. If WS-30/WS-32 introduce a dedicated quickstart file before this workstream lands, align it too; otherwise the vision/README examples ARE the quickstart surface.

## Existing Interfaces to Consume

### Current buggy client URL construction — `packages/react/src/client.ts`

```ts
const DEFAULT_WS_URL = 'wss://api.swiftagent.dev/ws';
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_DELAY_MS = 1000;

export function createChatSession(
  opts: CreateChatSessionOptions,
): ChatSessionClient {
  const {
    sessionId,
    token,
    websocketUrl = DEFAULT_WS_URL,
    reconnect,
    onError,
  } = opts;
  // ...
  const factory =
    opts.createWebSocket ?? ((url: string) => new WebSocket(url));
  // ...
  function connect(): void {
    if (intentionalClose) return;

    setStatus('connecting');
    const url = `${websocketUrl}?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}`;
    ws = factory(url);
    // ...
  }
}
```

Two defects on the `const url = ...` line:
1. Unconditional `?sessionId=...&token=...` — if `websocketUrl` already ends with `?token=<jwt>` (which the API-provided URL does), this produces a malformed `...?token=<jwt>?sessionId=...` (double-`?`).
2. `sessionId` is redundant — the gateway never reads it.

### Options shape — `packages/react/src/types.ts`

```ts
/** Options for creating a vanilla JS chat session */
export interface CreateChatSessionOptions {
  sessionId: string;
  token: string;
  websocketUrl?: string;
  reconnect?: ReconnectOptions;
  /** Injectable WebSocket factory for testing */
  createWebSocket?: (url: string) => WebSocket;
  /** Error handler for malformed frames or connection errors */
  onError?: (error: unknown) => void;
}
```

### Gateway token-only extraction (DO NOT MODIFY) — `packages/gateway/src/server.ts`

```ts
instance.get('/stream', { websocket: true }, (socket: WebSocket, req) => {
  // Extract token from query string
  const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
  const token = url.searchParams.get('token');

  if (!token) {
    const error = toErrorEvent('AUTH_REQUIRED', 'Missing token query parameter');
    socket.send(JSON.stringify(error));
    socket.close(4001, 'Missing token');
    return;
  }

  void (async () => {
    const claims = await validateClientToken(token, jwtSecret);
    const { sessionId } = claims;          // ← sessionId comes from the JWT, NOT the query
    connectionManager.add(sessionId, socket);
    // ...
  })();
});
```

This route is mounted under `{ prefix: '/v1' }`, giving the canonical path `/v1/stream`. The gateway reads only `?token=`; it never reads `?sessionId=`.

### Canonical `websocketUrl` construction (source of truth) — `packages/api/src/routes/sessions.ts`

```ts
const clientToken = await tokenService.signClientToken({
  sessionId: session.sessionId,
  agentId,
  permissions: ['chat'],
});

const websocketUrl = `${publicWebsocketUrl}?token=${clientToken}`;

return reply.status(201).send({
  sessionId: session.sessionId,
  clientToken,
  websocketUrl,
});
```

`publicWebsocketUrl` is supplied per-environment by WS-32 (e.g. `wss://api-dev.swiftagent.dev/v1/stream`). The emitted `websocketUrl` is therefore the complete, already-tokenized canonical URL: `wss://<host>/v1/stream?token=<jwt>`.

## Design Notes

**The client's contract is: prefer the API-provided `websocketUrl` verbatim.** `POST /v1/sessions` already returns a fully-formed `wss://<host>/v1/stream?token=<jwt>`. The cleanest, least error-prone contract is for the client to treat `CreateChatSessionOptions.websocketUrl` as the authoritative, ready-to-connect URL and pass it to the socket factory unchanged. This eliminates every construction bug because the client stops constructing.

**Backward-compat / fallback token append.** The current options still accept `token` and `sessionId` separately, and `useConnection` threads them through. To avoid a breaking API change in this workstream, keep the fields but change behavior:
- If `websocketUrl` **already contains** a `token` query param, use it **as-is** (do not re-append). This is the API-provided-URL happy path.
- If `websocketUrl` is present but has **no** `token` param and a `token` option is supplied, append it **safely** via the `URL` API:
  ```ts
  const u = new URL(websocketUrl);
  if (!u.searchParams.has('token') && token) {
    u.searchParams.set('token', token);
  }
  const url = u.toString();
  ```
  `URLSearchParams.set` handles encoding and the `?`-vs-`&` separator correctly, so a base with an existing query string can never produce a double-`?`. **Never** hand-concatenate query strings again.
- **Never** append `sessionId` — the gateway ignores it and it leaks the id into logs/proxies for no benefit.

**Remove the wrong default.** `DEFAULT_WS_URL = 'wss://api.swiftagent.dev/ws'` is wrong on two counts (public marketing host + `/ws` path) and masks misconfiguration by silently connecting to a bogus endpoint. **Preferred:** remove the hardcoded default entirely and require `websocketUrl` — if it is missing/empty, throw a clear error (`createChatSession requires a websocketUrl (the value returned by POST /v1/sessions)`). This is the senior-dev choice: a hardcoded production-looking default that is also wrong is worse than a loud failure, and the API always supplies the URL in the real flow. If a default must be retained for local DX, it MUST be the canonical local form `ws://localhost:3000/v1/stream` (matching the unified port from WS-30) — but prefer the throw. Justify whichever you choose in the code comment.

**Types.** `CreateChatSessionOptions.websocketUrl` stays optional at the type level only if you retain a local default; if you go with the throw, keep it optional in the interface but document that it is effectively required and validate at runtime (do not make it a breaking required field mid-program). `sessionId` remains in the options (still used by `useConnection`'s effect key and by `use-agent-chat` for user-message id correlation) but is **no longer** part of URL construction — document this in JSDoc so a future reader does not "restore" it.

**Preserve behavior that tests depend on.** Do NOT change: the `createWebSocket` factory injection (`opts.createWebSocket ?? ((url) => new WebSocket(url))`), the exponential-backoff `scheduleReconnect` logic, the `messageQueue` flush-on-open, the `onStatusChange`/`onEvent` observer sets, or the `disconnect()` idempotency. The only behavioral change is how the final `url` string is derived before `factory(url)`.

**`useConnection` effect key.** The effect is keyed on `[sessionId, token, websocketUrl]`. Since the API-provided `websocketUrl` already embeds the token, `token` and `websocketUrl` will co-vary; this is fine and needs no change. Do not remove `sessionId`/`token` from the hook signature in this workstream (out of scope; would ripple into `useAgentChat` and consumers).

**API side is likely a no-op.** `sessions.ts` already emits `?token=` with no `sessionId`. Only touch `packages/api` if a review reveals the emitted URL is not URL-safe (e.g. token needs `encodeURIComponent`). Note: `clientToken` is a compact JWS (base64url, no reserved chars), so raw interpolation is safe today; if you add encoding, keep it symmetric with how the gateway parses `searchParams.get('token')` (which auto-decodes). Prefer leaving `sessions.ts` untouched unless a concrete defect is found.

**Docs alignment scope.** The as-built docs already say `/v1/stream` correctly — do not regress them. The gap is in `swift-agent.md` / `docs/vision.md`: the `sessions.create` example returns `websocketUrl` but the React example calls `useAgentChat({ sessionId, token })` **without** passing `websocketUrl`, implying the (wrong) hardcoded default. Update those examples to thread the returned `websocketUrl` into the client/hook, and ensure no example anywhere shows `/ws`. Reference WS-35 for the live deployed-dev validation rather than adding a validation step here.

## Implementation Steps

1. **Read before editing.** Per CLAUDE.md, re-read `packages/react/src/client.ts`, `types.ts`, `use-connection.ts` immediately before editing. Glob `packages/react/**/*.test.ts` (and `packages/react/test/**`) to locate the existing client test file and its `createWebSocket` mock pattern; reuse it rather than inventing a new harness.

2. **Fix URL construction in `client.ts`.** Replace the `const url = \`${websocketUrl}?sessionId=...&token=...\`` line with the safe logic from Design Notes: if `websocketUrl` already has a `token` param, use it verbatim; else append `token` via `new URL(...)` + `URLSearchParams.set('token', token)`; never append `sessionId`. Add a comment stating the gateway reads only `?token=` and derives `sessionId` from JWT claims.

3. **Remove the wrong default.** Delete `DEFAULT_WS_URL = 'wss://api.swiftagent.dev/ws'`. Change the destructure so a missing/empty `websocketUrl` throws a clear error (preferred) — or, if a local default is retained, set it to `ws://localhost:3000/v1/stream` and comment the justification. Do not leave any `/ws` reference in the file.

4. **Guard malformed input.** If `websocketUrl` is provided but not parseable by `new URL()`, surface via `onError` (or throw) with a clear message rather than passing garbage to the socket factory. Keep this cheap — a single `try/catch` around URL construction.

5. **Tighten `types.ts` JSDoc.** Document that `websocketUrl` is the canonical `wss://<host>/v1/stream?token=<jwt>` returned by `POST /v1/sessions` and is the source of truth; that `token` is only used as a fallback append when `websocketUrl` lacks it; and that `sessionId` is used for message-id correlation, NOT URL construction. No shape/breaking change.

6. **Verify the API side.** Read `packages/api/src/routes/sessions.ts`; confirm `websocketUrl = \`${publicWebsocketUrl}?token=${clientToken}\`` is single-`?`, `sessionId`-free, and URL-safe. Make a change ONLY if a concrete defect exists; otherwise record "no change required" in the PR description.

7. **Confirm gateway contract is untouched.** Read `packages/gateway/src/server.ts`; assert (in the PR notes and via a test, step 5 of Tests) that it still reads only `searchParams.get('token')` and derives `sessionId` from `claims`. Do NOT edit gateway code.

8. **Align docs — `swift-agent.md` and `docs/vision.md`.** Update the React/frontend example so the client receives the `websocketUrl` from `sessions.create`, e.g. pass `websocketUrl` into `useAgentChat`/`createChatSession`, and add one sentence: "Use the `websocketUrl` returned by `POST /v1/sessions` directly — it is the canonical `wss://<host>/v1/stream?token=<jwt>` URL." Grep both files for `/ws` and `api.swiftagent.dev/ws` and remove/repoint any hit. Keep the two files consistent (they carry the same block).

9. **Grep sweep for stray `/ws` endpoint references.** Per CLAUDE.md rule 10 (no semantic search), run separate greps across `docs/`, `*.md`, `README*`, and `packages/**/*.ts` for: `/ws"`, `/ws'`, `` `/ws ``, `api.swiftagent.dev/ws`, and `DEFAULT_WS_URL`. Fix any documentation/example hit; leave unrelated substrings (e.g. `ws://`, `wss://`, `/v1/stream`, variable names) alone. Note in the PR that as-built snapshots were already correct.

10. **Verify.** Run the project checks from the repo root: `pnpm --filter @swiftagent/react typecheck` (or `pnpm typecheck`), `pnpm --filter @swiftagent/react lint` (or `pnpm lint`), and `pnpm --filter @swiftagent/react test`. Fix ALL errors before declaring done (CLAUDE.md forced-verification). State the exact commands run and their results.

## Tests

All in `packages/react` (Vitest), reusing the existing `createWebSocket`-injection mock. Each test captures the URL string passed to the injected factory and asserts on it.

1. **API-provided URL is used verbatim.** Given `websocketUrl = 'wss://host/v1/stream?token=abc'` (and any `token`/`sessionId` options), assert the injected factory is called with exactly `'wss://host/v1/stream?token=abc'` — no `sessionId` param, no second `token`, no double-`?`.

2. **Safe append when base has no query.** Given `websocketUrl = 'wss://host/v1/stream'` and `token = 'abc'`, assert the factory receives a URL with exactly one `?`, a single `token=abc` param, and no `sessionId` param (parse via `new URL(...)` and assert `searchParams`).

3. **Safe append when base already has an unrelated query param.** Given `websocketUrl = 'wss://host/v1/stream?region=us'` and `token = 'abc'`, assert the result has both params joined by `&` (single `?`), `token=abc` present, `sessionId` absent — proving no double-`?` regression.

4. **Redundant `sessionId` is never emitted.** Across cases 1–3, assert `new URL(capturedUrl).searchParams.has('sessionId') === false`.

5. **Gateway contract unchanged (guard test).** Assert the gateway still reads token-only: either a unit-level assertion against `packages/gateway/src/server.ts` behavior (feed a URL with `?token=<jwt>&sessionId=bogus` and confirm the bound session comes from JWT claims, not the query), or a static-source assertion that `searchParams.get('token')` is present and `searchParams.get('sessionId')` is absent in the gateway route. This test must fail if a future change makes the gateway read `sessionId` from the query.

6. **No hardcoded `/ws` default.** Assert that calling `createChatSession` without a `websocketUrl` throws the clear error (preferred design) — or, if a local default was retained, that the default is `ws://localhost:3000/v1/stream` and never contains `/ws` or `api.swiftagent.dev`. Explicitly assert the string `'/ws'` does not appear in the produced default.

7. **Reconnection still works with the injected factory.** Simulate an `onclose` (non-intentional) with mock timers; assert `scheduleReconnect` re-invokes the factory after the backoff delay with the **same** correctly-constructed URL, and that queued messages flush on the subsequent `onopen`. This guards that the URL refactor did not break reconnect/backoff.

8. **Doc/endpoint assertion.** A repo-level grep-style check (can be a Vitest test that reads the files, or documented as a manual grep in the PR) asserting that `swift-agent.md`, `docs/vision.md`, and `docs/**/*.md` contain no `/ws"`, `/ws'`, or `api.swiftagent.dev/ws` occurrence, and that at least one canonical `/v1/stream` reference is present in the updated examples.

## Acceptance Criteria

1. `createChatSession`, given the API-provided `websocketUrl` of the form `wss://<host>/v1/stream?token=<jwt>`, connects to **exactly** that URL — no appended `sessionId`, no duplicated `token`, no double-`?`.
2. When a `token` must be appended to a base URL lacking one, construction uses the `URL`/`URLSearchParams` API (never string concatenation), producing a single well-formed query regardless of whether the base already had a query string.
3. The redundant `sessionId` query parameter is removed from all client-produced connection URLs.
4. The wrong `DEFAULT_WS_URL` (`wss://api.swiftagent.dev/ws`) is gone; a missing `websocketUrl` fails loudly (preferred) or falls back only to the canonical `ws://localhost:3000/v1/stream`. No `/ws` path remains anywhere in `packages/react`.
5. The `createWebSocket` factory injection, exponential-backoff reconnection, offline message queue/flush, observer subscriptions, and `disconnect()` idempotency are all preserved and covered by tests.
6. `packages/gateway/src/server.ts` is unmodified and a guard test confirms the gateway still reads only `?token=` and derives `sessionId` from JWT claims.
7. `packages/api/src/routes/sessions.ts` continues to emit a single-`?`, `sessionId`-free, canonical `websocketUrl` (changed only if a concrete URL-safety defect was found and documented).
8. `swift-agent.md` and `docs/vision.md` show the client consuming the API-returned `websocketUrl`, state the "use the `websocketUrl` from `POST /v1/sessions` directly" guidance, and contain no `/ws` endpoint reference; deployed-dev validation is deferred to WS-35.
9. No documentation or example in `docs/` references an endpoint other than `/v1/stream` for the WebSocket stream.
10. `pnpm typecheck`, `pnpm lint`, and the `@swiftagent/react` unit tests all pass; the exact commands and results are reported.
