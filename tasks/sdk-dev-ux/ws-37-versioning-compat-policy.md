# WS-37: Versioning & Compatibility Policy

## Goal

Establish the **versioning + compatibility contract** for the published `@swiftagent/*` packages before the release automation (WS-38) turns publishing on. Concretely, this workstream delivers five things:

1. A committed, human-readable **versioning + deprecation/removal policy** (`docs/policies/versioning.md`) covering semver rules for the packages, what counts as breaking vs. minor vs. patch on the SDK's public surface, and the deprecation window/process.
2. A committed **SDK↔server/protocol compatibility policy** (same doc) that ties the SDK's wire expectations to the existing `RUNNER_PROTOCOL_VERSION` and the `ChatEvent` stream protocol, with a support matrix.
3. **Machine-checkable compatibility surfaced from `@swiftagent/shared`**: a `PROTOCOL` constants object, a pure `assertProtocolCompatible(local, remote)` function that throws a `SwiftAgentError` with an actionable message on mismatch, and a new dedicated `INCOMPATIBLE_VERSION` error code. The SDK's `ControlPlaneClient.registerAgent(...)` calls this assertion against a server-advertised protocol version so a stale SDK or stale server fails loudly at registration rather than mid-stream.
4. **Changesets initialized as the versioning source of truth** — `@changesets/cli` dev dependency at the repo root, `.changeset/config.json`, and root scripts (`changeset`, `version-packages`). The actual publish/release workflow is explicitly **out of scope** (WS-38 owns it).
5. **A client-side connect-time compatibility check** that reuses the *same* additive `x-swiftagent-protocol` header — with **no** change to the WebSocket/stream (`ChatEvent`) protocol. `POST /v1/sessions` already carries the header (the global `onSend` hook covers it), so the SDK's `ControlPlaneClient.createSession` surfaces it as `serverProtocolVersion` on `CreateSessionResult`, and the `@swiftagent/react` connect path asserts `assertProtocolCompatible(...)` **before** opening the socket — refusing to connect on mismatch. Because session creation precedes every stream connect, this closes SC-03's "connect time" clause without touching the stream protocol.

The non-negotiable constraint: **do not change the runtime loop or any existing protocol schema.** The server advertises its protocol version through an *additive* response header only; no request/response envelope, no `ChatEvent`, no `RunnerRequest`/`RunnerResponse` schema changes. If a mismatch cannot be detected because a given server predates the header, the assertion must **fail open** (treat "no advertised version" as compatible) so this workstream never breaks an existing deployment — see Design Notes.

## Traceability

- **SC-02:** A versioning + deprecation policy and an SDK↔server/protocol compatibility policy are documented and committed (`docs/policies/versioning.md`).
- **SC-03:** Version/compatibility constants are surfaced from `@swiftagent/shared` (`PROTOCOL`, `API_PROTOCOL_VERSION`, `SDK_MIN_SERVER_PROTOCOL`, `assertProtocolCompatible`), and the SDK asserts compatibility at **both** registration and connect time, failing with an actionable `SwiftAgentError` on mismatch. Registration-time: `ControlPlaneClient.registerAgent` reads the `x-swiftagent-protocol` response header and asserts. Connect-time: `ControlPlaneClient.createSession` surfaces the server version (from the same header on `POST /v1/sessions`) as `serverProtocolVersion`, and the `@swiftagent/react` connect path asserts it **before** opening the WebSocket — with no change to the stream protocol.
- **SC-10:** Monorepo type-checking, linting, unit tests, and integration tests pass (`pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:integration`).

## Dependencies

- **WS-36 (in-program)** — Finalized SDK surface. The public export barrels (`packages/sdk/src/index.ts`, `packages/shared/src/index.ts`) and the `ControlPlaneClient` shape are assumed frozen by WS-36. This workstream *adds* to those barrels (new shared exports, one new SDK-consumed assertion) but must not reshape anything WS-36 locked. Re-read both barrels immediately before editing (they may have changed since this spec was written).

## Context Files (Agent MUST read before implementing)

Read these before writing any code. Do not rely on this spec's paste blocks as a substitute — re-read per CLAUDE.md rule 6/9.

- `CLAUDE.md` — mechanical overrides: forced verification (`pnpm typecheck`/`pnpm lint`/`pnpm test` before declaring done), no-semantic-search grep discipline (rule 10), re-read-before-edit (rule 9), single-source-of-truth for env/constants in `@swiftagent/shared`.
- `packages/shared/src/types/runner-protocol.ts` — `RUNNER_PROTOCOL_VERSION = '1'` and its use as `z.literal(RUNNER_PROTOCOL_VERSION)` in the runner request/response schemas.
- `packages/shared/src/types/errors.ts` — `SwiftAgentErrorCode` map, `SwiftAgentError` ctor, `CODE_TO_STATUS`, `isSwiftAgentError`.
- `packages/shared/src/types/events.ts` — the `ChatEvent` discriminated union / `ChatEventSchema` (the stream protocol whose stability the policy governs).
- `packages/shared/src/index.ts` — the shared public barrel (where new exports must be added, grouped like the existing runner-protocol block).
- `packages/shared/src/index.test.ts` — existing shared unit-test style/harness to extend.
- `packages/shared/src/config.ts` — `ENV_KEYS` single-source-of-truth (referenced only; **no** new env var is required by this WS — justify in Design Notes).
- `packages/sdk/src/client.ts` — `ControlPlaneClient.registerAgent(...)`, the private `request(...)` (note: it currently discards response headers — see Design Notes), and `SdkHttpError` usage.
- `packages/sdk/src/types.ts` — `SdkHttpError`, `CreateAgentAppConfig`, `CreateSessionResult` (gains `serverProtocolVersion`), the SDK type surface.
- `packages/react/src/client.ts` — `createChatSession` / `resolveConnectionUrl` (WS-34 URL logic; where the pre-connect assertion is inserted, ahead of `resolveConnectionUrl`/`connect()`).
- `packages/react/src/hooks/use-connection.ts` — `useConnection` (calls `createChatSession` inside a `useEffect`; where a synchronous assert-throw is caught → `lastError`).
- `packages/react/src/hooks/use-agent-chat.ts` — `useAgentChat` (forwards args to `useConnection`).
- `packages/react/src/types.ts` — `CreateChatSessionOptions` / `UseAgentChatArgs` (gain optional `serverProtocolVersion`).
- `packages/sdk/src/index.ts` — the SDK public barrel.
- `packages/api/src/routes/agents.ts` — `POST /agents` handler (the registration endpoint).
- `packages/api/src/server.ts` — `buildApp(...)`; where an additive response-header hook is registered so `POST /v1/agents` can advertise the server protocol version.
- `docs/runbooks/migrations.md` — house doc style/tone to match for `docs/policies/versioning.md`.

