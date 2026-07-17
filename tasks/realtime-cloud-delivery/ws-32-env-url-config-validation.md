# WS-32: Environment URL Configuration & Startup Validation

## Goal

Get the **correct** public WebSocket URL into every deployed environment and make it **impossible** to run a cloud instance that silently hands clients a `localhost` URL. This workstream does exactly three cohesive things and nothing more: (1) **provisions `PUBLIC_WEBSOCKET_URL` through Terraform/SSM** (a plain `String` param — it is not a secret), wires its ARN into the ECS task the same way `DATABASE_URL`/`REDIS_URL` are, and sets correct per-env `wss://…/v1/stream` values (dev, staging `wss://staging-api.swiftagent.dev/v1/stream`, prod `wss://api.swiftagent.dev/v1/stream`); (2) **removes the silent `?? 'ws://localhost:3001'` fallback** in `packages/api/src/server.ts` so a missing value can never be masked into a wrong-scheme/wrong-port/wrong-path URL; and (3) **adds fail-fast startup validation** so that, in a **cloud** environment, a missing `PUBLIC_WEBSOCKET_URL` — or one whose host is `localhost`/`127.0.0.1` or whose scheme is not `wss:` — aborts boot with a clear message in the existing "Missing required environment variables" style, while local dev keeps working with zero ceremony.

The canonical URL after the WS-30 port unification is `wss://<host>/v1/stream?token=<jwt>`. Because `sessions.ts` constructs the client URL as `` `${publicWebsocketUrl}?token=${clientToken}` `` (it appends **only** `?token=…`), `PUBLIC_WEBSOCKET_URL` MUST be the full base **up to and including `/v1/stream`** — e.g. `wss://api.swiftagent.dev/v1/stream`. This is confirmed by the gateway route (`instance.get('/stream', …)` under a `/v1` prefix → `/v1/stream`) and by `sessions.ts` (see *Existing Interfaces to Consume*).

No new runtime feature, no schema/migration, no SDK changes. This is a single-concern config-correctness workstream.

## Traceability

- **SC-02** — Session creation returns `wss://<host>/v1/stream?token=<jwt>`. This workstream provides the correct per-env **base** URL so the URL `sessions.ts` builds is right; SDK consumption of that URL is **WS-34**.
- **SC-03** — `PUBLIC_WEBSOCKET_URL` is provisioned via Terraform/SSM and injected into the ECS task with correct per-env `wss://` values (dev, staging, prod).
- **SC-04** — Startup fails fast when `PUBLIC_WEBSOCKET_URL` is missing, `localhost`/`127.0.0.1`, or non-`wss:` in a cloud environment; the silent `ws://localhost:3001` fallback is removed from the cloud path.
- **SC-12** — `pnpm exec tsc --noEmit`, `pnpm exec eslint . --quiet`, and the new unit tests pass; `terraform validate` is clean for all three envs.

## Dependencies

- **WS-30** — server unification onto a single port with the canonical `/v1/stream` route. This workstream assumes `/v1/stream` is the live path and that the app is served on the unified API host/port (AD-01). The build agent MUST confirm `/v1/stream` is the canonical route before choosing the URL suffix.
- **WS-31** — ALB/ECS port/drain tuning + single-task pin. WS-31 edits the same `infra/envs/{dev,staging,prod}/main.tf` compositions this workstream edits. **This workstream MUST land AFTER WS-31** and edit those files on top of WS-31's state to avoid conflicts. The build agent MUST re-read each `infra/envs/*/main.tf` immediately before editing (WS-31 may have moved the `module "secrets"` / `module "ecs"` wiring).

## Context Files (Agent MUST read before implementing)

