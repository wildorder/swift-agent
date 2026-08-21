# WS-35: Deployment Verification: Realtime Smoke Tests

## Goal

Prove — on every deploy, in every environment — that the **realtime path actually works end-to-end in the cloud**, not just that `/health` returns 200. This workstream does **three** things and nothing more: (1) it authors a **deployed WebSocket smoke test** (a standalone Node/TS script) that, against a deployed base URL + a smoke API key, calls `POST /v1/sessions` (API-key auth) → connects to the returned `websocketUrl` (canonical `wss://<host>/v1/stream?token=<jwt>`) → sends `{ type: "send_message", content }` → asserts the `ChatEvent` stream (`message_started` → `token`(s) → `message_completed`), exiting non-zero with captured diagnostics on any failure (SC-10); (2) it **wires that script into all three deploy workflows** (`deploy-dev.yml`, `deploy-staging.yml`, `deploy-prod.yml`) as a step that runs *after* service stability and *after* the existing `/health` smoke, so a realtime-smoke failure **blocks the deploy** (SC-10); and (3) it **resolves the staging/production Docker build inconsistencies** so all three environments build and push from an identical image path (SC-11). **Scope: the smoke script, its deploy-blocking wiring, and the Docker build normalization — nothing else.** The unified server merge (WS-30), ALB/ECS single-port/drain infra and the stale-`3001`-`EXPOSE` removal (WS-31), per-env `websocketUrl` SSM/env config (WS-32), Redis/health/ops docs (WS-33), and the client SDK + developer quickstart (WS-34) are **consumed as dependencies, not authored here**.

## Traceability

- **SC-10** — A deployed WebSocket smoke test exercises session-create → connect → auth → event stream, and its failure blocks the deploy in dev, staging, and production.
- **SC-11** — Staging/production Docker build inconsistencies resolved so all environments build/deploy from an identical image path.
- **SC-12** — Workflows lint clean (`actionlint`); the smoke script typechecks and lints.

## Dependencies

- **WS-30 (unified server)** — merges REST (`@swiftagent/api`) and WebSocket (`@swiftagent/gateway`) into a single Fastify process so REST and WS are served together. Until this lands, `POST /v1/sessions` and `/v1/stream` are not co-served and the smoke test cannot connect through one host.
- **WS-31 (deployed single-port routing)** — AD-01/AD-02: one ALB target on **port 3000**, the WS reachable through the ALB at `/v1/stream`, `desired_count=1`. **This workstream's smoke test cannot pass until the WS is reachable through the ALB.** WS-31 also removes the stale `3001` `EXPOSE` from `apps/server/Dockerfile` — **this workstream MUST NOT touch that line** (do not duplicate or conflict with WS-31's Dockerfile edit).
- **WS-32 (per-env `websocketUrl`)** — makes `POST /v1/sessions` return a correct per-env `websocketUrl` (`publicWebsocketUrl` wired from SSM/env so dev returns the ALB DNS, staging `wss://staging-api.swiftagent.dev/v1/stream`, prod `wss://api.swiftagent.dev/v1/stream`). The smoke test **consumes** `websocketUrl` verbatim from the response, so it inherits WS-32's correctness. Confirm the `websocketUrl` in a live `POST /v1/sessions` response points at the canonical `/v1/stream` path before relying on it.

**The build agent MUST confirm WS-30/31/32 have landed (unified server deployed, WS reachable via ALB on 3000, `websocketUrl` correct per-env) before expecting the smoke step to go green.** The script and wiring can be authored ahead of those, but a green run requires them.

## Context Files (Agent MUST read before implementing)