## Package

- **`packages/shared`** — new `packages/shared/src/types/protocol.ts` (constants + `assertProtocolCompatible`); new exports in the barrel; new unit tests.
- **`packages/sdk`** — `registerAgent` reads the advertised server protocol and calls `assertProtocolCompatible`; `createSession` surfaces the header as `serverProtocolVersion` on `CreateSessionResult` (a new optional field in `packages/sdk/src/types.ts`); the private `request(...)` returns headers so the version is reachable; new unit tests.
- **`packages/react`** — the connect path (`createChatSession` / `useConnection` → `useAgentChat`) asserts `assertProtocolCompatible(localApi, serverProtocolVersion)` **before** opening the socket, surfacing a typed `SwiftAgentError(INCOMPATIBLE_VERSION)` (thrown for the vanilla client, via `lastError` for the hook) instead of connecting. No change to the `ChatEvent` stream protocol; must not break WS-34's URL-resolution/reconnect logic. New unit tests.
- **`packages/api`** — an additive `onSend` header hook in `buildApp` advertising `API_PROTOCOL_VERSION` (no route/schema change). The same hook already covers `POST /v1/sessions`, which is what the connect-time check consumes.
- **`docs/`** — `docs/policies/versioning.md` (new); one cross-link from `docs/as-built.md` is optional and non-load-bearing (leave as-is unless trivial).
- **repo root** — `@changesets/cli` devDep, `.changeset/config.json`, `.changeset/README.md`, root `changeset` / `version-packages` scripts.

## Files Touched

- `packages/shared/src/types/protocol.ts` **(NEW)** — `API_PROTOCOL_VERSION`, `SDK_MIN_SERVER_PROTOCOL`, the `PROTOCOL` object, `PROTOCOL_HEADER`, and the pure `assertProtocolCompatible(...)`.
- `packages/shared/src/types/errors.ts` **(MODIFY)** — add `INCOMPATIBLE_VERSION` to `SwiftAgentErrorCode` and to `CODE_TO_STATUS`.
- `packages/shared/src/index.ts` **(MODIFY)** — export the new protocol constants/function (new grouped block next to the runner-protocol block).
- `packages/shared/src/protocol.test.ts` **(NEW)** — unit tests for `assertProtocolCompatible` (compatible passes; mismatch throws `SwiftAgentError` with `INCOMPATIBLE_VERSION` and the actionable message; "no advertised version" fails open).
- `packages/shared/src/index.test.ts` **(MODIFY)** — assert the new symbols are re-exported from the barrel and the new error code round-trips.
- `packages/sdk/src/client.ts` **(MODIFY)** — `request(...)` returns `{ body, headers }`; `registerAgent(...)` extracts the advertised protocol header and calls `assertProtocolCompatible` before returning; `createSession(...)` reads the same header off the response and returns it as `serverProtocolVersion` on the result.
- `packages/sdk/src/types.ts` **(MODIFY)** — add optional `serverProtocolVersion?: string` to `CreateSessionResult` (the server's advertised `x-swiftagent-protocol`; `undefined` on a legacy server that omits the header).
- `packages/sdk/src/client.test.ts` **(NEW or MODIFY)** — glob `packages/sdk/**/*.test.ts` first; add tests that mock `fetch` and assert registration throws on protocol mismatch and passes on match / on a header-less (legacy) server; and that `createSession` surfaces `serverProtocolVersion` from the header (and leaves it `undefined` when absent).
- `packages/react/src/client.ts` **(MODIFY)** — `createChatSession` accepts the server protocol version and calls `assertProtocolCompatible(API_PROTOCOL_VERSION, serverProtocolVersion)` **before** `resolveConnectionUrl` / opening the socket; on mismatch throws the typed `SwiftAgentError(INCOMPATIBLE_VERSION)` (routed to `onError` for the hook path). Does not alter the URL-resolution/reconnect logic (WS-34).
- `packages/react/src/types.ts` **(MODIFY)** — thread an optional `serverProtocolVersion?: string` through `CreateChatSessionOptions` and `UseAgentChatArgs` (sourced from the SDK's `CreateSessionResult`).
- `packages/react/src/hooks/use-connection.ts` **(MODIFY)** — pass `serverProtocolVersion` through to `createChatSession`; a synchronous `assertProtocolCompatible` throw is caught and surfaced via `lastError` (the existing `onError` → `setLastError` path) with the socket left unopened.
- `packages/react/src/hooks/use-agent-chat.ts` **(MODIFY)** — accept and forward `serverProtocolVersion` from `UseAgentChatArgs` to `useConnection`.
- `packages/react/src/client.test.ts` / `packages/react/src/hooks/*.test.ts` **(NEW or MODIFY)** — glob `packages/react/**/*.test.ts` first; add connect-time tests (mismatch surfaces the typed error and the socket factory is NOT invoked; compatible version connects normally).
- `packages/api/src/server.ts` **(MODIFY)** — register an additive `onSend` hook setting the `x-swiftagent-protocol` header to `API_PROTOCOL_VERSION` on responses.
- `packages/api/src/__tests__/agents.test.ts` **(MODIFY)** — assert `POST /v1/agents` responses carry the advertised protocol header. (Confirm this file exists via glob; it does today.)
- `docs/policies/versioning.md` **(NEW)** — the versioning + deprecation + compatibility policy.
- `package.json` (root) **(MODIFY)** — add `@changesets/cli` devDep and `changeset` / `version-packages` scripts.
- `.changeset/config.json` **(NEW)** — Changesets config.
- `.changeset/README.md` **(NEW)** — the standard Changesets readme (or the CLI-generated one).

## Existing Interfaces to Consume

### `RUNNER_PROTOCOL_VERSION` and its schema use — `packages/shared/src/types/runner-protocol.ts`

```ts
/** Bumped on any breaking change to the request/response envelope. */
export const RUNNER_PROTOCOL_VERSION = '1' as const;

export const RunnerRequestSchema = z
  .object({
    version: z.literal(RUNNER_PROTOCOL_VERSION),
    idempotencyKey: z.string().min(1),
    input: z.unknown(),
    context: RunnerRequestContextSchema,
  })
  .strict();
```

`RUNNER_PROTOCOL_VERSION` is a hard `z.literal` on the request AND both response schemas — a *runner*-boundary wire version. It is already the correct source of truth for the tool-runner boundary. This WS does **not** touch it or those schemas.

### `SwiftAgentError` — `packages/shared/src/types/errors.ts`

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

const CODE_TO_STATUS: Record<SwiftAgentErrorCode, number> = {
  VALIDATION: 400,
  /* ... */
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
  ) { /* ... */ }
}
```

`SwiftAgentErrorCode` is an `as const` object with a matching `CODE_TO_STATUS` record — **both** must gain the new key or the `Record<SwiftAgentErrorCode, number>` type fails to compile (this is the compile-time guard that keeps them in lockstep).

### `registerAgent` + private `request` — `packages/sdk/src/client.ts`

```ts
async registerAgent(body: RegisterAgentBody): Promise<AgentRecord> {
  const res = await this.request('POST', '/v1/agents', body);
  return AgentRecordSchema.parse(res);
}

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
  const res = await fetch(url, init);
  const responseBody: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw new SdkHttpError(`HTTP ${res.status} ${res.statusText}: ${method} ${path}`, res.status, responseBody);
  }
  return responseBody;
}
```

`request(...)` currently returns only the parsed body and **discards `res.headers`**, so the advertised protocol header is not reachable from `registerAgent`. That is the single structural change needed on the SDK side.

### `POST /agents` handler — `packages/api/src/routes/agents.ts`

```ts
app.post('/agents', async (req, reply) => {
  const { workspaceId } = req as AuthenticatedRequest;
  const body = CreateAgentBodySchema.parse(req.body);
  const agent = await agentService.registerOrUpdateAgent(workspaceId, body);
  const isNew = Math.abs(agent.updatedAt.getTime() - agent.createdAt.getTime()) < 1000;
  return reply.status(isNew ? 201 : 200).send(agent);
});
```

The handler is **not** modified. The protocol header is applied globally by an `onSend` hook in `buildApp` so *every* response (including `POST /v1/agents`) advertises the version without per-route edits.

### `buildApp` header-hook seam — `packages/api/src/server.ts`

```ts
export async function buildApp(opts: BuildAppOptions): Promise<AppContext> {
  const app = Fastify({ /* ... */ });
  await app.register(cors, { origin: true });
  registerErrorHandler(app);
  registerRequestId(app);
  registerAuth(app, opts.repos.apiKeyRepo);
  // ← register the additive protocol-advertising onSend hook here
  // ...
}
```

### `CreateSessionResult` + `createSession` — `packages/sdk/src/types.ts`, `packages/sdk/src/client.ts`

```ts
// packages/sdk/src/types.ts
export interface CreateSessionResult {
  sessionId: string;
  clientToken: string;
  websocketUrl: string;
  // ← add: serverProtocolVersion?: string  (the x-swiftagent-protocol header off
  //   POST /v1/sessions; undefined on a legacy server that omits it — fail-open)
}