- `c:\dev\swift-agent\CLAUDE.md` — conventions (`ENV_KEYS` single source of truth in `@swiftagent/shared`; Zod schemas are source of truth; forced verification via `tsc --noEmit` + `eslint`; NO SEMANTIC SEARCH — grep every reference before changing a literal/type).
- `c:\dev\swift-agent\packages\shared\src\config.ts` — `ENV_KEYS` and the Zod `ConfigSchema`. `PUBLIC_WEBSOCKET_URL: z.string().url().optional()` (line 49). Note `API_PORT` defaults 3000, `GATEWAY_PORT` defaults 3001 (the stale `3001` is the origin of the wrong-port fallback). `loadConfig(env)` returns the validated `AppConfig`.
- `c:\dev\swift-agent\apps\server\src\config.ts` — `loadServerConfig` — the fail-fast validator that collects **all** missing required vars into `missing[]` and throws `Missing required environment variables:\n  - …`. This is the pattern the new cloud-URL check MUST mirror. Also `redactConfig` (surfaces `PUBLIC_WEBSOCKET_URL` on the banner, line 84).
- `c:\dev\swift-agent\apps\server\src\main.ts` — startup. `loadServerConfig()` at line 24; `publicWebsocketUrl: config[ENV_KEYS.PUBLIC_WEBSOCKET_URL]` passed to `buildApp` at line 62. This is where a dedicated validator would be invoked if not folded into `loadServerConfig`.
- `c:\dev\swift-agent\packages\api\src\server.ts` — `BuildAppOptions.publicWebsocketUrl?: string` (line 49) and the silent fallback `publicWebsocketUrl: opts.publicWebsocketUrl ?? 'ws://localhost:3001'` (line 109) passed into `registerSessionRoutes`. This literal is the thing to remove/guard.
- `c:\dev\swift-agent\packages\api\src\routes\sessions.ts` — `SessionRouteDeps.publicWebsocketUrl: string` (required, line 10) and `const websocketUrl = \`${publicWebsocketUrl}?token=${clientToken}\`;` (line 34). Confirms only `?token=…` is appended, so the env value must include `/v1/stream`.
- `c:\dev\swift-agent\packages\gateway\src\server.ts` — `instance.get('/stream', { websocket: true }, …)` (line 67) under the `/v1` prefix → canonical `/v1/stream`. Confirms the path suffix.
- `c:\dev\swift-agent\infra\modules\secrets\main.tf` — how SSM params are created (`aws_ssm_parameter` with `name = "/${var.environment}/swiftagent/<KEY>"`), and the `locals.parameter_arns` / `parameter_names` maps. **`PUBLIC_WEBSOCKET_URL` is NOT created here today** — this workstream adds it (as `type = "String"`, not `SecureString`).
- `c:\dev\swift-agent\infra\modules\secrets\variables.tf` — module inputs (`environment`, `database_url`, `redis_url`, all `sensitive`). A new `public_websocket_url` variable is added here.
- `c:\dev\swift-agent\infra\modules\secrets\outputs.tf` — `parameter_arns` / `parameter_names` outputs (consumed by `iam` + `ecs` in the env compositions).
- `c:\dev\swift-agent\infra\modules\ecs\task-definition.tf` — the container `secrets` block iterates `var.ssm_parameter_arns` → `{ name, valueFrom }`. Because the env value is injected via the **same** `ssm_parameter_arns` map, adding the ARN to that map is all the task def needs — **no change to `task-definition.tf` itself** (SSM `String` params are valid `valueFrom` sources for ECS `secrets`). Confirm this.
- `c:\dev\swift-agent\infra\modules\ecs\variables.tf` — `ssm_parameter_arns` is `map(string)`; the new ARN flows in through it.
- `c:\dev\swift-agent\infra\envs\dev\main.tf`, `staging\main.tf`, `prod\main.tf` — `module "secrets"` is called with only `environment` + `database_url` + `redis_url` today; `module "ecs"` receives `ssm_parameter_arns = module.secrets.parameter_arns` (staging/prod) or `merge(module.secrets.parameter_arns, module.cognito.parameter_arns)` (dev). The new `public_websocket_url` input is added to each `module "secrets"` call; the ARN then flows into ECS automatically via `parameter_arns`.
- `c:\dev\swift-agent\infra\envs\{dev,staging,prod}\terraform.tfvars` — per-env values. **staging** sets `domain_prefix = "staging-api"`, **prod** sets `domain_prefix = "api"`; **dev** sets **no** `domain_prefix` and `enable_dns` defaults `false` (no DNS). The parent domain is `swiftagent.dev` (`infra/modules/dns/variables.tf` default).
- `c:\dev\swift-agent\infra\modules\dns\main.tf` / `outputs.tf` — `domain_name = "${var.domain_prefix}.${var.parent_domain}"`; the `dns` module is `count = var.enable_dns ? 1 : 0` and outputs `domain_name`. The env `domain_name` output is `var.enable_dns ? module.dns[0].domain_name : module.loadbalancer.alb_dns_name`. This is how to derive the hostname for staging/prod, and the fallback (ALB DNS) for dev.

## Package

`infra/modules/secrets`, `infra/envs/{dev,staging,prod}`, `packages/api`, `apps/server`. (`packages/shared` only if a config-schema tweak is genuinely required — see Design Notes; the current `z.string().url().optional()` is expected to be sufficient, so prefer **not** touching it.)