- `c:\dev\swift-agent\CLAUDE.md` — conventions (Node 22, TS strict, ESM `"type": "module"`, pnpm workspaces + Turborepo, Zod source-of-truth, `@swiftagent/*` scoping, `ENV_KEYS` single source of truth, ID prefixes incl. `ses_`/`ak_`).
- `c:\dev\swift-agent\.github\workflows\deploy-dev.yml`, `deploy-staging.yml`, `deploy-prod.yml` — **READ ALL THREE.** Each has: an ECR `Build and push Docker image` step, a `Wait for ECS service stability` step (`aws ecs wait services-stable`), a `Run database migration` step, and a `Smoke test` step that **only curls `/health`** and asserts `.status == "ok"`. The new realtime-smoke step lands **after** the existing `/health` smoke. Note how the base URL is obtained per env: **dev** derives an ALB DNS name via `terraform output -raw alb_dns_name` (exposed as `steps.tf-outputs.outputs.alb_dns_name` / `health_url`); **staging** hardcodes `https://staging-api.swiftagent.dev`; **prod** hardcodes `https://api.swiftagent.dev`. The build+push steps differ between dev and staging/prod — see *Existing Interfaces to Consume* (this is the SC-11 drift).
- `c:\dev\swift-agent\apps\server\Dockerfile` — the **only** Dockerfile in the repo (there is NO root `./Dockerfile`). Two-stage build: `builder` (`node:22-alpine`, `pnpm turbo run build --filter=@swiftagent/server...`) → `runner` (`node:22-alpine`, `pnpm install --prod`, `ENV NODE_ENV=production`, non-root `swiftagent` user, `WORKDIR /app`, `CMD ["node","apps/server/dist/main.js"]`). It has **no build args and no per-env `--target`** — the image is environment-agnostic; env differentiation is entirely runtime (SSM/task-def). This is the key fact for SC-11: staging/prod's `docker build -t ... .` **omits `-f apps/server/Dockerfile`**, so it has no Dockerfile to build from at the context root. (WS-31 owns the `EXPOSE 3000 3001` → `EXPOSE 3000` fix; leave it alone.)
- `c:\dev\swift-agent\.github\workflows\ci.yml` — how CI jobs are structured: `NODE_VERSION: '22'`, `PNPM_VERSION: '9.15.4'` at the workflow `env` level; `pnpm/action-setup@v4` + `actions/setup-node@v4` with `cache: pnpm`; `pnpm install --frozen-lockfile`; `pnpm build`. There is **no existing smoke script** under `scripts/`, `test/smoke/`, or `infra/` (confirmed absent). The smoke script is NEW.
- `c:\dev\swift-agent\packages\api\src\routes\sessions.ts` — `POST /sessions` (mounted under `/v1`) requires API-key auth (`workspaceId` on the authenticated request), accepts `CreateSessionBodySchema` (`agentName`, optional `userId`, `metadata`), and returns **`{ sessionId, clientToken, websocketUrl }`** with `websocketUrl = \`${publicWebsocketUrl}?token=${clientToken}\``. **The smoke test consumes `sessionId` + `websocketUrl` from this exact 201 response shape.**
- `c:\dev\swift-agent\packages\gateway\src\server.ts` — the WS handshake: connect to `/v1/stream?token=<jwt>`; a missing/invalid token yields an `error` frame + close (`4001`/`4002`/`4003`). On success, inbound `{ type: "send_message", content }` triggers a run; inbound `{ type: "ping" }` → `{ type: "pong" }`. The gateway broadcasts the `ChatEvent` stream.
- `c:\dev\swift-agent\packages\shared\src\types\events.ts` — the `ChatEvent` discriminated union the smoke test asserts against: `message_started { messageId, runId, sessionId }` → `token { messageId, runId, sessionId, text }`(s) → `message_completed { messageId, runId, sessionId }`; failure surfaces as `run_failed { runId, sessionId, code, message }`. Reuse `ChatEventSchema` to validate frames rather than hand-rolling shape checks.
- `c:\dev\swift-agent\test\support\ws-client.ts` — an existing promise-based WS helper (`connectWs(url)` → `WsClient` with `waitForType(type, timeoutMs)`, `framesOfType(type)`, bounded `waitFor`, `close()`). **Reuse this** rather than writing a new socket wrapper — it already buffers frames and fails fast on timeout. It imports `ws`.

## Package

`.github/workflows`, `apps/server` (Dockerfile — build path only; not the `EXPOSE` line), `test/smoke` **or** `scripts/` (the smoke script).