// packages/sdk/src/client.ts
async createSession(body: CreateSessionBody): Promise<CreateSessionResult> {
  const res = await this.request('POST', '/v1/sessions', body);
  return res as CreateSessionResult; // ← currently discards headers
}
```

`createSession` currently casts the bare body straight to `CreateSessionResult` and never touches the response headers. Once `request(...)` returns `{ body, headers }` (the SDK change already required for `registerAgent`), `createSession` reads `headers.get(PROTOCOL_HEADER)` and folds it in as `serverProtocolVersion` — the *same* header the `onSend` hook sets on every response, so no new server work. `POST /v1/sessions` runs before any stream connect, so the version is available at the exact moment the client decides whether to open the socket.

### react connect path — `packages/react/src/client.ts`, `packages/react/src/hooks/use-connection.ts`

```ts
// packages/react/src/client.ts — the socket is opened inside connect() → factory(url).
// The assertion must run BEFORE resolveConnectionUrl/connect, at construction time,
// mirroring how an invalid websocketUrl already "fails loudly at construction".
export function createChatSession(opts: CreateChatSessionOptions): ChatSessionClient {
  const { token, websocketUrl, reconnect, onError } = opts;
  // ← assert here: assertProtocolCompatible(API_PROTOCOL_VERSION, opts.serverProtocolVersion)
  const url = resolveConnectionUrl(websocketUrl, token);
  // ...
  connect(); // opens WebSocket via factory(url)
}