## Files Touched

- `infra/modules/secrets/variables.tf` **(MODIFY)** — add a `public_websocket_url` input variable (`type = string`, not `sensitive` — it is a public URL).
- `infra/modules/secrets/main.tf` **(MODIFY)** — add `aws_ssm_parameter "public_websocket_url"` (`type = "String"`, `value = var.public_websocket_url`, `name = "/${var.environment}/swiftagent/PUBLIC_WEBSOCKET_URL"`), and add `PUBLIC_WEBSOCKET_URL` to both `locals.parameter_arns` and `locals.parameter_names`.
- `infra/envs/dev/main.tf` **(MODIFY, after WS-31)** — pass `public_websocket_url` into `module "secrets"`, derived per the dev decision below.
- `infra/envs/staging/main.tf` **(MODIFY, after WS-31)** — pass `public_websocket_url` into `module "secrets"`, derived from the staging domain.
- `infra/envs/prod/main.tf` **(MODIFY, after WS-31)** — pass `public_websocket_url` into `module "secrets"`, derived from the prod domain.
- `infra/envs/dev/terraform.tfvars` **(MODIFY, only if a tfvars override is chosen for dev)** — add `public_websocket_url = "…"` if dev derivation falls back to an explicit value (see Design Notes).
- `packages/api/src/server.ts` **(MODIFY)** — remove the `?? 'ws://localhost:3001'` fallback; adopt the chosen `publicWebsocketUrl` contract (see Design Notes / Implementation Step 2).
- `apps/server/src/config.ts` **(MODIFY)** — add cloud-URL validation to `loadServerConfig` (or a small dedicated `validatePublicWebsocketUrl` helper it calls) that fails fast on a missing/`localhost`/non-`wss:` URL when the deploy environment is cloud.
- `apps/server/src/main.ts` **(MODIFY, only if the validator is dedicated rather than folded into `loadServerConfig`)** — invoke the validator right after `loadServerConfig()`; and, if the local-dev explicit default is chosen (contract B below), supply it here when passing `publicWebsocketUrl` to `buildApp`.
- `apps/server/src/__tests__/config.test.ts` **(NEW or MODIFY)** — unit tests for the cloud-URL validator (the four cases below). If a config test file already exists, extend it; otherwise create it.
- `packages/api/src/__tests__/sessions.test.ts` **(NEW or MODIFY)** — a test asserting `sessions.ts` builds `${PUBLIC_WEBSOCKET_URL}?token=…` correctly against a realistic `wss://…/v1/stream` base. If a sessions route test exists, extend it.

> **No `task-definition.tf` change** is expected: the ARN reaches the container through the existing `ssm_parameter_arns` map. Confirm during implementation; only touch it if ECS rejects a `String`-typed SSM param as a `secrets.valueFrom` source (it does not).

## Existing Interfaces to Consume

**`ENV_KEYS` entry + schema** (`packages/shared/src/config.ts`) — the key and its (already `.url().optional()`) validation:

```typescript
export const ENV_KEYS = {
  // …
  PUBLIC_WEBSOCKET_URL: 'PUBLIC_WEBSOCKET_URL',
  // …
  API_PORT: 'API_PORT',
  GATEWAY_PORT: 'GATEWAY_PORT',
  // …
} as const;

const ConfigSchema = z.object({
  // …
  [ENV_KEYS.PUBLIC_WEBSOCKET_URL]: z.string().url().optional(),
  // …
  [ENV_KEYS.API_PORT]: z.coerce.number().int().positive().default(3000),
  [ENV_KEYS.GATEWAY_PORT]: z.coerce.number().int().positive().default(3001),
});
```

**The silent fallback to remove** (`packages/api/src/server.ts`, inside the `/v1` plugin):

```typescript
registerSessionRoutes(v1, {
  sessionService,
  tokenService,
  publicWebsocketUrl: opts.publicWebsocketUrl ?? 'ws://localhost:3001', // <- WRONG for cloud: ws:, :3001, no /v1/stream
});
```

`BuildAppOptions.publicWebsocketUrl` is currently `publicWebsocketUrl?: string;` (optional). `SessionRouteDeps.publicWebsocketUrl` is **required** (`string`) in `routes/sessions.ts`, so the fallback exists solely to satisfy that requirement — removing the fallback forces an explicit contract decision (Design Notes).

**URL construction** (`packages/api/src/routes/sessions.ts`) — proves only `?token=…` is appended:

```typescript
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

**Canonical gateway route** (`packages/gateway/src/server.ts`) — the `/v1/stream` suffix source of truth:

```typescript
// WebSocket endpoint: /v1/stream
instance.get('/stream', { websocket: true }, (socket: WebSocket, req) => { /* … */ });
```

**The fail-fast pattern to mirror** (`apps/server/src/config.ts`, `loadServerConfig`) — collect all failures, then throw one message:

```typescript
const missing: string[] = [];

const required = [ENV_KEYS.DATABASE_URL, ENV_KEYS.CLIENT_JWT_SECRET] as const;
for (const key of required) {
  if (!env[key]) {
    missing.push(key);
  }
}
// … model-provider-key check appends to missing …

if (missing.length > 0) {
  throw new Error(
    `Missing required environment variables:\n${missing.map((m) => `  - ${m}`).join('\n')}`,
  );
}
```

**The SSM parameter resource pattern to copy** (`infra/modules/secrets/main.tf`) — the new param mirrors this shape but with `type = "String"`:

```hcl
resource "aws_ssm_parameter" "database_url" {
  name  = "/${var.environment}/swiftagent/DATABASE_URL"
  type  = "SecureString"
  value = var.database_url

  tags = {
    Environment = var.environment
  }
}

locals {
  parameter_arns = {
    DATABASE_URL      = aws_ssm_parameter.database_url.arn
    REDIS_URL         = aws_ssm_parameter.redis_url.arn
    CLIENT_JWT_SECRET = aws_ssm_parameter.jwt_secret.arn
    OPENAI_API_KEY    = aws_ssm_parameter.openai_api_key.arn
    ANTHROPIC_API_KEY = aws_ssm_parameter.anthropic_api_key.arn
    GOOGLE_API_KEY    = aws_ssm_parameter.google_api_key.arn
  }
  # parameter_names mirrors the same keys → .name
}
```

**The ECS secrets injection** (`infra/modules/ecs/task-definition.tf`) — consumes `ssm_parameter_arns` **unchanged**; the new ARN rides in through the map:

```hcl
secrets = [
  for key, arn in var.ssm_parameter_arns : {
    name      = key
    valueFrom = arn
  }
]
```

**The domain derivation** (`infra/modules/dns/main.tf` + env `main.tf` output) — how to build the hostname per env:

```hcl
# modules/dns/main.tf
locals {
  domain_name = "${var.domain_prefix}.${var.parent_domain}"  # e.g. staging-api.swiftagent.dev
}

# infra/envs/<env>/main.tf output
output "domain_name" {
  value = var.enable_dns ? module.dns[0].domain_name : module.loadbalancer.alb_dns_name
}
```

## Design Notes

- **Why SSM `String`, not `SecureString`.** `PUBLIC_WEBSOCKET_URL` is a public, non-secret endpoint that ends up in every client's browser. Storing it as `SecureString` would add needless KMS decryption on the task-execution role for zero security benefit. Use `type = "String"`. ECS `secrets.valueFrom` accepts plain SSM `String` parameters, so it still injects identically to the `SecureString` params — no `task-definition.tf` change, no IAM change beyond the existing `ssm_parameter_arns`-driven grant (the `iam` module already grants read on `values(module.secrets.parameter_arns)`, which will now include this ARN automatically).

- **Per-env value derivation (SC-03) — prefer derivation over hardcoding.**
  - **staging** → `"wss://${module.dns[0].domain_name}/v1/stream"` when `enable_dns` is true (yields `wss://staging-api.swiftagent.dev/v1/stream`). Because `module.dns` is `count`-gated, guard with the same `var.enable_dns ? … : …` expression already used by the env's `domain_name` output; the false branch derives from the ALB DNS name (`wss://${module.loadbalancer.alb_dns_name}/v1/stream`) so the value is never empty.
  - **prod** → identical shape, yielding `wss://api.swiftagent.dev/v1/stream` (prod `domain_prefix = "api"`).
  - **dev** → dev has **no** `domain_prefix` and `enable_dns` defaults `false`, so there is no stable DNS name. **Decision: derive from the ALB DNS output** (`wss://${module.loadbalancer.alb_dns_name}/v1/stream`), with an optional `public_websocket_url` tfvars override for when a developer wires a custom dev domain. Document this choice inline in `dev/main.tf`. Rationale: the ALB DNS name is a real, reachable `wss` endpoint for dev; it is not `localhost`, so the cloud guard (below) accepts it. A single `local.public_websocket_url` expression in each env's `main.tf` keeps the derivation legible and lets `terraform validate`/`plan` show a concrete value.
  - **Never hardcode a bare hostname** in `main.tf`; always compose `wss://` + `<derived host>` + `/v1/stream`. The `/v1/stream` suffix is the load-bearing part (see Goal) — a value missing it would produce `wss://host?token=…`, which never reaches the gateway route.

