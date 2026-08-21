# WS-22: Secure Remote SDK Runner Integration

## Goal

Turn the existing `RemoteToolExecutor` ↔ SDK tool-runner path into the production, security-hardened customer-tool execution boundary. Today the remote executor reuses the raw workspace API key as the runner bearer token, sends a `context` object the SDK schema silently strips `runId` from, performs no outbound-URL validation (SSRF risk), imposes no payload bounds, does not validate the runner's response shape, and retries on 5xx even for potentially non-idempotent tool calls. This workstream defines a versioned runner request/response protocol in `@swiftagent/shared`, aligns the request context contract (including `runId` and invocation identity), introduces short-lived scoped runner credentials, adds HTTPS + outbound-target (SSRF) protection, bounds input/output/error payloads, adds idempotency keys so transport retries cannot double-execute mutating tools, propagates abort/deadline, and produces stable transport/validation/timeout/handler error mapping.

## Traceability

- **SC-06** — A registered tool call is persisted, executed by the active agent's remote SDK runner, returned to the model, and followed by a final assistant response.
- **SC-08** — Runner requests use short-lived scoped authentication and reject unauthorized, expired, or scope-mismatched calls.
- **SC-09** — Deployed remote execution rejects disallowed outbound targets and enforces request, response, and deadline limits.
- **SC-10** — A retried remote invocation cannot execute the same logical tool call more than once when transport replay protection is enabled.

## Dependencies

- **WS-20** — produces the Swift Agent `tc_` call id (`ToolCall.callId`). WS-22's idempotency key and `RunnerRequestContextSchema.callId` require a `tc_` id; before WS-20 the loop passes provider-native ids (e.g. `call_abc`), which would violate `.startsWith('tc_')`. (Declared in the manifest and program dependency graph.)
- **WS-21** — `ToolExecutorResolver` builds `RemoteToolExecutor` per agent with an injected auth-token resolver (this workstream replaces the workspace-key token with scoped credentials).
- **product-x WS-08** — the SDK `startToolRunner` HTTP server and `ToolRunnerRequestSchema`.

## Context Files (Agent MUST read before implementing)

- `c:\dev\swift-agent\CLAUDE.md` — conventions (`jose` for JWT, Zod validation, `SwiftAgentError`).
- `c:\dev\swift-agent\packages\runtime\src\tool-executor-remote.ts` — full current remote executor (URL build, headers, retry, parse).
- `c:\dev\swift-agent\packages\runtime\src\tool-executor-resolver.ts` — resolver from WS-21 (injects the auth token).
- `c:\dev\swift-agent\packages\runtime\src\tool-executor.ts` — `ToolCall`, `ToolCallContext`, `ToolCallResult`.
- `c:\dev\swift-agent\packages\sdk\src\tool-runner.ts` — full current runner server (auth, body parse, execute, error mapping).
- `c:\dev\swift-agent\packages\sdk\src\types.ts` — `ToolRunnerRequestSchema`, `ToolContext`, `ToolRunnerSuccessResponse`, `ToolRunnerErrorResponse`.
- `c:\dev\swift-agent\packages\sdk\src\app.ts` — `startToolRunner` invocation (passes `apiKey`).
- `c:\dev\swift-agent\packages\shared\src\config.ts` — `ENV_KEYS`, `TOOL_RUNNER_PUBLIC_URL`.
- `c:\dev\swift-agent\packages\shared\src\types\errors.ts` — `SwiftAgentError`, `SwiftAgentErrorCode` (`TIMEOUT`, `CONNECTION_ERROR`, `UNAUTHORIZED`, `VALIDATION`).
- `c:\dev\swift-agent\apps\server\src\container.ts` — where the resolver's `resolveAuthToken` is wired (mint scoped creds here).

## Package

`packages/shared`, `packages/runtime`, `packages/sdk`, `apps/server`

## Files Touched