## Files Touched

- `test/smoke/realtime-smoke.ts` **(NEW)** — the deployed WebSocket smoke script. Standalone, run via `tsx`/`node`. Reads a base URL + smoke API key from env, runs the session→connect→send→assert flow, exits `0` on the expected event sequence and non-zero (with captured diagnostics) on any failure, bounded by a hard timeout + limited retries. (Placement under `test/smoke/` mirrors the existing `test/` tree; if the agent prefers `scripts/smoke/realtime-smoke.ts`, that is acceptable — pick one and be consistent across the three workflows. Note: root `test/` is excluded from `pnpm typecheck`/`lint` per project convention, so if strict typecheck/lint coverage of the script is required by SC-12, place it under `scripts/` and add it to the lint/typecheck globs, or add a dedicated `tsc --noEmit` invocation for it — see Design Notes.)
- `test/smoke/package.json` **(NEW, only if needed)** — a minimal manifest (or a root `pnpm` script entry) so the script's deps (`ws`, `zod` via `@swiftagent/shared`) resolve and it can be invoked as `pnpm smoke:realtime`. Prefer wiring a root `package.json` script over a new workspace package if that keeps the change smaller.
- `.github/workflows/deploy-dev.yml` **(MODIFY)** — add a `Realtime smoke test` step **after** the existing `/health` `Smoke test` step, using the dev ALB DNS base URL (`steps.tf-outputs.outputs.alb_dns_name`). **Also fix the Docker build+push step's ECR path/args** to match the normalized form (SC-11).
- `.github/workflows/deploy-staging.yml` **(MODIFY)** — add the same realtime-smoke step using `https://staging-api.swiftagent.dev`; **fix the `docker build` step to `-f apps/server/Dockerfile` and the normalized ECR repository** (SC-11).
- `.github/workflows/deploy-prod.yml` **(MODIFY)** — add the same realtime-smoke step using `https://api.swiftagent.dev`; **fix the `docker build` step to `-f apps/server/Dockerfile` and the normalized ECR repository** (SC-11).
- `apps/server/Dockerfile` **(DO NOT MODIFY here)** — listed only to state the boundary: this workstream does **not** edit the Dockerfile. The SC-11 fix lives entirely in the workflows' `docker build` invocation (they must point at `apps/server/Dockerfile`, which already exists and is correct). The stale-`EXPOSE` change is WS-31's.

## Existing Interfaces to Consume

**Current `/health`-only smoke step** (`deploy-prod.yml`, `Smoke test`) — the new realtime step lands **after** this; keep this step:

```yaml
      - name: Smoke test
        run: |
          for i in {1..5}; do
            STATUS=$(curl -sf https://api.swiftagent.dev/health | jq -r '.status' 2>/dev/null) && break
            echo "Attempt $i failed, retrying in 10s..."
            sleep 10
          done
          if [ "$STATUS" != "ok" ]; then
            echo "Smoke test failed: expected status 'ok', got '$STATUS'"
            exit 1
          fi
          echo "Smoke test passed"
```

**Dev base-URL derivation** (`deploy-dev.yml`) — dev has no stable hostname; the base URL comes from the ALB DNS output, then `Wait for ECS service stability`:

```yaml
      - name: Get deploy outputs
        id: tf-outputs
        working-directory: infra/envs/dev
        run: |
          ALB_DNS=$(terraform output -raw alb_dns_name)
          echo "alb_dns_name=$ALB_DNS" >> $GITHUB_OUTPUT
          echo "health_url=http://$ALB_DNS/health" >> $GITHUB_OUTPUT

      - name: Wait for ECS service stability
        run: |
          aws ecs wait services-stable \
            --cluster $ECS_CLUSTER \
            --services $ECS_SERVICE
```

> The realtime step goes **after** `Wait for ECS service stability` **and after** the existing `/health` `Smoke test`. For dev it uses `http(s)://${{ steps.tf-outputs.outputs.alb_dns_name }}`; for staging/prod it uses the hardcoded `staging-api.swiftagent.dev` / `api.swiftagent.dev` hosts.