- **Removing the silent fallback — pick ONE contract (Implementation Step 2).** Two clean options; the spec **recommends contract A** for the smallest, most honest surface:
  - **Contract A (recommended): make `publicWebsocketUrl` required in the app layer, keep it optional in `BuildAppOptions` but drop the wrong default.** Change the `server.ts` line to pass `opts.publicWebsocketUrl` straight through, and make the local-dev default the responsibility of the **app** (`main.ts`/`config.ts`), not the API package. Concretely: `registerSessionRoutes` still needs a `string`, so `server.ts` must supply one — but the value it supplies must come from a *validated* source. The cleanest form is to require `publicWebsocketUrl: string` on `BuildAppOptions` (drop the `?`) and let `main.ts` pass a **validated** value (the SSM value in cloud, or an explicit `ws://localhost:3001` **local-only** default computed in `main.ts` where the environment is known). This moves the localhost default to exactly one place (app boot), where the cloud guard can reject it, and removes it from the reusable API package.
  - **Contract B: keep `BuildAppOptions.publicWebsocketUrl` optional but replace the `??` default with an explicit LOCAL-only constant the cloud guard rejects.** Simpler diff, but leaves a `localhost` literal inside the API package. Acceptable only if the cloud guard in `apps/server` runs **before** `buildApp` (it does — `loadServerConfig` precedes `buildApp` in `main.ts`), so a cloud boot can never reach the fallback.
  - Either way, the invariant is: **no code path in a cloud environment may pass a `localhost`/`ws:` URL to `sessions.ts`.** The guard in `apps/server` enforces it before `buildApp` is ever called. Prefer A; if the `BuildAppOptions` signature change ripples into more than a couple of call sites (grep first — `buildApp(` and `BuildAppOptions`), fall back to B and document why.

- **Defining "cloud environment" (SC-04) — decision: an explicit `DEPLOY_ENV` signal, not `NODE_ENV`.** `NODE_ENV=production` is overloaded (it also governs bundling, logging, and third-party lib behavior) and is often set `production` in local production-parity runs, which would wrongly trip the guard. Instead, treat the environment as **cloud** when `process.env.DEPLOY_ENV` is one of `dev`/`staging`/`prod` (the exact values already used as the Terraform `environment` and injected into the task). This is unambiguous, is only ever set by the deploy path, and leaves local dev (no `DEPLOY_ENV`) untouched — no ceremony. If a `DEPLOY_ENV` container env is not already injected, **add it** as a plain `environment` entry on the ECS task definition set to `var.environment` (this is a tiny, justified addition; it is not a secret and needs no SSM param). The build agent MUST check whether `DEPLOY_ENV` is already injected (grep `infra/` + `apps/server`); reuse it if present. Do **not** add `DEPLOY_ENV` to the validated `ENV_KEYS`/`ConfigSchema` — it is a boot-time deployment marker, not app config the schema needs to type; read it directly from `env` in the validator (mirrors how `AUTO_MIGRATE` is read directly in `loadServerConfig`).

- **The validator's exact rejection rules (cloud only).** When `DEPLOY_ENV ∈ {dev,staging,prod}`, `PUBLIC_WEBSOCKET_URL` MUST be present AND parse as a URL whose `protocol === 'wss:'` AND whose `hostname` is not `localhost` / `127.0.0.1` / `::1` / `0.0.0.0`. Any violation appends a specific line to the same `missing`/error aggregation and throws in the `Missing required environment variables:`-style message (e.g. `PUBLIC_WEBSOCKET_URL must be a wss:// URL in a cloud environment (got 'ws://localhost:3001')`). In a **non-cloud** environment (no `DEPLOY_ENV`), skip the check entirely — a missing or `localhost` value is allowed. Use the global `URL` constructor for parsing (guard the `URL(...)` in a try/catch so an unparseable value yields a clear message rather than a raw `TypeError`). Do **not** re-implement URL parsing by hand.

