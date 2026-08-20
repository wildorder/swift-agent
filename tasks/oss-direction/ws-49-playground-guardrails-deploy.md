# WS-49: Playground Guardrails & Public Deployment

## Goal

Make the WS-48 playground safe to expose to the internet on the owner's model budget, deploy it publicly, and close out the program. This is the program's **sole terminal workstream**; every chain joins here. Five cohesive deliverables:

1. **A trusted server-side mediator** between the browser and the playground's runtime that is the **only** place limits are enforced. The mediator holds the runtime workspace API key; the browser holds **no credential of any kind**; the dedicated model-provider key is configured **only** as environment on the playground's isolated runtime deployment via the standard `apps/server` config path — the mediator never touches provider traffic, and no provider proxy or runtime feature is added. Enforced limits: per-IP and per-session rate limits, a per-session message cap, and a per-session token cap — each tested against a client that ignores the UI, and each producing a **defined refusal frame** of the mediator's OWN typed app-level protocol over the WebSocket (never a new `ChatEvent` variant, an unhandled error, a 500, or a dropped socket).
2. **Atomic reserve-then-settle spend accounting** against a **global daily spend ledger persisted in Postgres**, whose schema and forward-only migration THIS workstream owns and adds. Before a run starts, the mediator reserves a conservative per-run maximum cost derived from its own enforced caps and the cheap model's pricing. **Every reservation settles at its FULL reserved amount** — for all four terminal statuses (`completed`, `failed`, `cancelled`, `timed_out`) and, after a timeout, for abandoned never-terminal runs; a reservation is never released below its reserved amount. `RunRecord.tokenUsage` is recorded as observability data only and NEVER reduces a charge.
3. **Public deployment** of `apps/playground` to the WS-47 host target with its own database and secrets, isolated from dev/staging/prod, pinned to exactly one instance — verified **by observation** across a rolling deployment and a restart (SC-12) — with a short guest-session TTL, ephemeral retention configuration, a dedicated provider key carrying a **provider-side budget cap** (documented with its value), a deliberately **cheap default model** with a recorded cost rationale, and alerting/a documented check at a fraction of the daily ceiling.
4. **A smoke test against the live public URL** asserting a streaming turn with a visible tool call (SC-08).
5. **The program-final passes:** the SC-10 documentation pass (live playground link, deploy button, `npx create-swift-agent` + `@swiftagent/*` installs as the quickstart for the released state per decision 4, consistent with WS-44's release runbook, no surface claiming a version already exists on the registry, `docs/vision.md` ladder statuses consistent); the SC-11 posture sweep re-run over the **terminal** tree (four public packages public-postured, ten private packages `"private": true`, no active surface contradicting); and the SC-17 gate re-proof by repeated cache-bypassed runs of all four commands with every program package in the tree.

## Traceability

- **SC-08** — the playground is reachable at a public URL and, in one session, streams tokens and surfaces at least one tool call with its start, completion, and duration; proven by the live-URL smoke test.
- **SC-09** — server-side mediator as sole enforcement point; credential topology (runtime key in mediator, provider key only in the playground runtime's env, browser credential-free); per-IP/per-session limits + message cap + token cap tested against a UI-ignoring client; Postgres-persisted daily ledger with atomic reserve-then-settle and full-reservation settlement for the exhaustive terminal family plus abandoned runs; `tokenUsage` observability-only; typed refusal frames per limit; dedicated provider key with a documented provider-side budget cap.
- **SC-10** — the program-final documentation pass (this workstream depends on WS-46 precisely so this claim is only published after the scaffold exists, is verified, and is wired into the release workflow).
- **SC-11** — the terminal-tree repository-wide active posture sweep.
- **SC-12** — the playground deployment (one of exactly two members of the managed-surface family, with WS-47's template) pins to one instance with autoscaling disabled, verified by observation across a rolling deploy and a restart, documented citing `docs/runbooks/realtime-operations.md` §6.
- **SC-17** — the program-final gate re-proof: repeated cache-bypassed green runs of `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` with `apps/playground`, `packages/create-swift-agent`, and every other workstream's packages and tests in the tree.

## Dependencies

- **WS-46 — create-swift-agent Scaffold CLI.** Provides the built-and-verified scaffold: the package born public-postured, published into the WS-45 local registry, exercised end-to-end through real `npx` (generate → install → typecheck → build → streaming turn with a tool call), and added to the WS-44 release workflow. **This dependency exists for SC-10:** the documentation pass presents `npx create-swift-agent` as the supported quickstart, and that claim may only be published after the workstream that builds and verifies it has landed.
- **WS-47 — One-Click Deploy Template.** Provides the managed-host decision (Fly.io vs Railway, recorded against fixed criteria), the host configuration deploying the WS-50 GHCR image with documented registry credentials, the single-instance pinning pattern with the runbook-§6 rationale, managed Postgres + Redis provisioning, the forward-only `migrate` release step, secret/env documentation (including a correct public `wss://` `PUBLIC_WEBSOCKET_URL`), and the observation-based single-instance verification procedure. **WS-49 consumes this template for the playground's runtime; it does not author or modify the template.**
- **WS-48 — Playground Application.** Provides the app this workstream guards and deploys: the `@swiftagent/playground` package (born private), the four demo beats on the public surface, the guest-session mint route (`GET /api/session`) that already keeps the workspace API key server-side, the composed vanilla-client session controller in `frontend/src/session.ts`, and the tool roster including the deliberately failing tool. **WS-49 hardens the backend into the mediator and rewires the frontend's transport; it does not rebuild the UI or the tools.**

Transitively (via WS-46/WS-47): WS-43's local bootstrap, WS-44's release workflow + runbook, WS-45's registry, WS-50's published image and digest pin. All four gate commands must be green at this workstream's start and end.

## Context Files (Agent MUST read before implementing)

- `C:\dev\swift-agent\CLAUDE.md` — conventions (repositories are factory functions `createXxxRepo(db)`; Zod schemas as source of truth; ID prefixes; forced verification; grep every reference category).
- `C:\dev\swift-agent\docs\programs\oss-direction-manifest.json` — canonical: `workstreams[WS-49]` includes/excludes, SC-08/09/10/11/12/17, `constraints.singleInstance`, `constraints.publishingSurfaces` (terminal roster), `constraints.npmGate` (decision 4), `outOfScope[]`.
- `C:\dev\swift-agent\docs\programs\oss-direction-program.md` — the credential-topology correction (round 2), the spend-accounting correction (round 5, full-reservation settlement), the terminal-position rationale, and the risk-register rows on spend defence-in-depth.
- `C:\dev\swift-agent\packages\shared\src\types\run.ts` — **verified:** `RunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out'` — the four terminal statuses are exhaustive; `RunRecord.tokenUsage` is `TokenUsageSchema.nullable()`.
- `C:\dev\swift-agent\packages\runtime\src\loop.ts` — **verified:** `lastUsage = chunk.usage` on every `finish` chunk (line 181, inside the per-round stream loop) and completion persists only that final value via `deps.db.runs.complete(ctx.runId, { …lastUsage… })` (lines 411–415). This is why `tokenUsage` structurally under-counts every multi-round (i.e. every tool-calling) run and why the ledger never trusts it. **This file is read for evidence and MUST NOT be modified.**
- `C:\dev\swift-agent\packages\db\src\repositories\run-repo.ts` — `complete(runId, tokenUsage)` persists usage; `fail()`/`cancel()`/`timeout()` (lines 47–74) write status only, leaving `tokenUsage` null — the null-usage terminal family the settlement rule covers.
- `C:\dev\swift-agent\packages\api\src\routes\runs.ts` — `GET /v1/runs/:runId` (line 30) returns the `RunRecord`; the mediator may poll it for terminal status and observability `tokenUsage` (workspace-scoped, 404 across workspaces).
- `C:\dev\swift-agent\packages\sdk\src\client.ts` — `ControlPlaneClient`: `createSession` (returns `websocketUrl` + protocol header), `createRun`, `getRun`, `cancelRun` — the public surface the mediator composes for session minting, run observation, and cap-breach cancellation.
- `C:\dev\swift-agent\packages\shared\src\types\events.ts` — the closed, `.strict()` `ChatEvent` union. Refusal frames are NOT members of it and must not be added to it; the mediator relays these frames verbatim and speaks its own protocol beside them.
- `C:\dev\swift-agent\apps\server\src\config.ts` — provider-key validation at lines 92–101 (`At least one of: OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY`), `AUTO_MIGRATE` at line 130. This is the **standard config path** through which — and only through which — the dedicated provider key reaches the playground's runtime.
- `C:\dev\swift-agent\apps\server\src\container.ts` — provider registration at lines 129–152: keys pass directly into `ProviderRegistry.register` factories, in-process. No configuration routes provider traffic through anything else; this is the evidence that a mediator-owned provider credential is impossible without forbidden runtime work.
- `C:\dev\swift-agent\packages\db\drizzle.config.ts` + `packages\db\drizzle\` — migration layout: schema compiled to `dist/schema/*.js` first (drizzle-kit 0.30 loads via CJS), `db:generate` runs `tsc` then generates into `drizzle/` (`0000_baseline.sql`, `0001_…`, `0002_…` + `meta/`). The new ledger migration extends this chain.
- `C:\dev\swift-agent\packages\db\src\schema\index.ts` + `src\repositories\index.ts` — the barrels the new schema file and repo factory must be exported from.
- `C:\dev\swift-agent\docs\runbooks\migrations.md` — forward-only migrations via `node packages/db/dist/migrate.js`; drift preflight refuses on divergence; deploy surfaces run migrate as an explicit release step; no down-migrations exist or will be added.
- `C:\dev\swift-agent\docs\runbooks\realtime-operations.md` — §1 (all realtime state is process-local; a restart is a hard boundary — the reason an in-memory daily counter is really per-uptime-window) and §6 (single-task posture rationale to cite in the deploy docs).
- `C:\dev\swift-agent\test\smoke\realtime-smoke.ts` — the smoke pattern to mirror for the live-URL playground smoke: bounded everything (connect/wait/overall watchdog), limited retries with backoff, fatal-auth fast-fail, diagnostics printed on failure, `ChatEventSchema` frame validation via the shared `test/support/ws-client.ts`.
- `C:\dev\swift-agent\apps\playground\` (as delivered by WS-48) — the backend server (session-mint route, demo-config route, `app.listen()` runner), the frontend session controller, and the package layout this workstream extends.
- `C:\dev\swift-agent\README.md`, `C:\dev\swift-agent\docs\quickstart.md`, `C:\dev\swift-agent\docs\vision.md`, and the WS-44 release runbook (`RELEASING.md` or equivalent — locate it in the tree as WS-44 landed it) — the SC-10 surfaces.
- Memory note "Workspace deps must be declared": the mediator's new `@swiftagent/db` import MUST be declared in `apps/playground/package.json` — undeclared workspace imports pass CI but crash a `--prod`-pruned Docker build with `ERR_MODULE_NOT_FOUND`.

## Package

`apps/playground` (mediator + frontend transport rewiring + refusal rendering), `packages/db` (ledger schema + forward-only migration + repo factory), `deploy/` (playground deployment config consuming the WS-47 template pattern), `test/smoke` (live-URL smoke), `docs/` + `README.md` (SC-10 pass, guardrail/runcost documentation).

(`packages/runtime`, `packages/api`, `packages/sdk`, `packages/react`, `packages/shared`, and `apps/server` are **read, never modified** — no runtime work of any kind.)

## Files Touched

- `packages/db/src/schema/playground-spend.ts` **(NEW)** — the two ledger tables (see Design Notes: Ledger schema).
- `packages/db/src/schema/index.ts` **(MODIFY)** — export the new schema module.
- `packages/db/src/repositories/playground-spend-repo.ts` **(NEW)** — `createPlaygroundSpendRepo(db)` factory: `reserve`, `settle`, `sweepAbandoned`, `dayTotal` (see Design Notes: Reserve/settle flow).
- `packages/db/src/repositories/index.ts` + `packages/db/src/index.ts` **(MODIFY)** — export the factory and its types.
- `packages/db/drizzle/000X_*.sql` + `drizzle/meta/*` **(NEW, generated)** — the forward-only ledger migration via `pnpm --filter @swiftagent/db db:generate` (build first per `drizzle.config.ts`). Never hand-edit an existing migration.
- `packages/db/src/__tests__/playground-spend-repo.test.ts` **(NEW)** — ledger tests (Testcontainers Postgres, like the other repo integration tests in this package).
- `apps/playground/backend/src/mediator/` **(NEW)** — the mediator: WebSocket endpoint terminating the browser connection, upstream client to the runtime, limit enforcement, refusal frames, reservation lifecycle, TTL tracking (see Design Notes: Mediator protocol / topology).
- `apps/playground/backend/src/server.ts` **(MODIFY)** — mount the mediator WS route; harden `GET /api/session` (per-IP rate limit, guest TTL issuance); wire the ledger repo + config (daily ceiling, caps, pricing, thresholds) from env; keep WS-48's demo-config route untouched.
- `apps/playground/backend/src/mediator/__tests__/` **(NEW)** — enforcement tests against a UI-ignoring client (see Tests).
- `apps/playground/frontend/src/session.ts` **(MODIFY)** — point the session controller's WebSocket at the mediator endpoint instead of the runtime `websocketUrl`; parse mediator frames: relay `ChatEvent`s into the existing feed unchanged, route refusal frames to a new handler. The four beats' components are NOT rebuilt.
- `apps/playground/frontend/src/components/RefusalNotice.tsx` **(NEW)** — renders each refusal frame as a typed, human-readable message (SC-09: "typed, rendered").
- `apps/playground/backend/scripts/retention-cleanup.ts` **(NEW)** — the ephemeral-retention job: deletes expired guest-session data from the playground's own isolated database (see Design Notes).
- `apps/playground/Dockerfile` **(NEW)** — builds the playground app (mediator + static frontend) from the monorepo; required because `@swiftagent/playground` depends on private workspace packages and is never published. Serve the built frontend from the mediator process (single deployable).
- `deploy/playground/` **(NEW)** — host config for the playground deployment on the WS-47-chosen host: two services (the playground's isolated runtime via the WS-47 template pattern + the playground app), each pinned to exactly one instance with autoscaling disabled; its own managed Postgres; `migrate` as an explicit release step; secrets documentation.
- `deploy/playground/README.md` **(NEW)** — deployment + guardrail operations doc: credential topology, every cap and its configured value, the provider-side budget cap value, the cheap-model choice and cost rationale, the alert threshold and owner check, the single-instance rationale citing `realtime-operations.md` §6, the observation-based verification procedure and its recorded evidence, TTL/retention configuration.
- `test/smoke/playground-smoke.ts` **(NEW)** — live-URL smoke test (SC-08).
- `README.md`, `docs/quickstart.md`, `docs/vision.md` **(MODIFY)** — the SC-10 pass.
- `.github/workflows/` **(MODIFY only if a deploy/smoke workflow is added)** — optional manual smoke workflow against the live URL; never a checkpoint dependency on external state beyond the deploy this workstream performs.

## Existing Interfaces to Consume

**`RunStatus` + nullable usage** (`packages/shared/src/types/run.ts`) — the exhaustive terminal family the settlement rule quantifies over:

```typescript
export const RunStatusSchema = z.enum(['running', 'completed', 'failed', 'cancelled', 'timed_out']);

export const RunRecordSchema = z.object({
  runId: z.string().startsWith('run_'),
  sessionId: z.string().startsWith('ses_'),
  status: RunStatusSchema,
  model: z.string().min(1),
  tokenUsage: TokenUsageSchema.nullable(),   // observability ONLY — never reduces a charge
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
}).strict();
```

**The under-count evidence** (`packages/runtime/src/loop.ts`) — read-only; why `tokenUsage` cannot settle a charge:

```typescript
case 'finish':
  lastUsage = chunk.usage;      // line 181 — OVERWRITTEN on every provider round
  break;
// ...
await deps.db.runs.complete(ctx.runId, {   // lines 411-415 — persists only the FINAL round
  inputTokens: lastUsage.inputTokens ?? 0,
  outputTokens: lastUsage.outputTokens ?? 0,
  totalTokens: lastUsage.totalTokens ?? 0,
});
```

**`ControlPlaneClient`** (`packages/sdk/src/client.ts`) — the public surface the mediator composes:

```typescript
async createSession(body: CreateSessionBody): Promise<CreateSessionResult>; // → sessionId, clientToken, websocketUrl
async createRun(sessionId: string, body: CreateRunBody): Promise<AcceptedRun>;
async getRun(runId: string): Promise<RunRecord>;      // GET /v1/runs/:runId — observability read
async cancelRun(runId: string): Promise<AcceptedRun>; // POST /v1/runs/:runId/cancel — cap-breach stop
```

**Provider-key path** (`apps/server/src/config.ts:92-101`, `apps/server/src/container.ts:129-152`) — the ONLY place the dedicated provider key is configured (the playground runtime's environment); excerpt of the registration the key flows into:

```typescript
if (config[ENV_KEYS.ANTHROPIC_API_KEY]) {
  modelRegistry.register('anthropic', createAnthropicProvider, {
    apiKey: config[ENV_KEYS.ANTHROPIC_API_KEY] as string,
  });
}
```

**Repository-factory convention** (`packages/db/src/repositories/run-repo.ts`) — the shape `createPlaygroundSpendRepo` must follow: `createXxxRepo(db: Db)` returning an object of async methods; `complete(runId, tokenUsage)` persists usage while `fail`/`cancel`/`timeout` write status only.

**The smoke pattern** (`test/smoke/realtime-smoke.ts`) — bounded connect/wait/overall budgets, limited retries, fatal-auth fast-fail, `ChatEventSchema` validation, diagnostics on failure — mirror it for `playground-smoke.ts`.

## Design Notes

### Mediator topology — proxy, not gatekeeper-then-bypass

Browser-side controls are presentation, never enforcement: a visitor can bypass anything the client decides. If the browser connected directly to the runtime's WebSocket (WS-48's local topology), the mediator could not enforce a message cap on frames it never sees. Therefore the deployed topology **proxies the stream**:

```
browser ──HTTP──► mediator: POST /playground/session       (per-IP rate limit; mints guest session upstream)
browser ──WS────► mediator: /playground/stream?gid=<guest>  (the ONLY socket the browser holds)
                     │  enforces: per-session rate limit, message cap, token cap, TTL, daily ceiling
                     └──WS──► playground runtime: wss://…/v1/stream?token=<jwt>   (server-side only)
```

- The mediator holds the **runtime workspace API key** (env) and uses `ControlPlaneClient` to mint guest sessions. The `clientToken`/`websocketUrl` returned by `POST /v1/sessions` are **kept server-side**, keyed by an opaque random guest id (`nanoid`) the browser gets instead. The browser holds **no credential of any kind** — not the workspace key, not the client JWT, not any provider key.
- On the browser's WS connect, the mediator opens the upstream socket itself and relays: upstream `ChatEvent` frames are forwarded **verbatim** (byte-for-byte JSON, so WS-48's Beat 1 raw feed stays real), and the mediator's own frames are interleaved beside them.
- Inbound, the mediator accepts only its own protocol's `send` frame; every accepted message is forwarded upstream as the gateway's `{ type: 'send_message', content }`. Anything unparseable gets a `refusal` with reason `bad_frame` — never a dropped socket.
- The **dedicated provider key** is configured only as environment on the playground's isolated runtime deployment (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GOOGLE_API_KEY` via the standard `apps/server` config path). The mediator never sees provider traffic; there is **no provider proxy**, and no runtime feature is added.
- The mediator runs inside the existing playground backend process (one deployable, which also serves the built frontend). Per-IP/per-session **rate-limit and cap counters may be in-memory**: the deployment is pinned to one instance, and a restart resetting them is acceptable because the Postgres ledger — not these counters — is what holds the daily ceiling (runbook §1 is exactly why the *ledger* must not be in-memory).
- Token-cap accounting operates on what the mediator can observe: input tokens are bounded by an enforced per-message length cap; output tokens are estimated from relayed `token` frame text (chars/4, rounded up — conservative direction is fine because enforcement caps are demo policy, while *billing* safety comes from the reservation, not this estimate). On breach, the mediator sends the refusal frame **and** calls `cancelRun` upstream so the run terminates (`cancelled` — which settles at full reservation like everything else).

### Mediator protocol — the frame shapes it must define

The protocol is the mediator's OWN, defined as Zod schemas in `apps/playground/backend/src/mediator/protocol.ts` (Zod as source of truth per CLAUDE.md; the frontend imports the inferred types through the package's own module, not through any `@swiftagent` package). It is deliberately disjoint from `ChatEvent` — relayed `ChatEvent`s pass through untouched, and mediator frames are distinguishable by their `type` values, which must not collide with the six `ChatEvent` types. Required shapes (field names may be refined; the frame roster and per-limit reason coverage may not):

```typescript
// server → browser
type MediatorFrame =
  | { type: 'session_ready'; guestId: string; sessionId: string; expiresAt: string;
      limits: { messagesPerSession: number; tokensPerSession: number; messageMaxChars: number } }
  | ChatEvent                                    // relayed verbatim from the runtime
  | { type: 'refusal'; reason: RefusalReason; message: string;      // human-readable, rendered
      retryAfterSeconds?: number; remaining?: { messages?: number; tokens?: number } };

type RefusalReason =
  | 'rate_limit_ip'        // per-IP rate limit (also used as HTTP 429 body on /playground/session)
  | 'rate_limit_session'   // per-session rate limit
  | 'message_cap'          // per-session message cap reached
  | 'token_cap'            // per-session token cap reached (run cancelled upstream)
  | 'daily_ceiling'        // global daily spend ledger refused the reservation
  | 'session_expired'      // guest TTL elapsed
  | 'bad_frame';           // unparseable/unknown inbound frame

// browser → mediator
type MediatorInbound = { type: 'send'; content: string };
```

Every enforced limit has exactly one defined `RefusalReason`, every refusal is delivered as this typed frame over the open WebSocket (the socket stays open except on `session_expired`, which may close AFTER the frame is delivered), and there is a test per limit. Refusals are never: a new `ChatEvent` variant, an unhandled error, a 500, or a silently dropped socket.

### Ledger schema sketch (Postgres, owned here)

Two tables in `packages/db/src/schema/playground-spend.ts` (Drizzle; forward-only migration generated into `packages/db/drizzle/`):

```typescript
// One row per UTC day: the atomic ceiling gate. Only ever increments.
export const playgroundSpendDays = pgTable('playground_spend_days', {
  day: date('day').primaryKey(),                                  // UTC date
  reservedTotalMicroUsd: bigint('reserved_total_micro_usd', { mode: 'number' })
    .notNull().default(0),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// One row per reservation: the audit trail + settlement/sweep state.
export const playgroundSpendReservations = pgTable('playground_spend_reservations', {
  reservationId: text('reservation_id').primaryKey(),             // 'psr_' + nanoid
  day: date('day').notNull(),
  sessionId: text('session_id').notNull(),                        // ses_… (guest session)
  runId: text('run_id'),                                          // run_… once known; null if run creation failed
  reservedMicroUsd: bigint('reserved_micro_usd', { mode: 'number' }).notNull(),
  status: text('status', { enum: ['reserved', 'settled'] }).notNull().default('reserved'),
  terminalStatus: text('terminal_status'),                        // completed|failed|cancelled|timed_out|abandoned
  observedInputTokens: integer('observed_input_tokens'),          // observability ONLY
  observedOutputTokens: integer('observed_output_tokens'),        // observability ONLY
  createdAt: timestamp('created_at').notNull().defaultNow(),
  settledAt: timestamp('settled_at'),
});
```

Amounts are integer micro-USD (no floats in money paths). Because settlement is always at the full reserved amount, **the day counter never decrements and settlement never touches it** — settlement is bookkeeping on the reservation row only. The ceiling can stop the demo early; it can never be exceeded while the ledger reports compliance. Note the consequence of owning the schema in `packages/db`: the tables ride the single forward-only migration chain and will exist (empty, unused) in every environment's database — accepted and harmless; the alternative (a second migration system inside the playground) would violate the migrations runbook's single-schema-path principle.

### Reserve/settle flow

```
send accepted by all caps
  └─ tx: UPSERT day row;
         UPDATE playground_spend_days
            SET reserved_total_micro_usd = reserved_total_micro_usd + $amount
          WHERE day = $today AND reserved_total_micro_usd + $amount <= $dailyCeiling
          RETURNING …;                       -- 0 rows → REFUSE ('daily_ceiling'), nothing inserted
         INSERT reservation (status 'reserved');
  └─ forward message upstream; learn runId from the message_started/run events (or createRun); attach to reservation
run reaches ANY terminal status (completed | failed | cancelled | timed_out)
  └─ settle: status='settled', terminalStatus, settledAt=now, observed usage from GET /v1/runs/:runId if present
     — ALWAYS at the FULL reserved amount; observed usage is recorded but never adjusts anything
reservation still 'reserved' after ABANDON_TIMEOUT (run never observed terminal, or runId never learned)
  └─ sweepAbandoned(): status='settled', terminalStatus='abandoned' — the charge stands in full
```

The atomic conditional `UPDATE` is the concurrency guard: two concurrent sessions racing the ceiling serialize on the day row, so the sum of accepted reservations can never exceed the ceiling (SC-09 "concurrent sessions cannot race past the ceiling"). `$amount` is the conservative per-run maximum: `reservedMicroUsd = ceil((maxInputTokensPerRun × inputPrice) + (maxOutputTokensPerRun × outputPrice))`, where the token bounds derive from the mediator's OWN enforced caps (message length cap → input bound; the agent's `modelConfig.maxTokens` × the runtime's max tool iterations + relayed-context allowance → output bound) and the configured cheap model's published per-token pricing. The formula, its inputs, and the resulting per-run reservation value are documented with concrete numbers in `deploy/playground/README.md`. The sweep runs on an interval inside the mediator process and once at startup (restart-safe: the ledger is in Postgres, so a restart mid-run leaves a 'reserved' row the sweep settles).

### Guest TTL and ephemeral retention

- **TTL:** each guest session carries `expiresAt = mintedAt + TTL` (short — minutes, configurable). The mediator refuses post-expiry sends with `session_expired` and closes the socket after delivering the frame. TTL state is mediator-tracked (in-memory map + the mint timestamp; restart resets are acceptable — an orphaned session just re-mints).
- **Retention:** the deployed playground keeps no durable visitor data beyond operations needs. `retention-cleanup.ts` runs on a schedule (host scheduler or an in-process interval) against the playground's **own isolated database**, deleting sessions/messages/runs/tool-calls/traces older than the configured retention window (hours), plus settled ledger reservations older than an audit window (days; day totals are kept). This is **deployment configuration** — pure SQL against the isolated DB — not a runtime retention mode, which is explicitly out of scope.

### Deployment

Two host services on the WS-47-chosen target, both pinned to exactly one instance with autoscaling disabled:

1. **The playground runtime** — the WS-50 GHCR image deployed per the WS-47 template pattern (registry credentials documented until the owner's visibility click), with its **own managed Postgres** (and Redis if the template wires it), its own secrets (`SWIFT_AGENT`-side: DB URL, `CLIENT_JWT_SECRET`, runner keys, `PUBLIC_WEBSOCKET_URL` as a real `wss://`), and the **dedicated provider key** in its environment only. `migrate` runs as an explicit release step (forward-only; drift preflight).
2. **The playground app** — built by `apps/playground/Dockerfile` from the monorepo (it depends on private workspace packages `@swiftagent/db` etc., all declared in `package.json` — see the workspace-deps memory note), serving the mediator API/WS and the static frontend.

Everything is isolated from dev/staging/prod: separate host app(s), separate database, separate secrets, no shared infrastructure with `infra/`. **Single-instance verification is by observation, not configuration** (SC-12): expose the serving instance's identity (hostname/machine id) on the mediator's health endpoint; during (a) a rolling deploy and (b) a forced restart, poll it continuously and confirm at most one identity serves at any moment and exactly one serves steady-state (host CLI instance listings corroborate). Record the procedure and its captured evidence in `deploy/playground/README.md`, citing runbook §6 for the rationale.

### Cheap model, provider-side cap, alerting

- **Cheap default model:** the playground agent's `modelConfig.model` is pinned to a deliberately cheap model of the chosen provider; the choice, its per-token pricing, and the resulting worst-case per-run cost (= the reservation) are recorded in `deploy/playground/README.md`. Minimising blast radius before any limiter fires is the point.
- **Provider-side budget cap:** the dedicated key used ONLY by the playground carries a hard budget cap configured in the provider's console — the backstop that holds even if the application limiter has a bug, is bypassed, or is misconfigured. It is a required **manual setup step**, documented with its configured value.
- **Alerting:** when a reservation pushes the day total past a configurable fraction of the ceiling (default 50%), the mediator emits a structured warning log (once per day per threshold) and, where the host supports log-based alerts, the alert rule is configured and documented; additionally a **documented owner check** (a ready-to-run SQL query against the ledger, in the README) covers hosts without alerting. The owner learns about unusual spend from a notification, not an invoice.

### The three program-final passes

- **SC-10 documentation pass:** `README.md` links the live playground URL and the WS-47 deploy button as working commands; the quickstart is `npx create-swift-agent <name>` plus `@swiftagent/*` installs, written for the **released state** (decision 4), consistent with the WS-44 release runbook that documents the owner's single `workflow_dispatch` trigger and npm org/token prerequisite; **no surface claims a version already exists on the registry** (no hardcoded version badges, no "available on npm today" phrasing — the runbook makes the one remaining action visible); `docs/quickstart.md` matches; `docs/vision.md` ladder statuses reflect the same released-state framing (playground rung live, one-click rung built, local rung repaired).
- **SC-11 terminal sweep:** re-run the repository-wide active posture search over the tree as it exists NOW (with both program-created packages): search for `npm.pkg.github.com`, `restricted`, `UNLICENSED`, and audit every workspace `package.json` — exactly four public-postured packages (`@swiftagent/{sdk,react,shared}`, `create-swift-agent`: `publishConfig.registry = https://registry.npmjs.org`, `access: public`, Apache-2.0, no `private` field) and exactly ten `"private": true` packages (`@swiftagent/{api,db,gateway,models,observability,runtime,server}`, the two quickstart example packages, `@swiftagent/playground`). No **active** normative, functional, or shipped-documentation surface contradicts either; historical records (superseded plans, task specs, as-built snapshots) are preserved unchanged. Record the search commands and results as checkpoint evidence (PR description).
- **SC-17 gate re-proof:** at least three consecutive full runs of EACH of `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` with the turbo cache bypassed (`--force` / `TURBO_FORCE=true`, per the convention WS-51 established), all green, with every program package and test in the tree. A single green run does not satisfy this.

## Out of Scope (restated exclusions — MUST NOT)

1. **Building the playground UI or its tools** — owned by WS-48. This workstream rewires transport, adds refusal rendering, and hardens the backend; it does not rebuild beats or tools.
2. **Authoring the deploy template** — owned by WS-47; this workstream consumes it.
3. **Runtime-level retention modes** (`retention: none | metadata | full`) — deliberately out of program scope; guardrails here are deployment configuration only.
4. **Scaling the playground beyond one instance for load** — the correct response to load is tighter caps, not more instances.
5. **Authentication, signup, or per-user accounts** — the playground stays anonymous.
6. **Analytics, telemetry, or usage dashboards.**
7. **Bring-your-own-key mode for visitors** — a viable later fallback, out of scope here; the playground must stay a zero-friction 60-second demo.
8. **Claiming in any documentation surface that a version of any package already exists on the public registry** before the owner fires the release — docs are written for the released state per decision 4, with the release runbook making the one remaining action visible.
9. **Enforcing any limit in the browser and counting it as enforcement** — browser-side controls are presentation only.
10. **Owning or proxying the model-provider credential in the mediator** — the credential lives only in the playground runtime's environment; routing provider traffic through the mediator would require a provider-proxy runtime feature or embedding the private server package, both forbidden.
11. (Program-wide) No runtime, SDK, or react feature work; no changes under `infra/`; no pressing the npm release trigger; no performing, waiting on, or asserting the GHCR visibility click.

## Implementation Steps

1. **Ledger in `packages/db`.** Add `schema/playground-spend.ts` (two tables per the sketch), export from the schema barrel, build, generate the forward-only migration (`db:generate` — never hand-edit prior migrations), and implement `createPlaygroundSpendRepo(db)` with `reserve(day, amountMicroUsd, ceilingMicroUsd)` (the atomic conditional-update transaction; returns the reservation or a typed refusal result), `attachRun(reservationId, runId)`, `settle(reservationId, terminalStatus, observedUsage?)`, `sweepAbandoned(olderThanMs)`, and `dayTotal(day)`. Export from the repo barrel and package index.
2. **Mediator protocol + enforcement.** In `apps/playground/backend/src/mediator/`: define the Zod protocol (`protocol.ts` — frames and reasons per Design Notes); implement the session mint route (`POST /playground/session` behind the per-IP limiter; mints upstream via `ControlPlaneClient`; stores `{clientToken, websocketUrl, sessionId, expiresAt}` server-side keyed by guest id; returns `session_ready` data with the limits); implement the WS route (`/playground/stream`): upstream connect, verbatim `ChatEvent` relay, inbound `send` handling through the enforcement chain (TTL → per-session rate limit → message cap + length cap → token cap → ledger `reserve`), refusal frames per limit, `cancelRun` on token-cap breach, reservation attach/settle driven by observed terminal events plus a `getRun` confirmation, and the abandoned-reservation sweep (startup + interval).
3. **Frontend rewiring.** Update `frontend/src/session.ts` to connect to the mediator endpoint (no upstream `websocketUrl`/token ever reaches the browser), split incoming frames (ChatEvent → existing feed unchanged; mediator frames → refusal/session handlers), and add `RefusalNotice` rendering each refusal reason as a typed, human-readable message. Verify the four beats still work end-to-end through the proxy (raw feed, callId/duration correlation, drop/recover — recovery now constructs a new mediator socket for the same guest session, which the mediator re-attaches upstream against the same runtime session id).
4. **TTL + retention.** Implement guest-TTL tracking and the `session_expired` path; write `scripts/retention-cleanup.ts` (SQL deletes against the playground DB for expired sessions' data + old settled reservations) and schedule it; make both windows env-configurable and documented.
5. **Local verification.** Run the full guarded stack locally against the WS-43 compose stack (mediator → local runtime) and drive every limit to its refusal with a raw WS client. All four gate commands green.
6. **Deploy.** Author `apps/playground/Dockerfile` and `deploy/playground/` per the WS-47 template pattern: provision the isolated playground runtime (WS-50 image, own Postgres, own secrets, dedicated provider key in env, `migrate` release step) and the playground app service; pin BOTH to exactly one instance with autoscaling disabled. Configure the dedicated provider key's **provider-side budget cap** (manual step — perform it, record the value), the cheap default model, the daily ceiling, caps, TTL, retention, and the alert threshold.
7. **Observe single-instance behaviour (SC-12).** Execute the observation procedure across a rolling deploy and a restart; capture the evidence; write it up in `deploy/playground/README.md` with the runbook-§6 rationale.
8. **Live smoke (SC-08).** Write `test/smoke/playground-smoke.ts` on the `realtime-smoke.ts` pattern: mint a guest session via the LIVE mediator, connect the mediator WS, send a prompt that exercises a real tool, assert `message_started → token → tool_call_started → tool_call_completed → message_completed` (validating relayed frames against `ChatEventSchema` and computing the duration from the pair), bounded and diagnostic. Run it against the deployed URL and record the pass.
9. **SC-10 documentation pass.** Update `README.md`, `docs/quickstart.md`, `docs/vision.md` per Design Notes; cross-check against the WS-44 release runbook for consistency; sweep for any version-already-published claim.
10. **SC-11 terminal sweep.** Run the repository-wide posture search; fix any contradiction found (that fix is in-scope precisely because this sweep exists); record commands + results as checkpoint evidence.
11. **SC-17 re-proof.** ≥3 consecutive cache-bypassed green runs of each of the four gate commands; record the runs as checkpoint evidence.

## Tests

> Enforcement tests drive the mediator with a **raw WebSocket/HTTP client that ignores the UI entirely** (the SC-09 requirement) — no frontend code in the loop. The runtime side is faked with a stub upstream WS server emitting scripted `ChatEvent` sequences (unit path); ledger tests use Testcontainers Postgres (integration path, matching `packages/db`'s existing suites). The live-URL smoke is a script, not a vitest suite, mirroring `realtime-smoke.ts`.

**`packages/db/src/__tests__/playground-spend-repo.test.ts`:**

1. **Atomic ceiling.** Concurrent `reserve` calls (Promise.all) against a ceiling admit only combinations whose sum ≤ ceiling; the day total equals the sum of admitted reservations exactly; a refused reserve inserts nothing.
2. **Full-reservation settlement, all outcomes.** `settle` with each of `completed`, `failed`, `cancelled`, `timed_out` (and sweep-`abandoned`) marks the row settled without changing the day total; observed usage is stored but adjusts nothing; a reservation is never released below its reserved amount (no decrement API exists — assert the day total after settle equals the total after reserve).
3. **Restart survival.** Reservations and day totals written through one client are read back through a fresh client (Postgres persistence, not memory); `sweepAbandoned` settles only rows older than the threshold and is idempotent.
4. **Day boundary.** Reservations on different UTC days accrue to different day rows; a new day starts from zero against the same ceiling.

**`apps/playground/backend/src/mediator/__tests__/enforcement.test.ts`** (one test per limit, per SC-09):

5. **Per-IP rate limit.** A burst of `POST /playground/session` from one IP beyond the limit is refused with the typed `rate_limit_ip` refusal (429 body of the same shape); a different IP is unaffected.
6. **Per-session rate limit.** A UI-ignoring WS client sending `send` frames faster than the limit receives `refusal { reason: 'rate_limit_session', retryAfterSeconds }`; the socket stays open; compliant pacing resumes service.
7. **Message cap.** The (cap+1)-th message on a session yields `refusal { reason: 'message_cap' }` and is NOT forwarded upstream (assert the stub upstream saw exactly cap messages).
8. **Token cap.** With the stub upstream streaming token frames past the cap, the client receives `refusal { reason: 'token_cap' }` and the mediator calls `cancelRun` upstream (spy).
9. **Daily ceiling.** With the ledger primed near the ceiling, the next `send` yields `refusal { reason: 'daily_ceiling' }` before any upstream forward and no reservation row is inserted.
10. **TTL.** A `send` after `expiresAt` yields `refusal { reason: 'session_expired' }` delivered BEFORE any close.
11. **Refusals are typed frames, not failures.** Every refusal above parses against the mediator protocol schema, is not a member of `ChatEventSchema`, and no case produces an unhandled error, a 500, or a socket drop without a frame; an unparseable inbound frame gets `bad_frame`.

**`apps/playground/backend/src/mediator/__tests__/relay.test.ts`:**

12. **Verbatim relay.** A scripted upstream `message_started → token → tool_call_started → tool_call_completed → message_completed` sequence arrives at the browser client byte-identical (JSON-equal) and in order, interleaved correctly with mediator frames.
13. **Credential-free browser.** The `session_ready` payload and every mediator frame contain no workspace API key, no `clientToken`, no upstream `websocketUrl`, and no provider key (assert on serialized frames).
14. **Reservation lifecycle.** An accepted send reserves before upstream forward; a terminal event (each of the four statuses, scripted) settles at full; an upstream that never terminates leaves a `reserved` row the sweep settles as `abandoned`.

**`apps/playground/frontend/src/__tests__/refusal.test.tsx`:**

15. **Refusals render.** Each `RefusalReason` renders a distinct human-readable notice; relayed `ChatEvent`s still flow to the WS-48 feed untouched (beats unbroken).

**`test/smoke/playground-smoke.ts`** (live URL, run at deploy time and on demand):

16. **SC-08 assertion.** Against the public URL: guest session mints with no credential supplied, the stream delivers tokens and at least one `tool_call_started`/`tool_call_completed` pair with a computable duration, all frames valid, bounded with diagnostics on failure.

## Acceptance Criteria

1. A trusted server-side mediator is the **sole** enforcement point between the browser and the playground's runtime: it holds the runtime workspace API key; the browser receives no credential of any kind (no workspace key, no client JWT, no upstream URL, no provider key); the dedicated provider key is configured only as environment on the playground's isolated runtime deployment via the standard `apps/server` config path; no provider proxy exists and no runtime/SDK/react surface was added or modified (SC-09).
2. Per-IP and per-session rate limits, a per-session message cap, and a per-session token cap are enforced in the mediator and proven by tests driving a client that ignores the UI; browser-side controls play no enforcement role (SC-09).
3. Every limit produces its defined refusal frame — a typed, rendered message of the mediator's own app-level protocol over the WebSocket — with one test per limit; no refusal is a new `ChatEvent` variant, an unhandled error, a 500, or a dropped socket (SC-09).
4. Spend accounting is atomic reserve-then-settle against a global daily ledger **persisted in Postgres** whose schema and forward-only migration this workstream added in `packages/db` (generated, never hand-edited; applied via the standard `migrate` release step): reservations are a conservative per-run maximum derived from the mediator's own caps and the cheap model's pricing with the formula and values documented; concurrent sessions cannot race past the ceiling; **every reservation settles at its full reserved amount** for all four terminal statuses and, after a timeout, for abandoned never-terminal runs; `RunRecord.tokenUsage` is recorded as observability only and never reduces a charge; `packages/runtime/src/loop.ts` is untouched (SC-09).
5. The deployed instance uses a dedicated provider key used only by the playground, carrying a provider-side budget cap documented as a required manual setup step **with its configured value**; the default model is deliberately cheap with the choice and cost rationale recorded; an alert (or documented, ready-to-run owner check) fires at a documented fraction of the daily ceiling (SC-09).
6. Guest sessions carry a short TTL (post-expiry sends refused with the typed frame) and the deployment runs a documented ephemeral-retention cleanup against its own isolated database; no runtime retention mode was added (SC-09; excludes 3).
7. `apps/playground` is deployed to the WS-47 host target with its own database and secrets, isolated from dev/staging/prod, with migrations as an explicit release step; the deployment pins to exactly one instance with autoscaling disabled, **verified by observation across a rolling deployment and a restart** with the evidence and the runbook-§6 rationale recorded in the deployment docs (SC-12).
8. `test/smoke/playground-smoke.ts` passes against the live public URL, asserting a streaming turn with a visible tool call (start, completion, and a computable duration), bounded and diagnostic on the `realtime-smoke.ts` pattern (SC-08).
9. The SC-10 pass is complete: README links the live playground and the deploy button as working commands; `npx create-swift-agent` and the `@swiftagent/*` installs are the documented quickstart for the released state (decision 4), consistent with the WS-44 release runbook's single documented trigger; no surface claims a version already exists on the registry (no hardcoded published-version badges); `docs/vision.md` ladder statuses match; the pass ran only after WS-46 landed (SC-10).
10. The terminal-tree posture sweep is re-run and recorded: exactly four public-postured packages and exactly ten `"private": true` packages, no active surface asserting or enforcing a private/restricted posture for the public packages' consumer path, historical records preserved unchanged (SC-11).
11. The program-final gate re-proof is recorded: at least three consecutive cache-bypassed green runs of each of `pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm test`, with every program-created package and test in the tree (SC-17).
12. All restated exclusions hold: no WS-48 UI/tool rebuilding, no WS-47 template authoring, no scaling beyond one instance, no auth/signup/accounts, no analytics/telemetry, no visitor bring-your-own-key, no browser-side enforcement counted as enforcement, no mediator-owned provider credential, no npm-publish claim or trigger press, no `infra/` change, no GHCR-click dependency.