**Docker build+push — the SC-11 drift.** `deploy-dev.yml` is correct; **`deploy-staging.yml` and `deploy-prod.yml` are wrong** (no `-f`, so no Dockerfile at the context root — the only Dockerfile is `apps/server/Dockerfile`), and they use a different `ECR_REPOSITORY`:

```yaml
# deploy-dev.yml  ── env: ECR_REPOSITORY: swiftagent/server ; IMAGE_TAG: dev-${{ github.sha }}
      - name: Build and push Docker image
        id: build
        env:
          ECR_REGISTRY: ${{ steps.ecr-login.outputs.registry }}
          IMAGE_TAG: dev-${{ github.sha }}
        run: |
          docker build -f apps/server/Dockerfile -t $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG .
          docker push $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG
          echo "image_uri=$ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG" >> $GITHUB_OUTPUT
```

```yaml
# deploy-staging.yml  ── env: ECR_REPOSITORY: swiftagent ; IMAGE_TAG: staging-${{ github.sha }}
      - name: Build and push Docker image
        id: build
        env:
          ECR_REGISTRY: ${{ steps.ecr-login.outputs.registry }}
          IMAGE_TAG: staging-${{ github.sha }}
        run: |
          docker build -t $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG .        # ← no -f apps/server/Dockerfile
          docker push $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG
          echo "image_uri=$ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG" >> $GITHUB_OUTPUT
```

```yaml
# deploy-prod.yml  ── env: ECR_REPOSITORY: swiftagent ; IMAGE_TAG: prod-${{ github.sha }}
      - name: Build and push Docker image
        id: build
        env:
          ECR_REGISTRY: ${{ steps.ecr-login.outputs.registry }}
          IMAGE_TAG: prod-${{ github.sha }}
        run: |
          docker build -t $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG .        # ← no -f apps/server/Dockerfile
          docker push $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG
          echo "image_uri=$ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG" >> $GITHUB_OUTPUT
```

**The Dockerfile stages** (`apps/server/Dockerfile`) — environment-agnostic; no build args, no per-env `--target`. Env differentiation is 100% runtime (SSM/task-def), so a single build path is correct for all three envs:

```dockerfile
# ── Stage 1: Builder ────────────────────────────────────────────────
FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app
# ... copy lockfile + package.jsons, pnpm install --frozen-lockfile, COPY . .
RUN pnpm turbo run build --filter=@swiftagent/server...

# ── Stage 2: Runner ─────────────────────────────────────────────────
FROM node:22-alpine AS runner
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app
# ... COPY --from=builder dist outputs, pnpm install --frozen-lockfile --prod
ENV NODE_ENV=production
USER swiftagent
EXPOSE 3000 3001            # ← WS-31 removes the stale 3001; NOT this workstream
HEALTHCHECK ... http://localhost:3000/health ...
CMD ["node", "apps/server/dist/main.js"]
```

**`POST /v1/sessions` response** (`packages/api/src/routes/sessions.ts`) — the smoke test consumes this shape:

```ts
return reply.status(201).send({
  sessionId: session.sessionId,        // ses_...
  clientToken,                         // signed HS256 client JWT
  websocketUrl,                        // `${publicWebsocketUrl}?token=${clientToken}` — canonical /v1/stream (WS-32)
});
```

**The `ChatEvent` sequence to assert** (`packages/shared/src/types/events.ts`) — happy path: `message_started` → one-or-more `token` → `message_completed`; failure: `run_failed`. Validate frames with the exported `ChatEventSchema`.

**Reusable WS client** (`test/support/ws-client.ts`) — `connectWs(url, openTimeoutMs?)` → `WsClient`; use `waitForType('message_started', ms)`, `framesOfType('token')`, `waitForType('message_completed', ms)`, and `close()`. Bounded timeouts already fail fast.

## Design Notes