- `packages/shared/src/types/runner-protocol.ts` **(NEW)** — versioned request/response Zod schemas + shared limits/constants.
- `packages/shared/src/index.ts` **(MODIFY)** — export runner-protocol schemas/types.
- `packages/shared/src/config.ts` **(MODIFY)** — add asymmetric runner-token key env vars + SSRF policy env keys.
- `packages/runtime/src/runner-credentials.ts` **(NEW)** — mint short-lived scoped runner tokens with an **asymmetric** private key (RS256/EdDSA via `jose`).
- `packages/runtime/src/ssrf.ts` **(NEW)** — outbound URL / resolved-IP validation + a pinned-IP undici dispatcher.
- `packages/runtime/src/tool-executor-remote.ts` **(MODIFY)** — per-call scoped mint, SSRF guard with IP pinning, idempotency key, bounded payloads, response validation, deadline/abort, error mapping.
- `packages/runtime/src/tool-executor-resolver.ts` **(MODIFY)** — replace WS-21's interim `resolveAuthToken(agent)` with a per-call minting contract; the resolver closes over agent/workspace and the remote executor mints inside `execute(call, ctx)`.
- `packages/runtime/src/index.ts` **(MODIFY)** — export credential + SSRF helpers.
- `packages/runtime/package.json` **(MODIFY)** — add `jose` (^6, asymmetric token minting) and `undici` (pinned-IP dispatcher); neither is currently declared. Refresh `pnpm-lock.yaml`.
- `packages/sdk/package.json` **(MODIFY)** — add `jose` (^6, public-key token verification); not currently declared. Refresh `pnpm-lock.yaml`.
- `packages/sdk/src/runner-token.ts` **(NEW)** — verify scoped tokens against the distributed **public** key.
- `packages/sdk/src/tool-runner.ts` **(MODIFY)** — verify scoped token, accept and validate `agentId`/`runId`/`callId`, idempotency de-dup, bounded body, versioned responses.
- `packages/sdk/src/types.ts` **(MODIFY)** — extend `ToolContext` with `agentId`/`runId`/`callId`; align `ToolRunnerRequestSchema` with the shared protocol; add runner public-key config.
- `packages/sdk/src/app.ts` **(MODIFY)** — pass the runner verification public key to `startToolRunner`.
- `apps/server/src/container.ts` **(MODIFY)** — wire the private key; resolver mints scoped runner credentials per run/agent/tool.
- `packages/runtime/src/__tests__/remote-runner-security.test.ts` **(NEW)** — SSRF (incl. rebinding), scoped auth, idempotency, bounds, error-mapping tests.
- `packages/sdk/src/__tests__/tool-runner-security.test.ts` **(NEW)** — token verification + idempotency de-dup tests.

## Existing Interfaces to Consume

**`RemoteToolExecutor` today** (`packages/runtime/src/tool-executor-remote.ts`): constructor `{ toolRunnerUrl; authToken; timeoutMs?; maxRetries?; retryDelayMs? }` (defaults 30000/1/1000). `execute` builds `url = \`${toolRunnerUrl}/tools/${call.toolName}\``, body `{ input: call.arguments, context: ctx }`, header `Authorization: Bearer ${authToken}`, merges `AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])`, returns `{ ok }` on 2xx, no-retry on 4xx, retries on 5xx/network, and maps abort/timeout.

**SDK runner today** (`packages/sdk/src/tool-runner.ts`): `POST /tools/:toolName`; auth via `safeCompare(bearerToken, apiKey)` (constant-time); parses body with `ToolRunnerRequestSchema`; validates `input` against the tool's Zod schema; executes with a timeout race; responds `{ result }` on success or `{ error: { code, message, details? } }` with statuses 401/404/400/504/500.

**SDK request schema today** (`packages/sdk/src/types.ts`) — note the missing `runId`:

```typescript
export const ToolRunnerRequestSchema = z.object({
  input: z.unknown(),
  context: z.object({
    sessionId: z.string(),
    userId: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
});
```

**`ToolCallContext` (runtime)** already includes `runId`, but the SDK schema drops it.

**Resolver hook (WS-21)** — `createToolExecutorResolver({ resolveAuthToken })`; this workstream supplies a `resolveAuthToken` that returns a scoped token instead of the workspace key.

## Runner Protocol (shared) — `packages/shared/src/types/runner-protocol.ts`

Define a versioned, bounded wire contract used by both `RemoteToolExecutor` and `startToolRunner`:

```typescript
export const RUNNER_PROTOCOL_VERSION = '1' as const;

// Bounds (bytes) — reject oversized payloads before parsing/executing
export const RUNNER_MAX_INPUT_BYTES = 256 * 1024;   // 256 KiB
export const RUNNER_MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB
export const RUNNER_MAX_ERROR_BYTES = 8 * 1024;     // 8 KiB

export const RunnerRequestContextSchema = z.object({
  sessionId: z.string().startsWith('ses_'),
  agentId: z.string().startsWith('agt_'),
  runId: z.string().startsWith('run_'),
  callId: z.string().startsWith('tc_'),        // Swift Agent tc_ id (invocation identity)
  userId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const RunnerRequestSchema = z.object({
  version: z.literal(RUNNER_PROTOCOL_VERSION),
  idempotencyKey: z.string().min(1),           // stable per logical tool call
  input: z.unknown(),
  context: RunnerRequestContextSchema,
}).strict();
export type RunnerRequest = z.infer<typeof RunnerRequestSchema>;

export const RunnerSuccessResponseSchema = z.object({
  version: z.literal(RUNNER_PROTOCOL_VERSION),
  result: z.unknown(),
}).strict();

export const RunnerErrorResponseSchema = z.object({
  version: z.literal(RUNNER_PROTOCOL_VERSION),
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
}).strict();
export type RunnerResponse = z.infer<typeof RunnerSuccessResponseSchema> | z.infer<typeof RunnerErrorResponseSchema>;
```

The `idempotencyKey` is the Swift Agent `tc_` call id (SC-05 identity from WS-20). It uniquely identifies the logical tool call so replays are safe (SC-10).

## Scoped Runner Credentials — `packages/runtime/src/runner-credentials.ts`

Short-lived **asymmetrically-signed** JWT (RS256 or EdDSA via `jose`), scoped to a single run/agent/tool with an expiry. The hosted runtime holds the **private** signing key; each customer SDK runner is provisioned only the **public** verification key (or a JWKS URL). This prevents the shared-secret vulnerability where any customer holding a symmetric secret could forge tokens for arbitrary workspaces/agents/runs.

```typescript
export interface RunnerTokenClaims {
  aud: string;           // runner AUDIENCE — the target runner's stable public URL / provisioned id
  workspaceId: string;
  agentId: string;
  runId: string;
  callId: string;        // tc_ id (also the idempotency key)
  idempotencyKey: string;
  toolName: string;
  exp: number;           // seconds since epoch, short (e.g. now + 60s)
}
// Private key signs (runtime side)
export function mintRunnerToken(privateKey: CryptoKey | KeyLike, claims: Omit<RunnerTokenClaims,'exp'>, ttlSeconds?: number): Promise<string>;
// Public key verifies (SDK side, in packages/sdk/src/runner-token.ts). `expected` carries the
// runner's own provisioned identity; verification REQUIRES claims.aud === expected.audience AND
// claims.workspaceId === expected.workspaceId.
export interface ExpectedRunnerIdentity { audience: string; workspaceId: string; }
export function verifyRunnerToken(publicKey: CryptoKey | KeyLike, token: string, expected: ExpectedRunnerIdentity): Promise<RunnerTokenClaims>; // throws SwiftAgentError(UNAUTHORIZED) on expiry/scope/audience/workspace/signature failure
```

**Why bind BOTH `aud` and `workspaceId` (resolves runner-identity + confused-deputy).** A single SDK runner process is started once by `app.listen()` and hosts *many* agents, and it starts **before** any `agt_`/`run_` id exists — so a token cannot be bound to one `agentId` per runner. Two startup-known identifiers are used instead:
- **`aud`** — the runner's stable public base URL (`TOOL_RUNNER_PUBLIC_URL`, overridable via `RUNNER_AUDIENCE`). Because the hosted runtime distributes **one** public key to all customer runners, without an audience a token minted for runner A would verify at runner B; `aud` closes that cross-runner replay (including between two runners of the *same* workspace).
- **`workspaceId`** — the workspace that owns the runner, provisioned via `RUNNER_WORKSPACE_ID` (the customer knows their `ws_` id from the dashboard; it is fixed for the life of the runner and known before any agent registers). This closes a **confused-deputy** attack: an attacker who registers *another* customer's runner URL as their own agent's `toolRunnerUrl` would receive a token with `aud = victimUrl` but `workspaceId = attackerWorkspace`; the victim runner (provisioned with its own `workspaceId`) rejects it because `claims.workspaceId` does not match. `aud` alone cannot stop this because the attacker's token legitimately targets the victim's URL.