- **Zod schema stays as-is.** `z.string().url().optional()` already rejects a syntactically invalid URL and permits absence — exactly right for local dev and for the optional-at-schema-level nature of the var. The **cloud-specific** constraints (scheme `wss:`, non-localhost, required-when-cloud) are deployment policy, not universal schema truth, so they live in the `apps/server` validator, not in `packages/shared`. Only touch `config.ts` in `shared` if a genuinely universal tweak is needed — it is not expected.

- **Redaction banner.** `redactConfig` already prints `PUBLIC_WEBSOCKET_URL` verbatim (it is not a secret). Leave it; it is useful for confirming the injected value at boot. No change needed.

## Implementation Steps

1. **Provision the SSM parameter (`infra/modules/secrets`).**
   - `variables.tf`: add
     ```hcl
     variable "public_websocket_url" {
       description = "Public wss:// base URL up to and including /v1/stream (e.g. wss://api.swiftagent.dev/v1/stream). Not a secret."
       type        = string
     }
     ```
   - `main.tf`: add the resource (note `type = "String"`), and extend both locals maps:
     ```hcl
     resource "aws_ssm_parameter" "public_websocket_url" {
       name  = "/${var.environment}/swiftagent/PUBLIC_WEBSOCKET_URL"
       type  = "String"
       value = var.public_websocket_url

       tags = {
         Environment = var.environment
       }
     }
     # add to locals.parameter_arns:  PUBLIC_WEBSOCKET_URL = aws_ssm_parameter.public_websocket_url.arn
     # add to locals.parameter_names: PUBLIC_WEBSOCKET_URL = aws_ssm_parameter.public_websocket_url.name
     ```
   - Do **not** touch `outputs.tf` (it already outputs the whole `parameter_arns`/`parameter_names` maps).