- **The smoke test is a real client, not a curl.** `/health` proves the process is up; it says nothing about auth, the WS upgrade through the ALB, token validation, or the run pipeline. The realtime smoke exercises the *actual customer path*: authenticated `POST /v1/sessions` → WS upgrade at `/v1/stream?token=` → `send_message` → streamed `ChatEvent`s. This is the only thing that proves AD-01 (unified single-port `wss://<host>/v1/stream`) works in the cloud. It is deliberately the same path WS-34's developer quickstart documents — **WS-34's quickstart is validated against deployed dev by this exact smoke path**, so keep the script's flow copy-pasteably close to the quickstart snippet.
- **Fail loud, never hang — bound everything.** A realtime bug most often manifests as *silence* (socket opens, no events). The script MUST enforce: a connect timeout (reuse `connectWs`'s `openTimeoutMs`), a per-wait timeout on each `waitForType`, an overall wall-clock budget (e.g. 60s) after which it force-exits non-zero, and **limited retries** on the whole flow (e.g. 3 attempts with backoff) to absorb ALB warm-up / task-registration races — but a persistent failure MUST exit non-zero, not loop forever. On failure, print captured diagnostics: HTTP status + body of the `POST /v1/sessions` call, the WS close code/reason, and every frame received so far (`client.frames`). CI must be able to read *why* from the step log.
- **Reuse `ChatEventSchema` and `connectWs` — do not re-implement.** Validate each inbound frame with `ChatEventSchema.safeParse` so a malformed/unknown frame is itself a smoke failure. Use the existing `test/support/ws-client.ts` helper for the socket. Keeping the script thin (consume shared types + the shared helper) is the senior-dev move; a bespoke socket wrapper here would be duplicated state.
- **Smoke credentials are an assumption to be provisioned — flag it, don't invent it.** The test needs (a) a **smoke API key** to auth `POST /v1/sessions`, and (b) a **seeded agent** whose `agentName` the session targets, whose provider returns *some* streamed output deterministically (ideally an echo/stub agent, so `token` frames are guaranteed without real model cost/nondeterminism). **Assumption:** a per-env smoke API key (`SMOKE_API_KEY`) is stored as a GitHub Actions secret (and/or SSM) and a smoke agent (`SMOKE_AGENT_NAME`, default e.g. `smoke-echo`) is seeded in each environment's workspace. The script reads `SMOKE_BASE_URL`, `SMOKE_API_KEY`, `SMOKE_AGENT_NAME` from env. If provisioning the seeded agent is out of this workstream's reach, the minimum bar (per the program's SC-10 "or at minimum a successful authenticated stream") is: session-create + authenticated WS connect + `send_message` accepted without an `error`/`run_failed` frame — but **prefer** asserting the full `message_started`→`token`→`message_completed` sequence and document the seeded-agent dependency explicitly.
- **SC-11 root cause — diagnosed.** The staging/prod `docker build -t ... .` has **no `-f` flag**, so Docker looks for `./Dockerfile` at the build-context root — which **does not exist** (the sole Dockerfile is `apps/server/Dockerfile`). dev alone passes `-f apps/server/Dockerfile`. Additionally, dev pushes to `ECR_REPOSITORY: swiftagent/server` while staging/prod push to `ECR_REPOSITORY: swiftagent` — two different repositories, so the environments do not even share an image namespace. **Normalize both:** every env builds `docker build -f apps/server/Dockerfile -t $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG .` and every env uses the **same** `ECR_REPOSITORY` value. Because the Dockerfile has no build args and no per-env `--target`, an identical build path is provably correct for all three — env differences are runtime-only (SSM/task-def). This mirrors the migrate-path normalization precedent from the persist-observe program (WS-27), where prod/staging vs dev diverged on the `dist/migrate.js` path and were unified to the single correct one. **Only the `docker build` line and `ECR_REPOSITORY` env change; the tag prefix (`dev-`/`staging-`/`prod-`) legitimately stays per-env.** Decide the single canonical `ECR_REPOSITORY` value by checking which repository the ECS task definitions / `image_uri` var actually consume in each env (do not blindly pick one — confirm against `infra/`), and note that a repository rename may require the ECR repo to exist in staging/prod (dev auto-creates it via its `Ensure ECR repository exists` step; staging/prod do not).
- **Do not touch WS-31's territory.** The `EXPOSE 3000 3001` → `EXPOSE 3000` fix and any ALB/target-group/port/drain change belong to WS-31. This workstream's only Dockerfile-adjacent change is the workflows' `-f apps/server/Dockerfile` path. If a merge conflict with WS-31 arises on the Dockerfile, WS-31 wins that line.
- **Typecheck/lint the script (SC-12).** Root `test/` is excluded from `pnpm typecheck`/`lint` by project convention. To satisfy SC-12's "the smoke script typechecks/lints," either place the script under `scripts/` and add it to the lint/typecheck globs, or add a dedicated `tsc --noEmit -p test/smoke/tsconfig.json` + `eslint test/smoke` invocation. State the chosen approach; do not silently leave the script uncovered.