// packages/react/src/hooks/use-connection.ts — createChatSession is called inside a
// useEffect; a synchronous throw must be caught and routed to setLastError (the hook
// never rethrows — the existing onError handler already does err → setLastError).
const client = createChatSession({
  sessionId, token, websocketUrl,
  serverProtocolVersion,           // ← threaded through UseConnectionOptions/Args
  reconnect: options?.reconnect,
  createWebSocket: options?.createWebSocket,
  onError: (err) => { setLastError(err instanceof Error ? err.message : String(err)); options?.onError?.(err); },
});
```

`createChatSession` opens the socket in its internal `connect()` (via `factory(url)`), invoked synchronously at the end of construction; `resolveConnectionUrl` already establishes the "fail loudly before any socket opens" precedent. The compat assertion slots in **ahead of** `resolveConnectionUrl` so a mismatch throws before the URL is even resolved. For the **vanilla** client the throw propagates to the caller; for the **hook**, `createChatSession` runs inside `useConnection`'s `useEffect`, so the synchronous throw is caught and surfaced via `lastError` (reuse the existing `onError` → `setLastError` wiring — do **not** let it escape the effect). Both `CreateChatSessionOptions`/`UseConnectionOptions` and `UseAgentChatArgs` gain an optional `serverProtocolVersion?: string`, sourced from the SDK's `CreateSessionResult.serverProtocolVersion`.

## Design Notes

### Reuse `RUNNER_PROTOCOL_VERSION` or add a new constant? → **Add a distinct `API_PROTOCOL_VERSION`.**

`RUNNER_PROTOCOL_VERSION` governs the *tool-runner* boundary (`RemoteToolExecutor` ↔ `startToolRunner`) and is a hard `z.literal` baked into `RunnerRequestSchema`/`RunnerResponseSchema`. The SDK↔control-plane surface (`registerAgent`, session/run REST, and the `ChatEvent` stream) is a **separate** contract that versions on a **different cadence** — e.g. adding a `ChatEvent` variant is a control-plane protocol change but has nothing to do with the runner envelope. Overloading one constant to mean both would force a runner-schema bump every time an unrelated stream field changes (and vice versa), which is exactly the drift the two-source-of-truth split prevents. So:

- **`API_PROTOCOL_VERSION = '1'`** (new) — the control-plane + stream protocol version the SDK speaks. Starts at `'1'` (matching the runner's current major so the initial support matrix is clean), but is free to diverge later.
- **`RUNNER_PROTOCOL_VERSION`** — unchanged, re-exported by `PROTOCOL` for a single import site, but semantically independent.
- **`SDK_MIN_SERVER_PROTOCOL = '1'`** — the oldest server `API_PROTOCOL_VERSION` this SDK build tolerates. The assertion compares the server's advertised version against this floor and the SDK's own `API_PROTOCOL_VERSION` ceiling.

Version values are **strings** (matching `RUNNER_PROTOCOL_VERSION`'s `'1' as const`), and the comparison is a simple integer parse of the major (`Number.parseInt(v, 10)`), documented as "major only" — the protocol version is a single monotonic integer major, not a full semver triple. Keep it a string constant so it can later become `z.literal`-able if a wire field ever carries it.

### Surface shape

`packages/shared/src/types/protocol.ts` exports:

```ts
import { RUNNER_PROTOCOL_VERSION } from './runner-protocol.js';
import { SwiftAgentError, SwiftAgentErrorCode } from './errors.js';

/** Control-plane + stream (ChatEvent) protocol version the SDK/server speak.
 *  Distinct from RUNNER_PROTOCOL_VERSION (the tool-runner wire envelope). */
export const API_PROTOCOL_VERSION = '1' as const;

/** Oldest server API_PROTOCOL_VERSION this SDK build tolerates (inclusive floor). */
export const SDK_MIN_SERVER_PROTOCOL = '1' as const;

/** HTTP response header the server advertises its API_PROTOCOL_VERSION on. Lowercase
 *  (fetch/Fastify normalize header names to lowercase). */
export const PROTOCOL_HEADER = 'x-swiftagent-protocol' as const;

/** One import site for every protocol constant. */
export const PROTOCOL = {
  api: API_PROTOCOL_VERSION,
  runner: RUNNER_PROTOCOL_VERSION,
  sdkMinServer: SDK_MIN_SERVER_PROTOCOL,
  header: PROTOCOL_HEADER,
} as const;

/**
 * Assert the local SDK's protocol expectations are compatible with the server's
 * advertised protocol version. Pure — no I/O, safe to unit test in isolation.
 *
 * @param remote  Server-advertised API protocol version, or `undefined`/`null`
 *                when the server did not advertise one (legacy server). Absence
 *                FAILS OPEN (returns without throwing) — see Design Notes.
 * @param local   Optional override of the local {min, current} pair (for tests).
 * @throws SwiftAgentError(INCOMPATIBLE_VERSION) with an actionable message.
 */