2. **Wire per-env values (`infra/envs/{dev,staging,prod}/main.tf`) — AFTER WS-31, re-read each file first.** In each env, compute the URL as a `local` and pass it into `module "secrets"`:
   - **staging / prod:**
     ```hcl
     locals {
       public_websocket_url = var.enable_dns
         ? "wss://${module.dns[0].domain_name}/v1/stream"
         : "wss://${module.loadbalancer.alb_dns_name}/v1/stream"
     }
     # in module "secrets":
     public_websocket_url = local.public_websocket_url
     ```
     (Guard the `module.dns[0]` reference with the same `var.enable_dns ? …` expression already used by the env's `domain_name` output, so a `count = 0` dns module never dereferences.)
   - **dev:** use the ALB-derived form with an optional tfvars override:
     ```hcl
     locals {
       public_websocket_url = var.public_websocket_url != ""
         ? var.public_websocket_url
         : "wss://${module.loadbalancer.alb_dns_name}/v1/stream"
     }
     ```
     Add a `variable "public_websocket_url" { type = string; default = "" }` to `dev/main.tf` and optionally set it in `dev/terraform.tfvars`. Add an inline comment explaining the dev choice (no DNS → derive from ALB DNS, overridable via tfvars).
   - Confirm the ARN flows to ECS: `module "ecs"` already receives `ssm_parameter_arns = module.secrets.parameter_arns` (staging/prod) or the `merge(...)` (dev); the new `PUBLIC_WEBSOCKET_URL` key is now in that map, so the task def picks it up with no further change.

3. **Remove the silent fallback (`packages/api/src/server.ts`) — contract A (preferred).**
   - Grep first: `buildApp(`, `BuildAppOptions`, `publicWebsocketUrl` across the repo (per CLAUDE.md rule 10 — direct calls, type refs, tests, re-exports).
   - Change `BuildAppOptions.publicWebsocketUrl?: string;` → `publicWebsocketUrl: string;` (required) IF the ripple is small; otherwise keep optional and use contract B.
   - Replace line 109 `publicWebsocketUrl: opts.publicWebsocketUrl ?? 'ws://localhost:3001'` with `publicWebsocketUrl: opts.publicWebsocketUrl` (contract A) — the wrong default is gone from the API package.
   - Update `apps/server/src/main.ts` so the value passed to `buildApp` is a validated `string`: pass the SSM value, and when it is absent in **local** dev supply an explicit `ws://localhost:3001` **there** (where `DEPLOY_ENV` is known-absent), e.g. `publicWebsocketUrl: config[ENV_KEYS.PUBLIC_WEBSOCKET_URL] ?? 'ws://localhost:3001'` — but only reached because the cloud guard (step 4) has already thrown for any cloud boot lacking a real value. Add a comment noting the localhost default is local-only and unreachable in cloud.
   - If contract B is chosen instead, leave `BuildAppOptions.publicWebsocketUrl?` optional and set the `server.ts` default to an explicit local-only constant (comment it), relying on the step-4 guard running before `buildApp`.

4. **Add the cloud-URL validator (`apps/server/src/config.ts`).**
   - Add a helper (exported for testing):
     ```typescript
     const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
     const CLOUD_ENVS = new Set(['dev', 'staging', 'prod']);

     export function validatePublicWebsocketUrl(
       env: Record<string, string | undefined>,
     ): string | null {
       const deployEnv = env['DEPLOY_ENV'];
       if (!deployEnv || !CLOUD_ENVS.has(deployEnv)) return null; // local dev: no constraint
       const raw = env[ENV_KEYS.PUBLIC_WEBSOCKET_URL];
       if (!raw) return `${ENV_KEYS.PUBLIC_WEBSOCKET_URL} is required in a cloud environment (DEPLOY_ENV=${deployEnv})`;
       let url: URL;
       try {
         url = new URL(raw);
       } catch {
         return `${ENV_KEYS.PUBLIC_WEBSOCKET_URL} is not a valid URL (got '${raw}')`;
       }
       if (url.protocol !== 'wss:')
         return `${ENV_KEYS.PUBLIC_WEBSOCKET_URL} must use the wss:// scheme in a cloud environment (got '${raw}')`;
       if (LOCAL_HOSTS.has(url.hostname))
         return `${ENV_KEYS.PUBLIC_WEBSOCKET_URL} must not point at localhost in a cloud environment (got '${raw}')`;
       return null;
     }
     ```
   - Call it inside `loadServerConfig`, appending any returned message to the existing `missing[]` array **before** the `if (missing.length > 0) throw …` block, so a bad URL is reported alongside any other missing var in the same fail-fast message. (Alternatively invoke it from `main.ts` right after `loadServerConfig()` and throw there — but folding into `loadServerConfig` keeps a single fail-fast site; prefer that.)
   - Read `DEPLOY_ENV` directly from `env` (do not add it to `ENV_KEYS`/`ConfigSchema`), mirroring how `AUTO_MIGRATE` is read.

5. **Ensure `DEPLOY_ENV` is injected in cloud (infra).** Grep `infra/` + `apps/server` for `DEPLOY_ENV`. If absent, add a plain (non-SSM) `environment` entry to the ECS task definition set to the env name. The cleanest spot: extend `infra/modules/ecs/task-definition.tf` to always include `environment = [{ name = "DEPLOY_ENV", value = var.environment }]` (merge it with any existing `environment` block — note the task def already conditionally merges a `MIGRATE_SKIP_DRIFT_CHECK` env; combine cleanly so both can coexist). `var.environment` is already an input to the ECS module. Document that `DEPLOY_ENV` is the cloud signal for the startup guard.

6. **Verify (forced verification per CLAUDE.md rule 4).**
   - `pnpm exec tsc --noEmit` and `pnpm exec eslint . --quiet` — fix all errors.
   - `terraform validate` and `terraform plan` in `infra/envs/{dev,staging,prod}` — confirm the new `aws_ssm_parameter.public_websocket_url` and the correct per-env `wss://…/v1/stream` value appear.
   - Grep `packages/api` to confirm no `ws://localhost:3001` literal remains on any cloud-reachable path (contract A removes it entirely; contract B leaves exactly one local-only, commented constant).

## Tests

Unit tests are the primary gate; Terraform is validated via `validate`/`plan`.