## Implementation Steps

1. **Confirm the dependency surface is live.** Verify WS-30/31/32 have landed: hit a deployed `POST /v1/sessions` (dev) with a smoke API key and confirm the 201 body's `websocketUrl` uses the canonical `/v1/stream?token=` path and the correct per-env host; confirm the WS is reachable through the ALB on port 3000. **If `websocketUrl` is wrong or the WS is unreachable, STOP and report which of WS-30/31/32 is incomplete** — do not author around it.

2. **Author `test/smoke/realtime-smoke.ts` (NEW).** Read `SMOKE_BASE_URL`, `SMOKE_API_KEY`, `SMOKE_AGENT_NAME` (default `smoke-echo`) from env; fail immediately with a clear message if `SMOKE_BASE_URL`/`SMOKE_API_KEY` are unset. The flow, wrapped in a retry loop (≤3 attempts, backoff) and an overall wall-clock budget:
   - `POST ${SMOKE_BASE_URL}/v1/sessions` with header `Authorization`/API-key per the runtime auth convention and body `{ agentName: SMOKE_AGENT_NAME }`. Assert `201` and destructure `{ sessionId, websocketUrl }`; on non-201, print status + body and fail.
   - `connectWs(websocketUrl, openTimeoutMs)` (reuse `test/support/ws-client.ts`). A connect timeout or an immediate `error` frame / close code (`4001`/`4002`/`4003`) is a failure with the close code/reason captured.
   - `client.send({ type: 'send_message', content: 'ping from realtime smoke' })`.
   - `await client.waitForType('message_started', ms)` → assert at least one `token` frame (`await client.waitForType('token', ms)` and/or `client.framesOfType('token').length > 0`) → `await client.waitForType('message_completed', ms)`. Validate each consumed frame with `ChatEventSchema.safeParse`; a `run_failed` frame is an immediate failure (print its `code`/`message`).
   - `await client.close()`; on full success `process.exit(0)`. On any thrown/timeout/failed-assertion after retries exhausted, print diagnostics (POST status+body, WS close code, `client.frames`) and `process.exit(1)`.
   - Keep the minimum-bar fallback documented in a comment: if no seeded streaming agent exists in an env, a successful authenticated connect + accepted `send_message` with no `error`/`run_failed` within the budget is the floor (SC-10 "at minimum a successful authenticated stream") — but the default asserts the full sequence.

3. **Make the script invokable (NEW manifest/script entry).** Add a root `package.json` script `"smoke:realtime": "tsx test/smoke/realtime-smoke.ts"` (or equivalent `node --import tsx`), ensuring `ws` and `@swiftagent/shared` (for `ChatEventSchema`) resolve. Prefer a root script over a new workspace package to keep the change small. Add the SC-12 typecheck/lint coverage for the script per Design Notes (dedicated `tsc --noEmit` + `eslint` on the smoke path, or relocate under `scripts/` and extend the globs).