`agentId`/`runId`/`callId`/`toolName`/`idempotencyKey` remain in the token. The request context carries `agentId`/`runId`/`callId`, allowing the runner to match every signed invocation-scope claim against request data before execution and surface the invocation identity to the handler — these values are NOT required to be known by the runner before startup. **Defense-in-depth (out of scope, note for `/review-program`):** the control plane should also validate at agent-registration time that a submitted `toolRunnerUrl` belongs to the registering workspace (per-workspace host allowlist), so a workspace cannot even register a foreign runner URL.

The token is minted per invocation (so it carries `callId`/`toolName`/`idempotencyKey`), passed as the runner bearer token, and verified by the SDK runner against the distributed public key **and its own configured audience + workspaceId**. Default TTL short (≤120s). The SDK's `verifyRunnerToken` (in `packages/sdk/src/runner-token.ts`) imports only the public-key verification path so the private key never reaches customer infrastructure.

## SSRF Guard — `packages/runtime/src/ssrf.ts`

```typescript
export interface OutboundUrlPolicy { requireHttps: boolean; allowLoopback: boolean; }
// Returns the validated URL AND the pinned IP the request MUST connect to.
export async function resolveAllowedOutboundTarget(rawUrl: string, policy: OutboundUrlPolicy): Promise<{ url: URL; pinnedIp: string }>;
// undici dispatcher that connects to `pinnedIp` while preserving Host header + TLS SNI.
export function createPinnedDispatcher(pinnedIp: string): Dispatcher;
```

- In deployed environments (`requireHttps: true`): reject non-`https:` URLs.
- Resolve the hostname (DNS) and reject if any resolved address is loopback (`127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16`, `fe80::/10`), private (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), or cloud metadata (`169.254.169.254`).
- **Prevent DNS rebinding / TOCTOU (major finding):** do NOT validate with one DNS lookup and then let `fetch` resolve the host again. Instead return the validated `pinnedIp` and issue the request through `createPinnedDispatcher(pinnedIp)` (an `undici` `Agent` with a custom `connect`/`lookup` that dials the exact validated IP while keeping the original `Host` header and TLS SNI). This guarantees the socket connects to the address that passed validation.
- `allowLoopback: true` only for local/test policy (used by integration tests against a local runner).
- Throw `SwiftAgentError(VALIDATION, 'Disallowed runner target ...')` on rejection.

## Implementation Steps

1. **Shared protocol (`packages/shared/src/types/runner-protocol.ts`)**: Add the schemas, bounds, and version constant above. Export from `packages/shared/src/index.ts`.

2. **Config (`packages/shared/src/config.ts`)**: Add `ENV_KEYS.RUNNER_TOKEN_PRIVATE_KEY` (PEM/JWK; runtime signs — required in deployed env), `ENV_KEYS.RUNNER_TOKEN_PUBLIC_KEY` (PEM/JWK; distributed to SDK runners), `ENV_KEYS.RUNNER_AUDIENCE` (optional; the runner's audience — defaults to `TOOL_RUNNER_PUBLIC_URL` when unset), `ENV_KEYS.RUNNER_WORKSPACE_ID` (the runner's owning workspace `ws_` id — provisioned on the SDK runner side for confused-deputy protection), and optional `ENV_KEYS.RUNNER_REQUIRE_HTTPS` (default true in production). Add matching Zod fields to `ConfigSchema`. Remove/supersede the interim `INTERNAL_RUNNER_TOKEN` from WS-21.

3. **Credentials (`packages/runtime/src/runner-credentials.ts`)**: Implement `mintRunnerToken(privateKey, claims, ttl?)` using `jose` with an asymmetric alg (RS256 or EdDSA). Implement the verification counterpart in the SDK (`packages/sdk/src/runner-token.ts`) `verifyRunnerToken(publicKey, token, expected: { audience, workspaceId })` — validates signature + `exp`, requires `claims.aud === expected.audience` AND `claims.workspaceId === expected.workspaceId`, and returns claims; the runtime never needs the public key and the SDK never sees the private key. Map any failure to `SwiftAgentError(UNAUTHORIZED)`.