1. **Validator — cloud env + missing URL throws (SC-04).** `validatePublicWebsocketUrl({ DEPLOY_ENV: 'prod' })` (no `PUBLIC_WEBSOCKET_URL`) returns a non-null message; and `loadServerConfig` with `DEPLOY_ENV=prod` and no URL (but otherwise valid required vars) **throws** an error whose message contains `PUBLIC_WEBSOCKET_URL` and `required`.
2. **Validator — cloud env + `ws://localhost:3001` throws (SC-04).** `DEPLOY_ENV: 'prod'`, `PUBLIC_WEBSOCKET_URL: 'ws://localhost:3001'` → non-null message mentioning the scheme (and/or localhost). Assert `loadServerConfig` throws. (Also cover `wss://localhost/v1/stream` → rejected for localhost host, and `ws://api.swiftagent.dev/v1/stream` → rejected for scheme.)
3. **Validator — cloud env + `wss://api.swiftagent.dev/v1/stream` passes (SC-04).** `DEPLOY_ENV: 'prod'`, valid `wss` non-localhost URL → returns `null`; `loadServerConfig` with all required vars present does **not** throw.
4. **Validator — local/dev env + missing or localhost is allowed (SC-04).** With **no** `DEPLOY_ENV`: missing `PUBLIC_WEBSOCKET_URL` → `null` (allowed); `PUBLIC_WEBSOCKET_URL: 'ws://localhost:3001'` → `null` (allowed). Confirms local dev has zero ceremony. Also: `DEPLOY_ENV: 'test'` (not in the cloud set) → `null`.
5. **URL construction (SC-02).** Given a realistic base `wss://api.swiftagent.dev/v1/stream`, `registerSessionRoutes` (or a direct unit on the URL expression) produces `wss://api.swiftagent.dev/v1/stream?token=<jwt>` — i.e. exactly one `?token=` appended, `/v1/stream` preserved, scheme `wss`. Assert via a `POST /v1/sessions` route test (mirror the existing sessions/route test harness) that the `websocketUrl` in the 201 body equals `` `${base}?token=${clientToken}` `` with `base` the injected value.
6. **No cloud localhost literal.** A repo-level assertion/grep that `packages/api/src` contains no `ws://localhost:3001` on a cloud-reachable path (contract A: none at all; contract B: only the commented local-only constant, which the cloud guard rejects before `buildApp`).
7. **Terraform (SC-03).** `terraform validate` is clean for all three envs; `terraform plan` (with a stub `image_uri`) shows `aws_ssm_parameter.public_websocket_url` to-be-created with `type = "String"` and the correct per-env value (`wss://staging-api.swiftagent.dev/v1/stream`, `wss://api.swiftagent.dev/v1/stream`, and the dev ALB-derived value), and shows `PUBLIC_WEBSOCKET_URL` present in the ECS task's `secrets` (via the `ssm_parameter_arns` map) for all three.

## Acceptance Criteria

1. `infra/modules/secrets` creates a `PUBLIC_WEBSOCKET_URL` SSM parameter as `type = "String"` (not `SecureString`), named `/${environment}/swiftagent/PUBLIC_WEBSOCKET_URL`, driven by a new `public_websocket_url` module input; its ARN and name are added to `locals.parameter_arns` and `locals.parameter_names` (SC-03).
2. All three env compositions (`dev`, `staging`, `prod`) pass a per-env `public_websocket_url` into `module "secrets"`, **derived** from the env domain where available (staging `wss://staging-api.swiftagent.dev/v1/stream`, prod `wss://api.swiftagent.dev/v1/stream`) and from the ALB DNS name (overridable via tfvars) for dev; every value is a `wss://…/v1/stream` URL and the derivation is documented inline (SC-03). The ARN reaches the ECS task via the existing `ssm_parameter_arns` map with no `task-definition.tf` secrets-loop change.
3. The silent `?? 'ws://localhost:3001'` fallback is removed from `packages/api/src/server.ts`; the chosen contract (A preferred, B acceptable) ensures no cloud code path can pass a `localhost`/`ws:` URL to `sessions.ts`, and any local-only default lives in exactly one commented place unreachable during a cloud boot (SC-04).
4. `apps/server` fails fast at startup — in the existing `Missing required environment variables:` style — when `DEPLOY_ENV ∈ {dev,staging,prod}` and `PUBLIC_WEBSOCKET_URL` is missing, non-`wss:`, or points at `localhost`/`127.0.0.1`/`::1`/`0.0.0.0`; the check is skipped entirely when `DEPLOY_ENV` is absent (local dev), so local boot needs no ceremony (SC-04).
5. `DEPLOY_ENV` is injected into the ECS task (plain env, not SSM) set to the environment name, and is read **directly** from `env` in the validator — it is NOT added to `ENV_KEYS`/`ConfigSchema`.
6. `sessions.ts` builds `wss://<host>/v1/stream?token=<jwt>` from the injected base — proven by a route/unit test against a realistic `wss://…/v1/stream` value (SC-02).
7. `pnpm exec tsc --noEmit` and `pnpm exec eslint . --quiet` pass; the new validator and sessions-URL unit tests pass; `terraform validate` is clean for all three envs and `plan` shows the new SSM parameter + per-env wiring (SC-12).
8. Scope is respected: no server merge (WS-30), no ALB/drain/single-task work (WS-31), no SDK/docs (WS-34), no smoke tests (WS-35). The env `main.tf` edits are made **on top of** WS-31's state.