export function assertProtocolCompatible(
  remote: string | null | undefined,
  local: { min: string; current: string } = {
    min: SDK_MIN_SERVER_PROTOCOL,
    current: API_PROTOCOL_VERSION,
  },
): void {
  if (remote == null || remote === '') return; // legacy server: fail open

  const remoteMajor = Number.parseInt(remote, 10);
  const minMajor = Number.parseInt(local.min, 10);
  const curMajor = Number.parseInt(local.current, 10);

  if (Number.isNaN(remoteMajor)) {
    throw new SwiftAgentError(
      SwiftAgentErrorCode.INCOMPATIBLE_VERSION,
      `Server advertised an unparseable protocol version "${remote}". ` +
        `Expected an integer major (this SDK speaks ${local.current}). ` +
        `Upgrade @swiftagent/sdk or the server.`,
    );
  }

  if (remoteMajor < minMajor) {
    throw new SwiftAgentError(
      SwiftAgentErrorCode.INCOMPATIBLE_VERSION,
      `Server protocol ${remote} is older than this SDK supports ` +
        `(minimum ${local.min}, current ${local.current}). Upgrade the Swift Agent server.`,
    );
  }

  if (remoteMajor > curMajor) {
    throw new SwiftAgentError(
      SwiftAgentErrorCode.INCOMPATIBLE_VERSION,
      `Server protocol ${remote} is newer than this SDK understands ` +
        `(this SDK speaks ${local.current}). Upgrade @swiftagent/sdk.`,
    );
  }
}
```

The actionable message MUST always name **both** the observed server version and the SDK's version, and MUST tell the reader which side to upgrade (server too old → upgrade server; server too new → upgrade SDK). This is the SC-03 "actionable message on mismatch" bar.

### New error code

`INCOMPATIBLE_VERSION` is added to `SwiftAgentErrorCode` and to `CODE_TO_STATUS`. Map it to **`409` (Conflict)** — the client and server are in a consistent-but-incompatible state; `409` reads correctly if this error is ever serialized over HTTP (it is thrown client-side today, but the code/status pair should still be sensible). Do not reuse `VALIDATION` (the input is not malformed) or `CONNECTION_ERROR` (the connection succeeded; the versions disagree). Both the code map and the status map must be updated together — the `Record<SwiftAgentErrorCode, number>` type will refuse to compile otherwise, which is the intended lockstep guard (call it out in the PR).

### How the server advertises its version (non-breaking)

The server currently advertises **no** protocol version anywhere. The minimal, additive, non-breaking way to surface it is a response **header**, set globally by a Fastify `onSend` hook in `buildApp`:

```ts
import { PROTOCOL_HEADER, API_PROTOCOL_VERSION } from '@swiftagent/shared';
// ...inside buildApp, after registerAuth:
app.addHook('onSend', async (_req, reply, payload) => {
  reply.header(PROTOCOL_HEADER, API_PROTOCOL_VERSION);
  return payload;
});
```

Why a header and not a response-body field:

- **Zero schema churn.** Adding a field to the `POST /v1/agents` body would require touching `AgentRecordSchema` (breaking `.strict()` parsers on the SDK side and the shared record type). A header is invisible to every existing Zod parser and to `AgentRecordSchema.parse(res)`.
- **Universal.** An `onSend` hook covers *every* endpoint — including `POST /v1/sessions`, which is what the client-side connect-time check (see below) reads — so any client can read the same header without per-route work.
- **Backward compatible both directions.** Old SDKs ignore the header; new SDKs treat its absence as "legacy server, compatible" (fail-open) so pointing a new SDK at an old server does not spuriously throw.

The header name lives in `@swiftagent/shared` (`PROTOCOL_HEADER`) so the server that sets it and the SDK that reads it share one string — no drift.

### Where the SDK asserts

`registerAgent` is the correct first boundary: it is the first authenticated control-plane call an SDK app makes, it already round-trips to the server, and failing there gives the clearest "your SDK and server disagree" signal before any session/run is created. Implementation:

1. Change the private `request(...)` to return `{ body: unknown; headers: Headers }` instead of the bare body (update its two-or-more existing call sites accordingly — grep for `this.request(` per CLAUDE.md rule 10 and update **all** of them; most just want `.body`).
2. In `registerAgent`, read `headers.get(PROTOCOL_HEADER)`, pass it to `assertProtocolCompatible(...)` **before** `AgentRecordSchema.parse(...)`, then return the parsed record.
3. In `createSession`, read `headers.get(PROTOCOL_HEADER)` off the same `{ body, headers }` and fold it into the returned `CreateSessionResult` as `serverProtocolVersion` (do **not** assert here — the client-side connect path in `@swiftagent/react` owns the connect-time assertion so the vanilla SDK stays a thin transport and the actionable failure lands next to where the socket would open).

### Connect-time assertion via the session-create header (in scope) — no stream-protocol change

SC-03 requires compatibility asserted at "registration/connect time." Registration time is covered by the `registerAgent` header read (above). **Connect time is covered here, client-side, without touching the WebSocket/stream (`ChatEvent`) protocol at all**, by reusing the version the server *already* advertises on `POST /v1/sessions`:

1. **Surface it.** `ControlPlaneClient.createSession` reads the same `x-swiftagent-protocol` response header (set by the global `onSend` hook) and returns it as `CreateSessionResult.serverProtocolVersion` — an additive optional field. No new server work, no `ChatEvent`/`RunnerRequest`/`RunnerResponse` change, no session-response *body* change (it is a header, invisible to any Zod parser — same rationale as the registration path).
2. **Assert before connecting.** The `@swiftagent/react` connect path (`createChatSession` / `useConnection` → `useAgentChat`) calls `assertProtocolCompatible(API_PROTOCOL_VERSION, serverProtocolVersion)` **before** `resolveConnectionUrl`/opening the socket. On mismatch it surfaces the typed `SwiftAgentError(INCOMPATIBLE_VERSION, <actionable message>)` — thrown for the vanilla `createChatSession` caller, and routed via `lastError` for the `useConnection`/`useAgentChat` hook — and the socket is never opened.

Why this satisfies the connect-time clause without a stream-protocol field: **session creation carries the version and always precedes every stream connect**, so the client can refuse to connect on mismatch using data it already has, entirely before the WebSocket handshake. Adding a version field to the WS handshake or a first control frame would be a stream-protocol-surface change, which is **out of program scope** — this approach deliberately avoids it.

Fail-open is preserved: a legacy server that omits the header yields `serverProtocolVersion === undefined`, and `assertProtocolCompatible(..., undefined)` returns without throwing, so the socket opens normally. This must **not** disturb WS-34's URL-resolution/reconnect logic — the assertion is a pure pre-check inserted ahead of `resolveConnectionUrl`, leaving the reconnect state machine, backoff, and `websocketUrl` handling untouched. The typed error coordinates with WS-41's error taxonomy by reusing the shared `INCOMPATIBLE_VERSION` code (no new code introduced here beyond the one added for registration).

> **Stream-handshake assertion (still out of scope).** Advertising the protocol version *over the WebSocket handshake itself* (a handshake response header or first control frame) remains a stream-protocol-surface change and is **not** built here — it is unnecessary given the session-create header already gates every connect. The policy doc records it as a possible future hardening only.

### No new env var

`ENV_KEYS` is untouched. `API_PROTOCOL_VERSION` is a compile-time constant, not a deployment-tunable — a server does not get to "configure" which protocol it speaks; it speaks the one its code compiles against. Adding an env var would invite drift between the advertised header and the code's actual behavior. State this explicitly in the PR so a reviewer does not ask for an `ENV_KEYS` entry.

### Changesets config

`.changeset/config.json` (config only — WS-38 wires the publish workflow):

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3.0.0/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [],
  "linked": [],
  "access": "restricted",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": []
}
```

- **`access: "restricted"`** — the packages publish to a **private** registry (GitHub Packages, `npm.pkg.github.com`); `restricted` is the correct npm access level for private packages. WS-38 owns the registry auth/`publishConfig`.
- **`baseBranch: "main"`** — matches the repo's default branch (confirmed: `main`).
- **`changelog: "@changesets/cli/changelog"`** — the built-in changelog generator (no GitHub-API changelog plugin, which would need a token; WS-38 may upgrade this).
- **`updateInternalDependencies: "patch"`** — when one `@swiftagent/*` package bumps, dependents that reference it get a patch bump, keeping the workspace-linked versions consistent.
- Leave `fixed`/`linked` empty for now: packages version independently until a release policy says otherwise (document this choice in `versioning.md`).

Root `package.json` scripts (do not add a `release`/`publish` script — that is WS-38):

```jsonc
"scripts": {
  // ...existing...
  "changeset": "changeset",
  "version-packages": "changeset version"
}
```

Add `"@changesets/cli": "^2.27.0"` (or the current 2.x) to root `devDependencies`. Run `pnpm install` so the lockfile updates and the `changeset` binary resolves.

> **Packages stay `"private": true` in this WS.** Flipping `private` and adding `publishConfig`/registry wiring is a *release* concern owned by WS-38. Changesets can still *record* intended bumps against private packages; it just will not publish them. Do not remove `"private": true` here.

### Policy doc location: `docs/policies/versioning.md` (not `docs/versioning.md`)

`docs/` already segments by kind (`docs/runbooks/`, `docs/snapshots/`, `docs/programs/`). A policy is neither a runbook (operator procedure) nor a snapshot (point-in-time as-built) nor a program plan — it is standing normative policy, so a new `docs/policies/` folder is the consistent home and leaves room for future policy docs (security, support). Match the tone/structure of `docs/runbooks/migrations.md`: numbered sections, principles first, a concrete support-matrix table, copy-pasteable examples.

## Implementation Steps

Ordered. Per CLAUDE.md, re-read each file immediately before editing it and keep no more than 3 unverified edits per file.

1. **Add the error code.** In `packages/shared/src/types/errors.ts`, add `INCOMPATIBLE_VERSION: 'INCOMPATIBLE_VERSION'` to `SwiftAgentErrorCode` and `INCOMPATIBLE_VERSION: 409` to `CODE_TO_STATUS`. Confirm `tsc` is happy (the `Record<SwiftAgentErrorCode, number>` type forces both).

2. **Create `packages/shared/src/types/protocol.ts`** with `API_PROTOCOL_VERSION`, `SDK_MIN_SERVER_PROTOCOL`, `PROTOCOL_HEADER`, `PROTOCOL`, and `assertProtocolCompatible` exactly per Design Notes. Import `RUNNER_PROTOCOL_VERSION` from `./runner-protocol.js` and `SwiftAgentError`/`SwiftAgentErrorCode` from `./errors.js` (use `.js` extensions — ESM/NodeNext).

3. **Export from the shared barrel.** In `packages/shared/src/index.ts`, add a `// Protocol versioning & compatibility (WS-37)` block exporting the value symbols (`API_PROTOCOL_VERSION`, `SDK_MIN_SERVER_PROTOCOL`, `PROTOCOL_HEADER`, `PROTOCOL`, `assertProtocolCompatible`) next to the existing runner-protocol block. Nothing to export as type-only (all are values).

4. **Unit-test the assertion.** Create `packages/shared/src/protocol.test.ts` (see Tests). Extend `packages/shared/src/index.test.ts` to import the new symbols from `./index.js` and assert they are defined + the new error code is present.

5. **SDK: make headers reachable.** In `packages/sdk/src/client.ts`, change `request(...)` to return `{ body, headers }`. Grep `this.request(` (rule 10) and update **every** call site to read `.body` — most methods (`getAgent`, `listMessages`, `createRun`, etc.) only need the body; `registerAgent` and `createSession` need headers.

6. **SDK: assert at registration.** In `registerAgent`, after the request resolves: `assertProtocolCompatible(headers.get(PROTOCOL_HEADER))` (import both from `@swiftagent/shared`), then `AgentRecordSchema.parse(body)` and return. Assertion runs before parse so a version mismatch is reported ahead of any body-shape error.

7. **SDK: surface the version from `createSession`.** In `packages/sdk/src/types.ts`, add optional `serverProtocolVersion?: string` to `CreateSessionResult`. In `createSession`, read `headers.get(PROTOCOL_HEADER)` off the `{ body, headers }` and return `{ ...(body as CreateSessionResult), serverProtocolVersion: headers.get(PROTOCOL_HEADER) ?? undefined }`. Do **not** assert here — the connect-time assertion lives in `@swiftagent/react`.

8. **react: assert before connecting.** Thread an optional `serverProtocolVersion?: string` through `CreateChatSessionOptions`/`UseConnectionOptions`/`UseAgentChatArgs` (`packages/react/src/types.ts`, `hooks/use-connection.ts`, `hooks/use-agent-chat.ts`). In `packages/react/src/client.ts`, call `assertProtocolCompatible(API_PROTOCOL_VERSION, opts.serverProtocolVersion)` (import both from `@swiftagent/shared`) at the **top** of `createChatSession`, *before* `resolveConnectionUrl` and `connect()` — so a mismatch throws before any socket opens and before the URL is resolved. In `use-connection.ts`, forward `serverProtocolVersion` to `createChatSession`; the synchronous throw inside the `useEffect` is caught and surfaced through the existing `onError` → `setLastError` path (do not rethrow out of the effect). Leave WS-34's `resolveConnectionUrl`/reconnect logic untouched. Grep `createChatSession(` and `useConnection(` (rule 10) to update every call site for the new optional arg.

9. **Server: advertise the version.** In `packages/api/src/server.ts`, add the `onSend` hook (Design Notes) after `registerAuth`, importing `PROTOCOL_HEADER` + `API_PROTOCOL_VERSION` from `@swiftagent/shared`. Confirm it does not collide with any existing `onSend`/`setNotFoundHandler` behavior (there is none today). This single hook covers both `POST /v1/agents` (registration) and `POST /v1/sessions` (connect).

10. **Initialize Changesets.** Add `@changesets/cli` to root `devDependencies`; add the `changeset` and `version-packages` scripts; create `.changeset/config.json` and `.changeset/README.md` (run `pnpm dlx @changesets/cli init` if it produces the standard README, then overwrite `config.json` with the values in Design Notes). Run `pnpm install`; commit the updated lockfile.

11. **Author `docs/policies/versioning.md`.** Sections (numbered, migrations-runbook tone):
   1. *Scope & principles* — semver for `@swiftagent/*`; Changesets is the source of truth; packages currently private (WS-38 publishes).
   2. *What is breaking vs. minor vs. patch* — enumerate for the SDK public surface: removing/renaming an export, narrowing a param type, adding a required field, changing a default = **major**; adding an optional param, a new export, a new `ChatEvent` variant consumed additively = **minor**; internal fix with no surface change = **patch**.
   3. *Deprecation & removal window* — how a symbol is marked `@deprecated`, minimum one minor release of overlap, removal only on a major, changelog callout.
   4. *Protocol versioning* — `API_PROTOCOL_VERSION` vs `RUNNER_PROTOCOL_VERSION`, why they are distinct, and that the stream contract is `ChatEvent`/`ChatEventSchema`.
   5. *SDK↔server compatibility policy* — the `x-swiftagent-protocol` header, fail-open-on-absence, `assertProtocolCompatible` at **both** `registerAgent` (SDK) and connect time (react, from `CreateSessionResult.serverProtocolVersion`), and a **support matrix** table (SDK major × server protocol major → supported / upgrade-server / upgrade-SDK). Note that the connect-time check is client-side off the session-create header (no stream-protocol change); document a WS-handshake version advertisement as possible future hardening only.
   6. *Releasing (pointer)* — one paragraph: authors add a changeset per user-facing change; `version-packages` consumes them; **the publish workflow is WS-38** (link, do not duplicate).

12. **Verify (forced).** From the repo root run, and fix all errors before declaring done:
    - `pnpm typecheck`
    - `pnpm lint`
    - `pnpm test`
    - `pnpm test:integration` (needs Docker/Testcontainers; if the environment cannot run it, state that explicitly and run the rest — per the user's memory note that the integration tree validates via `pnpm test:integration`).
    - `pnpm --filter @swiftagent/shared exec node -e "require('@changesets/config')"` is unnecessary; instead assert the config parses by running `pnpm changeset status --since=main` (or `pnpm changeset --help`) and confirming the CLI loads `.changeset/config.json` without a config error.
    Report the exact commands and results.

## Tests

Numbered. Unit tests use mocks (no Testcontainers). Follow the existing `describe/it` + Vitest style in `packages/shared/src/index.test.ts`.

1. **`assertProtocolCompatible` — compatible passes (shared).** `expect(() => assertProtocolCompatible('1')).not.toThrow()` with the default local `{min:'1',current:'1'}`. Also assert an explicit-match override passes: `assertProtocolCompatible('2', { min: '1', current: '2' })`.

2. **`assertProtocolCompatible` — server too old throws (shared).** `assertProtocolCompatible('1', { min: '2', current: '2' })` throws a `SwiftAgentError`; assert `err.code === 'INCOMPATIBLE_VERSION'`, `err.statusCode === 409`, and the message contains both the server version (`1`) and the SDK current (`2`) and the word `server` (actionable: upgrade the server). Use `isSwiftAgentError`.

3. **`assertProtocolCompatible` — server too new throws (shared).** `assertProtocolCompatible('3', { min: '1', current: '2' })` throws `INCOMPATIBLE_VERSION`; message names both versions and instructs upgrading `@swiftagent/sdk`.

4. **`assertProtocolCompatible` — unparseable throws (shared).** `assertProtocolCompatible('banana')` throws `INCOMPATIBLE_VERSION` with a message naming the bad value.

5. **`assertProtocolCompatible` — absent fails open (shared).** `assertProtocolCompatible(undefined)`, `assertProtocolCompatible(null)`, and `assertProtocolCompatible('')` all return without throwing (legacy-server tolerance).

6. **Barrel re-export (shared).** In `index.test.ts`, import `PROTOCOL`, `API_PROTOCOL_VERSION`, `SDK_MIN_SERVER_PROTOCOL`, `PROTOCOL_HEADER`, `assertProtocolCompatible` from `./index.js`; assert each is defined, `PROTOCOL.header === 'x-swiftagent-protocol'`, `PROTOCOL.runner === RUNNER_PROTOCOL_VERSION`, and `SwiftAgentErrorCode.INCOMPATIBLE_VERSION === 'INCOMPATIBLE_VERSION'`.

7. **SDK `registerAgent` — passes on matching header (sdk).** Mock `fetch` (or inject via the existing test harness — glob `packages/sdk/**/*.test.ts` to find/reuse it) to return `200` with header `x-swiftagent-protocol: 1` and a valid `AgentRecord` body. Assert `registerAgent(...)` resolves to the parsed record and does **not** throw.

8. **SDK `registerAgent` — throws on mismatched header (sdk).** Mock `fetch` to return header `x-swiftagent-protocol: 2` while the SDK's `API_PROTOCOL_VERSION`/`SDK_MIN_SERVER_PROTOCOL` are `1`. Assert `registerAgent(...)` rejects with a `SwiftAgentError` whose `code === 'INCOMPATIBLE_VERSION'`, and that the mismatch is detected **before** body parsing (a malformed body must not mask the version error — supply a body that would otherwise fail `AgentRecordSchema.parse` and confirm the thrown error is the version error, not a Zod error).

9. **SDK `registerAgent` — legacy server (no header) still works (sdk).** Mock `fetch` to return a valid `AgentRecord` body with **no** `x-swiftagent-protocol` header. Assert `registerAgent(...)` resolves normally (fail-open path).

10. **SDK `createSession` — surfaces `serverProtocolVersion` (sdk).** Mock `fetch` to return a valid session body with header `x-swiftagent-protocol: 1`. Assert `createSession(...)` resolves with `result.serverProtocolVersion === '1'` (and does **not** throw — the SDK does not assert here). With **no** header, assert `result.serverProtocolVersion === undefined`.

11. **react connect-time — mismatch surfaces typed error, socket NOT opened (react).** Glob `packages/react/**/*.test.ts` first. Inject a spy `createWebSocket` factory. Call `createChatSession({ ..., serverProtocolVersion: '2', createWebSocket })` while the react `API_PROTOCOL_VERSION` is `1`: assert it throws a `SwiftAgentError` with `code === 'INCOMPATIBLE_VERSION'` and that the factory spy was **never invoked** (no socket opened). Then via the hook: render `useConnection`/`useAgentChat` with `serverProtocolVersion: '2'` and assert `lastError` becomes the actionable `INCOMPATIBLE_VERSION` message and `connectionStatus` never reaches `'connecting'`/`'connected'` (factory spy uninvoked). Use `isSwiftAgentError`.

12. **react connect-time — compatible version connects normally (react).** Call `createChatSession({ ..., serverProtocolVersion: '1', createWebSocket })` (react `API_PROTOCOL_VERSION` is `1`): assert no throw and the factory spy **is** invoked (socket opened) with the resolved URL unchanged from the WS-34 behavior. Also assert `serverProtocolVersion: undefined` (legacy) connects normally (fail-open) — proving WS-34's URL/reconnect path is untouched.

13. **API advertises the header (api).** In `packages/api/src/__tests__/agents.test.ts`, after a successful `POST /v1/agents` inject, assert `res.headers['x-swiftagent-protocol'] === API_PROTOCOL_VERSION` (import the constant from `@swiftagent/shared`). Optionally assert a second, unrelated endpoint (e.g. `/v1/health`) also carries the header, proving the `onSend` hook is global.

14. **Changesets config parses (config).** Assert `.changeset/config.json` is valid JSON with `baseBranch === 'main'` and `access === 'restricted'` — either a tiny Vitest test that `JSON.parse`s the file, or (preferred) `pnpm changeset status --since=main` running clean in CI/locally, documented in the PR. The CLI erroring on a malformed config is itself the assertion.

## Acceptance Criteria

Each is independently verifiable.

1. **Policy committed.** `docs/policies/versioning.md` exists and contains: semver rules for `@swiftagent/*`, an explicit breaking/minor/patch classification for the SDK public surface, a deprecation window/process, and an SDK↔server compatibility section with a support-matrix table — satisfying **SC-02**.

2. **Constants surfaced.** `@swiftagent/shared` exports `API_PROTOCOL_VERSION`, `SDK_MIN_SERVER_PROTOCOL`, `PROTOCOL_HEADER`, `PROTOCOL`, and `assertProtocolCompatible` from its public barrel; `RUNNER_PROTOCOL_VERSION` and the runner/`ChatEvent` schemas are unchanged — satisfying part of **SC-03**.

3. **New error code, in lockstep.** `SwiftAgentErrorCode.INCOMPATIBLE_VERSION` exists with `CODE_TO_STATUS` mapping `409`; `tsc` compiles (proving both maps updated together).

4. **Assertion is pure and correct.** `assertProtocolCompatible` throws `SwiftAgentError(INCOMPATIBLE_VERSION)` with a message naming both the server and SDK versions and the correct upgrade instruction on: server-too-old, server-too-new, and unparseable inputs; and returns without throwing on an exact match and on absent/empty input (fail-open). Covered by Tests 1–5.

5. **SDK asserts at registration.** `ControlPlaneClient.registerAgent` reads the `x-swiftagent-protocol` response header and calls `assertProtocolCompatible` **before** parsing the body; a mismatch throws the `INCOMPATIBLE_VERSION` `SwiftAgentError` (Tests 7–8), and a header-less legacy server still succeeds (Test 9) — the registration half of **SC-03**.

6. **Client asserts at connect time (no stream-protocol change).** `ControlPlaneClient.createSession` surfaces the server's `x-swiftagent-protocol` as `CreateSessionResult.serverProtocolVersion` (Test 10), and the `@swiftagent/react` connect path calls `assertProtocolCompatible(API_PROTOCOL_VERSION, serverProtocolVersion)` **before** opening the WebSocket — refusing to connect on mismatch with an actionable typed `SwiftAgentError(INCOMPATIBLE_VERSION)` (thrown for the vanilla client, via `lastError` for the hook), and connecting normally on a compatible/absent version (Tests 11–12). No `ChatEvent`/WS-handshake/stream-protocol field was added, and WS-34's URL-resolution/reconnect logic is unchanged — the connect half of **SC-03**.

7. **Server advertises non-breakingly.** `buildApp` sets `x-swiftagent-protocol: <API_PROTOCOL_VERSION>` on all responses via `onSend`; no route handler, no request/response schema, no `ChatEvent`, and no runner schema was modified (verify by grepping the diff — the only `packages/api` change is `server.ts` + its test). Covered by Test 13.

8. **Changesets initialized (config only).** Root `devDependencies` include `@changesets/cli`; `.changeset/config.json` has `baseBranch: "main"`, `access: "restricted"`, a valid `changelog`; root scripts `changeset` and `version-packages` exist; **no** publish/release workflow was added (that is WS-38); packages remain `"private": true`. `pnpm changeset status --since=main` loads the config without error (Test 14).

9. **No env var added.** `ENV_KEYS` in `packages/shared/src/config.ts` is unchanged; the protocol version is a compile-time constant (stated in PR).

10. **Verification green.** `pnpm typecheck`, `pnpm lint`, and `pnpm test` all pass; `pnpm test:integration` passes (or its Docker/Testcontainers requirement is explicitly noted as un-runnable in this environment with the unit/typecheck/lint suites green) — satisfying **SC-10**. Exact commands and results are reported per CLAUDE.md forced-verification.

11. **Grep discipline honored (rule 10).** When `request(...)`'s return shape changed, every `this.request(` call site in `packages/sdk/src/client.ts` was updated (grepped separately for direct calls); no call site silently consumes the new `{ body, headers }` object where it previously used the bare body. Likewise, every `createChatSession(` / `useConnection(` call site was updated for the new optional `serverProtocolVersion`.