4. **SSRF (`packages/runtime/src/ssrf.ts`)**: Implement `resolveAllowedOutboundTarget` using `node:dns/promises` `lookup(host, { all: true })` + `node:net` range checks, returning the validated URL and the chosen `pinnedIp`. Implement `createPinnedDispatcher(pinnedIp)` as an `undici` `Agent` whose `connect` uses the pinned IP while preserving `Host`/SNI. Provide a helper `isDisallowedAddress(ip: string): boolean`.

5. **RemoteToolExecutor (`packages/runtime/src/tool-executor-remote.ts`)**:
   - Constructor gains `{ agentId: string; policy: OutboundUrlPolicy; mintToken: (call: ToolCall, ctx: ToolCallContext) => Promise<string> }` (the resolver injects the resolved agent id plus `mintToken`, which closes over the agent/workspace so claims can include `agentId`/`workspaceId`); keep `timeoutMs`/`maxRetries`/`retryDelayMs`.
   - Before the request: `const { url, pinnedIp } = await resolveAllowedOutboundTarget(\`${this.toolRunnerUrl}/tools/${encodeURIComponent(call.toolName)}\`, this.policy)` and issue the request through `createPinnedDispatcher(pinnedIp)` so validation and connection cannot diverge (SC-09).
   - Bound the input: serialize `call.arguments`; if it exceeds `RUNNER_MAX_INPUT_BYTES`, return `{ ok:false, error:'Tool input exceeds limit' }` without sending (SC-09).
   - Build a `RunnerRequest`: `{ version, idempotencyKey: call.callId, input: call.arguments, context: { sessionId, agentId: this.agentId, runId, callId: call.callId, userId, metadata } }` (SC-05 identity, SC-08 agent scope, SC-10 key).
   - Auth header: `Authorization: Bearer ${await this.mintToken(call, ctx)}` (SC-08) — a per-call asymmetric token, never the raw workspace key.
   - Enforce a response body size cap while reading (stream/limit to `RUNNER_MAX_OUTPUT_BYTES`); validate with `RunnerSuccessResponseSchema` / `RunnerErrorResponseSchema`; unknown shapes → `{ ok:false, error:'Invalid runner response' }` (SC-09).
   - **Idempotency-aware retry (SC-10)**: retries reuse the SAME `idempotencyKey`. Only retry on transport/5xx failures where replay is safe because the runner de-dups on `idempotencyKey`. Do NOT retry a request that timed out after the runner may have begun work unless the same key guarantees single execution — document that a timeout does not imply rollback. Keep 4xx = no retry.
   - Error mapping: transport/network → `CONNECTION_ERROR` message; timeout/abort → `TIMEOUT` / `'Aborted'`; validation → clear message; handler error (runner `{ error }`) → its message. Return structured `ToolCallResult` (never throw).

6. **Resolver update (`packages/runtime/src/tool-executor-resolver.ts`)**: Replace WS-21's `resolveAuthToken(agent)` with a minting contract. The resolver now injects `agentId: agent.agentId` into `RemoteToolExecutor` and supplies a `mintToken(call, ctx)` closure that captures the same resolved `agent` (for `agentId`/`workspaceId`/`toolRunnerUrl`) and calls `mintRunnerToken(privateKey, { aud: agent.toolRunnerUrl, workspaceId, agentId: agent.agentId, runId: ctx.runId, callId: call.callId, idempotencyKey: call.callId, toolName: call.toolName })`. This single resolved-agent source ensures the request `context.agentId` and signed `claims.agentId` cannot drift. The `aud` is the agent's registered runner URL (the runner it will actually be sent to). This resolves the ordering problem (run/call ids do not exist at resolve time — only at execute time) and the audience is a value both sides already agree on.