4. **Wire the realtime-smoke step into `deploy-dev.yml` (MODIFY).** After the existing `/health` `Smoke test` step, add:
   ```yaml
   - name: Realtime smoke test
     # Proves the deployed realtime path end-to-end: POST /v1/sessions (API-key)
     # → WS connect to the returned websocketUrl (/v1/stream?token=) → send_message
     # → assert message_started → token(s) → message_completed. A failure here
     # BLOCKS the deploy. See WS-35 / docs quickstart (WS-34).
     env:
       SMOKE_BASE_URL: http://${{ steps.tf-outputs.outputs.alb_dns_name }}
       SMOKE_API_KEY: ${{ secrets.SMOKE_API_KEY }}
       SMOKE_AGENT_NAME: smoke-echo
     run: pnpm smoke:realtime
   ```
   Ensure the job has Node/pnpm available and the smoke path's deps installed (a `pnpm install --frozen-lockfile` + `pnpm build` before this step if the workflow doesn't already have them — deploy workflows currently only build the Docker image, so add a lightweight `Setup pnpm`/`Setup Node.js`/`Install`/`Build` sequence, or run the script from a container, whichever is smaller). A non-zero exit fails the job (default `run` behavior), blocking the deploy.

5. **Wire the same step into `deploy-staging.yml` and `deploy-prod.yml` (MODIFY).** Identical step, with `SMOKE_BASE_URL: https://staging-api.swiftagent.dev` and `SMOKE_BASE_URL: https://api.swiftagent.dev` respectively, placed after each file's existing `/health` `Smoke test` step and after `Wait for ECS service stability`. Use each env's `SMOKE_API_KEY` secret (environment-scoped). For prod, place it before the `Tag image with release version` step so a realtime failure blocks the release tag.