7. **SDK runner (`packages/sdk/src/tool-runner.ts`)**:
   - Replace `safeCompare(token, apiKey)` auth with `verifyRunnerToken(publicKey, token, { audience: expectedAudience, workspaceId: expectedWorkspaceId })` (SC-08), where `expectedAudience` is the runner's configured audience (`RUNNER_AUDIENCE`, defaulting to `TOOL_RUNNER_PUBLIC_URL`) and `expectedWorkspaceId` is the runner's owning workspace (`RUNNER_WORKSPACE_ID`) — both known at startup, before any agent is registered. Verification REQUIRES `claims.aud === expectedAudience` **and** `claims.workspaceId === expectedWorkspaceId` **unconditionally**; `aud` blocks cross-runner replay and `workspaceId` blocks the confused-deputy (a token minted for another workspace that targets this runner's URL). After signature+exp+audience+workspace pass, assert that **every** remaining scoped claim matches the request: `claims.agentId === context.agentId`, `claims.toolName === params.toolName`, `claims.runId === context.runId`, `claims.callId === context.callId`, `claims.idempotencyKey === body.idempotencyKey`. Reject any mismatch or expiry with 401.
   - Accept the versioned `RunnerRequest` (reject wrong `version` with 400). Enforce a request body byte cap covering the **whole envelope** (not just serialized arguments) via Fastify `bodyLimit`, sized to `RUNNER_MAX_INPUT_BYTES` plus a small envelope allowance.
   - **In-flight-aware idempotency (SC-10):** maintain a bounded (LRU/TTL) `Map<idempotencyKey, Promise<result> | result>`. On first arrival, store the **in-flight promise before executing the handler**; concurrent or retried requests with the same key `await`/replay that promise instead of re-executing. On completion, keep the settled result cached for the TTL. This prevents double execution when a retry arrives while the first invocation is still running. **Scope note:** idempotency is per-runner-process for MVP — a runner restart or multiple replicas can each execute once; cross-replica durable de-dup is future work.
   - Build `ToolContext` including `agentId`, `runId`, and `callId` from `context`.
   - Respond with versioned `{ version, result }` / `{ version, error }`; cap error message size to `RUNNER_MAX_ERROR_BYTES`.

8. **SDK types (`packages/sdk/src/types.ts`)**: Extend `ToolContext` with `agentId: string`, `runId: string`, and `callId: string`. Align `ToolRunnerRequestSchema` with the shared `RunnerRequestSchema` (prefer importing the shared schema to avoid drift). Add runner public-key, `expectedAudience`, and `expectedWorkspaceId` fields to the SDK app / `startToolRunner` config.

9. **SDK app (`packages/sdk/src/app.ts`)**: Pass the runner **public** key (from SDK config / `RUNNER_TOKEN_PUBLIC_KEY`), the runner's `expectedAudience` (from `RUNNER_AUDIENCE`, defaulting to `TOOL_RUNNER_PUBLIC_URL`), and the runner's `expectedWorkspaceId` (from `RUNNER_WORKSPACE_ID`) into `startToolRunner` so it can verify scoped tokens and enforce the audience + workspace binding. Keep `TOOL_RUNNER_PUBLIC_URL` behavior.

10. **Server wiring (`apps/server/src/container.ts`)**: Load the **private** key from config; give the resolver a `mintToken` backed by it. Set the executor `policy` from config (`requireHttps` true in production, loopback allowed only in dev/test). Remove the interim `INTERNAL_RUNNER_TOKEN` wiring and the `TODO(WS-22)` placeholder from WS-21.

11. **No-secret-leak check**: Grep to confirm the raw workspace API key is no longer used as the runner bearer token anywhere, and that the private signing key never appears in `packages/sdk`.

## Tests

1. **SSRF reject (SC-09)**: `assertAllowedOutboundUrl` rejects `http://169.254.169.254/...`, `http://127.0.0.1`, `http://10.0.0.5`, and (with `requireHttps`) any `http://` URL; accepts a public `https://` host.
2. **SSRF DNS rebinding**: hostname resolving to a private IP is rejected even though the literal host looks public (mock `dns.lookup`).
3. **Scoped token accept/reject (SC-08)**: SDK runner accepts a valid asymmetric-signed token whose `agentId`, `toolName`, `runId`, `callId`, and `idempotencyKey` all match the request; rejects expired token, wrong-`agentId`/`toolName`, mismatched `runId`/`callId`, and bad-signature (including a token signed with a different/symmetric key) with 401.
3b. **Asymmetric key isolation**: the SDK verify path uses only the public key; a token forged with a symmetric secret or a foreign private key is rejected.
4. **Input bound (SC-09)**: `RemoteToolExecutor` refuses to send an over-limit input; SDK runner rejects an over-limit body with 400.
5. **Output bound + response validation (SC-09)**: runner returns a body over the output cap or a non-conforming shape → executor returns `{ ok:false }` with a clear error.
2b. **DNS rebinding (SC-09)**: a hostname that passes validation but whose DNS later resolves to a private IP still connects only to the pinned validated IP (assert the request dials the pinned address, not a re-resolved one).
6. **Idempotency de-dup within a process (SC-10)**: two requests with the same `idempotencyKey` to one runner process cause the handler to execute exactly once; the second returns the cached result. Simulate a retry (first attempt 5xx, second attempt same key) and assert the tool ran once.
6b. **Concurrent in-flight de-dup (SC-10)**: fire two requests with the same `idempotencyKey` while the handler is still running (slow handler); assert the handler executes once and both callers receive the same result (the second awaits the in-flight promise).
6c. **Cross-runner audience binding (SC-08)**: a token whose `aud` targets runner A's URL is rejected (401) by a runner configured with a different `expectedAudience` (runner B), even though the signature is valid and `toolName`/`runId`/`callId` match — proving cross-runner replay is blocked without needing agent ids at startup.
6d. **Confused-deputy workspace binding (SC-08)**: a validly-signed token with `aud` = this runner's URL but `workspaceId` = a different workspace is rejected (401) because it does not match the runner's provisioned `RUNNER_WORKSPACE_ID` — proving a workspace cannot borrow another workspace's runner by registering its URL.
7. **Timeout no-double-exec (SC-10)**: a slow handler causes the executor to time out and retry with the same key; assert the handler is not executed twice.
8. **Context carries invocation identity (SC-06, SC-08)**: handler receives `ctx.agentId`, `ctx.runId`, and `ctx.callId`.
9. **Happy path (SC-06)**: registered tool call → remote execute → `{ ok:true, output }` returned; error mapping stable for handler failure.
10. **Error mapping**: network refusal → `CONNECTION_ERROR`; abort → `'Aborted'`; runner `{ error:{message} }` → that message.

## Acceptance Criteria

1. A versioned runner request/response protocol exists in `@swiftagent/shared` with input/output/error byte bounds and includes `agentId`, `runId`, and `tc_` `callId` in the request context.
2. Runner requests authenticate with short-lived **asymmetrically-signed** scoped tokens (per run/agent/tool/expiry); the SDK runner verifies with a distributed public key and rejects unauthorized, expired, and scope-mismatched tokens, checking `agentId`/`toolName`/`runId`/`callId`/`idempotencyKey` **and unconditionally requiring `claims.aud` to equal the runner's configured audience** (`RUNNER_AUDIENCE`, defaulting to `TOOL_RUNNER_PUBLIC_URL`) **and `claims.workspaceId` to equal the runner's configured `RUNNER_WORKSPACE_ID`** (both known at startup) so a token minted for one agent cannot be used for another agent, a token minted for one runner cannot be replayed against another, and a token minted for another workspace cannot be used against this runner even if it targets this runner's URL (confused-deputy) (SC-08). The raw workspace API key is no longer used as the runner bearer token, and the private signing key never reaches customer infrastructure.
3. Deployed remote execution requires HTTPS and rejects loopback, link-local, private, and metadata targets after DNS resolution; it connects only to the pinned validated IP (no DNS-rebinding window) and enforces request, response, and deadline limits (SC-09).
4. Remote invocations carry a stable idempotency key equal to the `tc_` call id; transport retries reuse the key and the SDK runner de-dups within a single runner process so a logical tool call executes at most once, including on timeout (SC-10). A timeout is documented as not implying rollback, and cross-replica/durable de-dup is documented as future work.
5. A registered tool call is persisted, executed by the active agent's remote runner with `agentId`/`runId`/`callId` context matching the signed token claims, and its result is returned to the model to produce a final assistant response (SC-06).
6. Runner responses are schema-validated; unknown shapes and oversized payloads are rejected with structured `ToolCallResult` errors (no thrown exceptions from `execute`).
7. `pnpm exec tsc --noEmit` and `pnpm exec eslint . --quiet` pass; new security tests pass.