6. **Normalize the Docker build+push (SC-11) across all three workflows (MODIFY).**
   - In `deploy-staging.yml` and `deploy-prod.yml`, change `docker build -t $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG .` → `docker build -f apps/server/Dockerfile -t $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG .` (matching dev).
   - Unify `ECR_REPOSITORY` to a single canonical value across all three env blocks (confirm the correct value against what `infra/` / the ECS task-def `image_uri` consumes in each env; note dev currently uses `swiftagent/server`, staging/prod `swiftagent`). If the canonical repo must exist in staging/prod, either add an `Ensure ECR repository exists` step to those workflows (mirroring dev's) or confirm Terraform provisions it — call out which.
   - After normalization, the `Build and push Docker image` `run:` block MUST be **byte-identical** across dev, staging, and prod except for the `IMAGE_TAG` prefix env (`dev-`/`staging-`/`prod-`), which legitimately differs. Do not change the tag prefixes.

7. **Local + lint verification (see Tests).** Run the smoke script against a locally-running unified server (docker-compose) and against a deliberately-broken target; `actionlint` all three workflows; assert the normalized build blocks are identical; `docker build -f apps/server/Dockerfile .` succeeds.

## Tests

Deploy workflows are not unit-testable; verify as follows.

1. **Local happy-path smoke (SC-10).** Stand up the unified server locally (docker-compose or `pnpm --filter @swiftagent/server dev`) with a seeded smoke agent and a smoke API key. Run `SMOKE_BASE_URL=http://localhost:3000 SMOKE_API_KEY=<key> SMOKE_AGENT_NAME=smoke-echo pnpm smoke:realtime` and assert it exits `0` and prints the observed `message_started`/`token`/`message_completed` sequence. This is the same flow the deploy step runs.

2. **Deliberately-broken target fails loud (SC-10).** Run the script against a wrong URL (gateway down / bad host / stale token) and assert it exits **non-zero within the wall-clock budget** (does not hang), and that the log contains captured diagnostics (POST status/body or WS close code, plus `client.frames`). Cover at least: (a) unreachable base URL, (b) valid session but WS unreachable / connect timeout, (c) missing/invalid `SMOKE_API_KEY` (401 on `POST /v1/sessions`).

3. **Workflow lint (SC-12).** `actionlint` (or `yamllint`) `deploy-dev.yml`, `deploy-staging.yml`, `deploy-prod.yml` so the new `Realtime smoke test` step, its `env`, and the normalized `docker build` line all parse. Confirm the realtime step is ordered **after** the existing `/health` `Smoke test` and after `Wait for ECS service stability`.

4. **Docker build parity assertion (SC-11).** Byte-diff the `Build and push Docker image` `run:` blocks across the three deploy workflows and assert they are identical modulo the `IMAGE_TAG` prefix env; assert every env's `docker build` passes `-f apps/server/Dockerfile` and every env's `ECR_REPOSITORY` is the single canonical value.

5. **`docker build` succeeds (SC-11).** Run `docker build -f apps/server/Dockerfile -t swiftagent:smoke-test .` from the repo root and assert it completes (proving the normalized command staging/prod now use actually builds — previously they had no Dockerfile at the context root and would fail).

6. **Script typecheck/lint (SC-12).** Run the chosen coverage (`tsc --noEmit` on the smoke path + `eslint` on it) and assert clean, per the Design-Notes placement decision.

> **Cross-reference:** WS-34's developer quickstart is validated against deployed **dev** by this same smoke path — the quickstart's session-create → WS-connect → send → receive snippet and this script exercise identical endpoints, so keep them in lockstep.

## Acceptance Criteria

1. A NEW standalone smoke script (`test/smoke/realtime-smoke.ts` or `scripts/smoke/realtime-smoke.ts`) exists that: reads `SMOKE_BASE_URL`/`SMOKE_API_KEY`/`SMOKE_AGENT_NAME` from env; calls `POST /v1/sessions` with API-key auth and consumes `{ sessionId, websocketUrl }`; opens the WS to the returned `websocketUrl` (canonical `/v1/stream?token=`); sends `{ type: "send_message", content }`; and asserts the `message_started` → `token`(s) → `message_completed` `ChatEvent` sequence (validated via `ChatEventSchema`), treating `run_failed`/`error`/malformed frames as failures (SC-10).
2. The script is **bounded**: connect timeout, per-wait timeouts, an overall wall-clock budget, and ≤3 retries with backoff; on failure it exits **non-zero** and prints captured diagnostics (POST status+body, WS close code/reason, all received frames) — verified by the deliberately-broken-target test, which fails within the budget rather than hanging (SC-10).
3. The script **reuses** the existing `test/support/ws-client.ts` (`connectWs`/`WsClient`) and the shared `ChatEventSchema`, rather than re-implementing a socket wrapper or hand-rolled shape checks.
4. All three deploy workflows (`deploy-dev.yml`, `deploy-staging.yml`, `deploy-prod.yml`) have a `Realtime smoke test` step placed **after** the existing `/health` `Smoke test` and **after** `Wait for ECS service stability`, using the correct per-env base URL (dev ALB DNS via `steps.tf-outputs.outputs.alb_dns_name`; staging `https://staging-api.swiftagent.dev`; prod `https://api.swiftagent.dev`), and a **non-zero smoke exit blocks the deploy job** (SC-10). For prod, the step precedes the release-tag step.
5. The Docker build+push is **normalized** across all three workflows: every env runs `docker build -f apps/server/Dockerfile -t $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG .` and every env uses the **same** `ECR_REPOSITORY`; the `run:` block is byte-identical except for the `IMAGE_TAG` prefix env. The diagnosed root cause (staging/prod omitted `-f apps/server/Dockerfile` — and the only Dockerfile is `apps/server/Dockerfile`, with no root `./Dockerfile` — plus a mismatched ECR repository) is fixed, and `docker build -f apps/server/Dockerfile .` succeeds (SC-11).
6. The `apps/server/Dockerfile` is **not modified** by this workstream (the `EXPOSE 3000 3001` → `EXPOSE 3000` change is WS-31's); the SC-11 fix lives entirely in the workflows.
7. All three deploy workflows lint clean under `actionlint`, and the smoke script typechecks and lints clean via the chosen coverage path (SC-12).
8. The smoke-credential/agent provisioning assumption is documented (per-env `SMOKE_API_KEY` secret + seeded `smoke-echo` agent), and the minimum-bar fallback (authenticated connect + accepted `send_message` with no error/run_failed) is noted for envs lacking a seeded streaming agent — with the full-sequence assertion as the default (SC-10).
