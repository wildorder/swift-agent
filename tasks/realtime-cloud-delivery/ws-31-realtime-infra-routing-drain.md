# WS-31: Realtime Infra: Single-Port Routing & Drain Tuning

## Goal

Align the AWS infrastructure to the **single public port (3000)** posture that **WS-30** creates when it merges the gateway WebSocket route onto the API's Fastify app, and tune the load balancer + ECS draining so an in-flight WebSocket survives — and cleanly closes on — a deploy. Because WS-30 makes the container serve REST *and* `/v1/stream` on the same port, the ALB needs **no new target group and no new listener rule** (AD-01): everything already forwards to port 3000. This workstream is therefore **alignment + tuning only**, and does exactly four things:

1. **Remove the now-stale port `3001`** from `apps/server/Dockerfile`'s `EXPOSE` line (leave only `3000`), and confirm the ECS task definition `portMappings` maps **only** 3000. Keep the ECS security group at 3000-from-ALB-only — introduce no new port anywhere.
2. **Assert (do not regress) the ALB long-socket settings** already in place: `idle_timeout = 3600` on the ALB (required so a long-lived WebSocket is not idle-timed-out) and `lb_cookie` stickiness on the target group (so a client's socket stays pinned to its task for the session).
3. **Tune drain-on-deploy:** make the target-group `deregistration_delay` and a new container `stopTimeout` concrete, mutually-consistent values sized to let in-flight WebSockets drain when a task is replaced (the app closes sockets with code `1001` on `SIGTERM` — delivered by WS-30). Expose both as Terraform variables with sensible defaults.
4. **Pin the ECS service to a single task** (`desired_count = 1`) across dev/staging/prod for the MVP (AD-02); note that horizontal scale / autoscaling is explicitly Phase-2 and out of scope.

**Scope: S-sized.** No app code is written here (WS-30 owns the server merge and the SIGTERM socket-drain). No SSM `PUBLIC_WEBSOCKET_URL` parameter is added here (WS-32). No Redis fanout work (WS-33). No broader Docker build-consistency work or deploy smoke tests (WS-35) — this workstream only removes the single stale `EXPOSE` port.

## Traceability

- **SC-01** — No separate gateway port is exposed in the container, the ECS task definition, or the security group; `/v1/stream` is reachable through the **existing** ALB via the single target group on port 3000 (no new TG, no new listener rule).
- **SC-05** — ALB `idle_timeout` / stickiness / target-group `deregistration_delay` and the ECS container `stopTimeout` are tuned for long-lived sockets so a deploy drains in-flight connections rather than cutting them.
- **SC-07** (contributes) — implements the single-task posture (`desired_count = 1`); WS-33 documents the resulting single-node limits.
- **SC-12** — `terraform fmt -check` / `terraform validate` are clean and `terraform plan` succeeds for every env, showing only the intended diffs.

## Dependencies

- **WS-30 — Unified single-port server (MUST land first).** WS-30 merges the gateway WebSocket route onto the API Fastify app so the container listens on **one** port (3000) and, on `SIGTERM`, closes open sockets with WebSocket close code `1001` before exiting. This workstream MUST NOT remove the `3001` exposure until WS-30 has landed that merge — removing it earlier would break the still-separate gateway listener. The build agent MUST confirm (read the WS-30 server bootstrap / `apps/server/dist/main.js` entry, or the WS-30 spec's acceptance criteria) that the app binds a single port and installs a SIGTERM socket-drain handler before touching the Dockerfile `EXPOSE` line.

## Context Files (Agent MUST read before implementing)

- `c:\dev\swift-agent\CLAUDE.md` — conventions (Terraform lives under `infra/`; env compositions under `infra/envs/{dev,staging,prod}`; modules under `infra/modules/*`).
- `c:\dev\swift-agent\infra\modules\ecs\task-definition.tf` — the single-container task def. `portMappings` today is **3000-only** (confirm, do not add 3001). This is also where the container `stopTimeout` is added. Note the existing `migrate_skip_drift_check` merge pattern — the new `stopTimeout` is a plain field on the base container object, not a conditional merge.
- `c:\dev\swift-agent\infra\modules\ecs\service.tf` — the ECS service. `load_balancer` block already `container_port = 3000`; `desired_count = var.desired_count`; deployment min/max 100/200 with a circuit breaker + rollback; autoscaling resources are **gated behind `var.enable_autoscaling`** (leave disabled — AD-02).
- `c:\dev\swift-agent\infra\modules\ecs\variables.tf` — `desired_count` already defaults to `1`; this is where the new `stop_timeout` variable is declared.
- `c:\dev\swift-agent\infra\modules\loadbalancer\main.tf` — ALB `idle_timeout = 3600` (assert, keep); target group `port = 3000`, `deregistration_delay = 30`, `lb_cookie` stickiness, health check path `var.health_check_path` (`/health`). This is where `deregistration_delay` becomes a variable.
- `c:\dev\swift-agent\infra\modules\loadbalancer\variables.tf` — where the new `deregistration_delay` variable is declared.
- `c:\dev\swift-agent\infra\modules\networking\main.tf` — the ECS security group ingress is **3000-from-ALB only** (verify only; change nothing). The ALB SG allows 80/443 public; DB (5432) and Redis (6379) SGs allow only from ECS.
- `c:\dev\swift-agent\infra\envs\dev\main.tf`, `c:\dev\swift-agent\infra\envs\staging\main.tf`, `c:\dev\swift-agent\infra\envs\prod\main.tf` — module wiring. The ecs module block feeds `desired_count = var.desired_count` and `enable_autoscaling = var.enable_autoscaling`; the actual values come from each env's `terraform.tfvars` (see below), so the pin is applied there, not here. Wire the new `stop_timeout` / `deregistration_delay` values here only if you choose to override the module defaults per-env (prefer the defaults — see Design Notes).
- `c:\dev\swift-agent\infra\envs\{dev,staging,prod}\terraform.tfvars` — the per-env `desired_count` / `enable_autoscaling` values. **dev** is `1` / `false` (correct); **staging** is `desired_count = 2` (must become `1`); **prod** is `desired_count = 2` + `enable_autoscaling = true` (must become `1` / `false`). These two overrides are the AD-02 violation this workstream fixes.
- `c:\dev\swift-agent\apps\server\Dockerfile` — `EXPOSE 3000 3001` (line 74). Remove the `3001`.

## Package

`infra/modules/ecs`, `infra/modules/loadbalancer`, `infra/modules/networking` (verify only), `infra/envs/{staging,prod}/terraform.tfvars` (required — pin `desired_count = 1` / `enable_autoscaling = false`), `infra/envs/{dev,staging,prod}/main.tf` (verify), `apps/server/Dockerfile`.

## Files Touched

- `apps/server/Dockerfile` **(MODIFY)** — change `EXPOSE 3000 3001` to `EXPOSE 3000`. Update the adjacent comment (`# Expose API and Gateway ports`) to reflect the single unified port.
- `infra/modules/ecs/task-definition.tf` **(MODIFY)** — confirm `portMappings` is 3000-only (leave as-is). Add `stopTimeout = var.stop_timeout` to the base container definition object so a replaced task gets a bounded, drain-sized grace window between `SIGTERM` and `SIGKILL`.
- `infra/modules/ecs/variables.tf` **(MODIFY)** — declare `variable "stop_timeout"` (number, default `30`, documented as the SIGTERM→SIGKILL drain window that must be ≥ the target-group `deregistration_delay`).
- `infra/modules/loadbalancer/main.tf` **(MODIFY)** — replace the literal `deregistration_delay = 30` with `deregistration_delay = var.deregistration_delay`. **Assert unchanged:** `idle_timeout = 3600` on the ALB and the `lb_cookie` stickiness block on the target group (do not touch — they are load-bearing for long sockets).
- `infra/modules/loadbalancer/variables.tf` **(MODIFY)** — declare `variable "deregistration_delay"` (number, default `30`, documented as the ALB drain window for in-flight connections on task deregistration).
- `infra/envs/staging/terraform.tfvars` **(MODIFY — required)** — currently sets `desired_count = 2`; change to `desired_count = 1` (AD-02). `enable_autoscaling` is already `false` here — confirm it stays `false`.
- `infra/envs/prod/terraform.tfvars` **(MODIFY — required)** — currently sets `desired_count = 2` **and** `enable_autoscaling = true`; change to `desired_count = 1` and `enable_autoscaling = false` (AD-02). This is the single-task MVP posture the whole program (and WS-33's single-instance fanout correctness) depends on — prod must not run multi-task/autoscaled.
- `infra/envs/dev/terraform.tfvars` **(VERIFY, do not modify)** — already `desired_count = 1`, `enable_autoscaling = false`. Confirm only.
- `infra/envs/dev/main.tf`, `infra/envs/staging/main.tf`, `infra/envs/prod/main.tf` **(VERIFY / MODIFY only if needed)** — the ecs module blocks wire `desired_count`/`enable_autoscaling` from `var.*` (fed by the tfvars above), so the actual pin lives in the tfvars, not here. Do NOT thread `stop_timeout` / `deregistration_delay` into these files — keep the tuned values centralized in the modules.
- `infra/modules/networking/main.tf` **(VERIFY, do not modify)** — confirm the ECS SG ingress is 3000-from-ALB-only and that no 3001 (or other) app-port ingress exists. If a stray 3001 rule is present, remove it; otherwise leave the file untouched.

## Existing Interfaces to Consume

**ECS task definition — `portMappings` + `healthCheck` today** (`infra/modules/ecs/task-definition.tf`, lines 12–61). Already 3000-only; `stopTimeout` is added to the base object (the `merge(...)` first arg), *not* the conditional `migrate_skip_drift_check` fragment:

```hcl
  container_definitions = jsonencode([
    merge({
      name      = local.name_prefix
      image     = var.image_uri
      essential = true

      portMappings = [
        {
          containerPort = 3000
          protocol      = "tcp"
        }
      ]

      secrets = [
        for key, arn in var.ssm_parameter_arns : {
          name      = key
          valueFrom = arn
        }
      ]

      logConfiguration = { ... }

      healthCheck = {
        command     = ["CMD-SHELL", "curl -f http://localhost:3000/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }
      },
      # migrate_skip_drift_check conditional fragment (leave as-is) ...
      var.migrate_skip_drift_check != "" ? { environment = [ ... ] } : {})
  ])
```

**ECS service — `load_balancer` + `desired_count` + deployment config today** (`infra/modules/ecs/service.tf`, lines 1–44). Single TG, `container_port = 3000`, circuit-breaker rollback on; autoscaling gated off:

```hcl
resource "aws_ecs_service" "this" {
  name            = local.name_prefix
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = var.desired_count      # module default = 1  (AD-02)
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.security_group_id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = var.target_group_arn
    container_name   = local.name_prefix
    container_port   = 3000                # existing single target group
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  ...
}

# Autoscaling resources are all `count = var.enable_autoscaling ? 1 : 0`
# — enable_autoscaling defaults to false; leave it false (AD-02).
```

**Load balancer — ALB idle timeout + target group today** (`infra/modules/loadbalancer/main.tf`, lines 14–58). `idle_timeout = 3600` and `stickiness { type = "lb_cookie" }` are the long-socket guarantees — ASSERT, don't regress. Only `deregistration_delay` is parameterized:

```hcl
resource "aws_lb" "this" {
  name            = "${var.environment}-swiftagent-alb"
  internal        = false
  ...
  idle_timeout    = 3600          # long-lived WebSockets — DO NOT REGRESS
}

resource "aws_lb_target_group" "this" {
  name                 = "${var.environment}-swiftagent-tg"
  port                 = 3000
  protocol             = "HTTP"
  vpc_id               = var.vpc_id
  target_type          = "ip"
  deregistration_delay = 30       # → becomes var.deregistration_delay

  health_check {
    enabled  = true
    path     = var.health_check_path   # /health
    port     = "traffic-port"
    protocol = "HTTP"
    ...
  }

  stickiness {
    type            = "lb_cookie"       # pin a client's socket to its task — KEEP
    enabled         = true
    cookie_duration = 86400
  }
}
```

**Networking — ECS security group ingress today** (`infra/modules/networking/main.tf`, lines 188–214). 3000-from-ALB only; verify no 3001:

```hcl
# ECS Security Group — app traffic from ALB only
resource "aws_security_group" "ecs" {
  name        = "${var.environment}-ecs-sg"
  description = "Allow inbound traffic from ALB on port 3000"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "App port from ALB"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress { ... all outbound ... }
}
```

**Dockerfile — EXPOSE today** (`apps/server/Dockerfile`, lines 73–74). Remove `3001`:

```dockerfile
# Expose API and Gateway ports
EXPOSE 3000 3001
```

## Design Notes

- **This is alignment, not new routing (AD-01).** WS-30 puts REST and WebSocket on one Fastify app on one port. The ALB already has exactly one listener → one target group → port 3000. Therefore the correct realtime routing change on the infra side is **the absence of a change**: no second target group, no path-based listener rule, no new port. The build agent MUST verify — via `terraform plan` — that this workstream introduces **zero** new `aws_lb_target_group` or `aws_lb_listener_rule` resources. If a plan wants to create one, the change is wrong.
- **`idle_timeout = 3600` is the WebSocket lifeline — assert it.** An ALB idle-times-out a connection with no bytes for `idle_timeout` seconds. A mostly-quiet WebSocket (agent thinking, user reading) would be killed at the default 60s. 3600s is already set; this workstream's job is to *guarantee it is not regressed*, not to re-set it. WS-30's app-level heartbeat/ping (if any) is complementary, not a substitute.
- **Stickiness keeps a socket on its task.** With `desired_count = 1` today, stickiness is effectively a no-op (one task), but it is the correct, forward-compatible setting for when Phase-2 scale arrives — a WebSocket, once upgraded on a task, must keep talking to that task. Keep `lb_cookie` enabled; do not remove it "because there's only one task."
- **Drain sizing: `deregistration_delay` ≈ `stopTimeout`, and both cover the app's `1001` close.** On deploy, ECS sends `SIGTERM`; WS-30's handler closes each open socket with code `1001` ("going away") and stops accepting new upgrades. Two independent timers must both be large enough for that to finish: (1) the **target-group `deregistration_delay`** — how long the ALB keeps routing to / draining the task after it's marked for removal; (2) the container **`stopTimeout`** — how long ECS waits after `SIGTERM` before `SIGKILL`. **Decision: both default to 30s.** Rationale: a `1001` close is near-instant per socket; 30s is comfortably longer than a graceful close of all in-flight sockets on a single MVP task, matches the `deregistration_delay = 30` already in the module, and stays well under Fargate's 120s hard `stopTimeout` ceiling. The invariant to preserve: **`stop_timeout` ≥ `deregistration_delay`** so ECS does not `SIGKILL` the task while the ALB is still draining it. Document this invariant in both variable descriptions.
- **`stopTimeout` is a plain container field, not a conditional merge.** Add it directly to the base object inside `merge({ ... })` (alongside `essential`, `portMappings`, `healthCheck`) — unlike `migrate_skip_drift_check`, it is always present. Guard the range in the variable (a `validation` block: `1 ≤ stop_timeout ≤ 120`, Fargate's max).
- **`desired_count = 1` is deliberate (AD-02), and autoscaling stays off — and two envs currently violate this.** The ecs module *defaults* `desired_count` to `1` and gates autoscaling behind `enable_autoscaling = false`, but the env `terraform.tfvars` override those defaults: **staging** sets `desired_count = 2`, and **prod** sets `desired_count = 2` **and** `enable_autoscaling = true`. This workstream MUST correct both tfvars back to `desired_count = 1` / `enable_autoscaling = false` (dev is already correct). This is not a "confirm only" task — it is a required edit to `infra/envs/{staging,prod}/terraform.tfvars`. The stakes are real: WS-33's exactly-once fanout is designed for a **single** instance (local broadcast is authoritative; the Redis path is dormant), so a multi-task/autoscaled prod would break delivery semantics. WS-33 documents the single-node consequence; this workstream sets the posture by pinning the tfvars.
- **Keep tuned values in the modules, not the envs.** Prefer the module-level defaults (`stop_timeout = 30`, `deregistration_delay = 30`) so all three envs inherit identical drain behavior. Only thread a variable up into `infra/envs/*/main.tf` if a specific env genuinely needs a different window — none does for the MVP. This keeps the env compositions thin and avoids per-env drift. (Note: the `desired_count`/`enable_autoscaling` pin above is the exception — those legitimately live in each env's `terraform.tfvars`.)
- **Do not touch the migrate/drift plumbing.** `var.migrate_skip_drift_check` and its conditional `environment` fragment (WS-27) are unrelated; leave them exactly as-is when adding `stopTimeout`.
- **Scope discipline.** Removing `3001` from `EXPOSE` is the *only* Dockerfile change here. The broader Docker build-consistency review (multi-stage layer parity, missing package copies, etc.) is WS-35. The `PUBLIC_WEBSOCKET_URL` SSM parameter and per-env URLs are WS-32 — do not add an SSM param. Redis fanout/health is WS-33.

## Implementation Steps

1. **Confirm the WS-30 dependency is satisfied.** Verify the app binds a single port (3000) and installs a `SIGTERM` handler that closes open WebSockets with code `1001`. Read the WS-30 server bootstrap (e.g. `apps/server/src/main.ts` / built `dist/main.js`) or the WS-30 acceptance criteria. **If the app still binds a separate gateway port (3001), STOP** — WS-30 is incomplete and removing the `3001` exposure would break routing. Report and do not proceed.
2. **Remove the stale port from the Dockerfile.** In `apps/server/Dockerfile`, change `EXPOSE 3000 3001` to `EXPOSE 3000` and update the preceding comment from `# Expose API and Gateway ports` to something like `# Expose the single unified API + WebSocket port`. (`EXPOSE` is documentation only — the functional gate is the SG/port mapping — but a stale second port is misleading and must go for SC-01.)
3. **Confirm the ECS task-def `portMappings` is 3000-only.** In `infra/modules/ecs/task-definition.tf`, verify there is exactly one `portMappings` entry (`containerPort = 3000`). Do not add anything; just confirm. If a 3001 mapping exists, remove it.
4. **Add the container `stopTimeout`.** In `infra/modules/ecs/variables.tf`, declare:
   ```hcl
   variable "stop_timeout" {
     description = <<-EOT
       Seconds ECS waits after SIGTERM before SIGKILL, giving the app time to
       close in-flight WebSockets with code 1001 (see WS-30). MUST be >= the
       target group deregistration_delay so ECS does not kill the task while the
       ALB is still draining it. Fargate hard max is 120s.
     EOT
     type        = number
     default     = 30
     validation {
       condition     = var.stop_timeout >= 1 && var.stop_timeout <= 120
       error_message = "stop_timeout must be between 1 and 120 seconds (Fargate limit)."
     }
   }
   ```
   Then in `task-definition.tf`, add `stopTimeout = var.stop_timeout` to the base container object inside `merge({ ... })` (next to `essential` / `portMappings` / `healthCheck`), leaving the `migrate_skip_drift_check` conditional fragment untouched.
5. **Parameterize the target-group `deregistration_delay`.** In `infra/modules/loadbalancer/variables.tf`, declare:
   ```hcl
   variable "deregistration_delay" {
     description = <<-EOT
       Seconds the ALB keeps draining in-flight connections to a task after it is
       deregistered on deploy, so long-lived WebSockets can close gracefully.
       Should be <= the ECS container stop_timeout (default 30 for both).
     EOT
     type        = number
     default     = 30
   }
   ```
   Then in `loadbalancer/main.tf`, change `deregistration_delay = 30` to `deregistration_delay = var.deregistration_delay`.
6. **Assert the long-socket settings are intact.** Re-read `loadbalancer/main.tf` and confirm `idle_timeout = 3600` on `aws_lb.this` and the `stickiness { type = "lb_cookie", enabled = true }` block on the target group remain unchanged. These are load-bearing; do not touch them. (No code change — an explicit verification.)
7. **Verify the ECS security group is 3000-only.** Read `infra/modules/networking/main.tf` and confirm the `aws_security_group.ecs` ingress is a single 3000-from-ALB rule with no 3001 (or other app port). If a stray rule exists, remove it; otherwise leave the file untouched.
8. **Pin `desired_count = 1` and keep autoscaling off across envs.** The pin lives in each env's `terraform.tfvars` (which feed the `var.desired_count` / `var.enable_autoscaling` the ecs module block consumes), so edit the tfvars, not `main.tf`. Concretely: in `infra/envs/prod/terraform.tfvars` change `desired_count = 2` → `desired_count = 1` and `enable_autoscaling = true` → `enable_autoscaling = false`; in `infra/envs/staging/terraform.tfvars` change `desired_count = 2` → `desired_count = 1` (confirm `enable_autoscaling = false`); confirm `infra/envs/dev/terraform.tfvars` is already `desired_count = 1` / `enable_autoscaling = false` (no change). Do NOT thread `stop_timeout` / `deregistration_delay` into the envs unless an env needs a non-default window (none does).
9. **Format and validate.** Run `terraform fmt` across `infra/`, then `terraform init -backend=false` + `terraform validate` in each of `infra/envs/{dev,staging,prod}`. Fix any errors.
10. **Plan and diff-check.** Run `terraform plan` per env (against the real backend, or with mock vars) and confirm the diff is **only**: the `stopTimeout` addition on the task def, the `deregistration_delay` now sourced from a variable (value unchanged at 30 → likely a no-op diff), and (if any env was wrong) `desired_count → 1`. Confirm **no** new `aws_lb_target_group` and **no** new `aws_lb_listener` / `aws_lb_listener_rule` appear in any plan.
11. **Build the image.** Run `docker build -f apps/server/Dockerfile .` and confirm it succeeds and the built image's `EXPOSE` metadata lists only 3000 (`docker image inspect <id> --format '{{.Config.ExposedPorts}}'`).

## Tests

Terraform and Dockerfiles are not unit-testable; verify with concrete commands.

1. **Terraform format & validate (SC-12).** `terraform fmt -check -recursive infra/` returns clean (no diff). In each of `infra/envs/dev`, `infra/envs/staging`, `infra/envs/prod`: `terraform init -backend=false && terraform validate` succeeds.
2. **Plan shows only intended diffs (SC-05, SC-12).** `terraform plan` per env shows: `+ stopTimeout = 30` on `aws_ecs_task_definition.this`; `deregistration_delay` now `var.deregistration_delay` (value 30, no effective change); and `desired_count` = `1` (a no-op for dev, but a `2 → 1` change for staging and prod, with prod additionally showing `enable_autoscaling` `true → false` and the autoscaling resources being **destroyed**). **Assert absence:** grep the plan output for `aws_lb_target_group` and `aws_lb_listener` creations — there MUST be none (proves AD-01 needs no new routing). `terraform plan | Select-String -Pattern 'aws_lb_target_group|aws_lb_listener_rule'` returns nothing under a "will be created" heading.
3. **Byte-diff the module edits.** `git diff infra/` shows exactly: `deregistration_delay = 30` → `= var.deregistration_delay`; new `stop_timeout` and `deregistration_delay` variable blocks; `stopTimeout = var.stop_timeout` added to the container def; and (only if a fix was needed) `desired_count`/autoscaling normalization in an env. Confirm `idle_timeout = 3600` and the `lb_cookie` stickiness block are **unchanged** in the diff (they should not appear).
4. **Security group unchanged / correct.** `git diff infra/modules/networking/main.tf` is empty (verify-only) unless a stray 3001 rule was removed. Confirm `aws_security_group.ecs` ingress lists only 3000.
5. **Dockerfile single-port (SC-01).** `git diff apps/server/Dockerfile` shows `EXPOSE 3000 3001` → `EXPOSE 3000` (plus the comment update). `docker build -f apps/server/Dockerfile .` succeeds; `docker image inspect <built-image> --format '{{json .Config.ExposedPorts}}'` shows `{"3000/tcp":{}}` and no `3001/tcp`.
6. **Drain-invariant sanity.** Confirm the defaults satisfy `stop_timeout (30) >= deregistration_delay (30)`. If either default is changed, re-verify the invariant holds and both variable descriptions state it.
7. **Manual post-deploy note (deferred to WS-35 smoke).** Record in the PR that a full WebSocket-upgrade-over-ALB check and a deploy-drain check (open a socket, trigger a deploy, observe a `1001` close rather than an abrupt drop) are exercised by WS-35's deploy smoke tests — this workstream's automated verification stops at `plan`/`build` since Terraform is not runtime-testable here.

## Acceptance Criteria

1. `apps/server/Dockerfile` exposes **only** port 3000 (`EXPOSE 3000`), with the comment updated to reflect the unified API + WebSocket port; `docker build` succeeds and the image's `ExposedPorts` metadata contains `3000/tcp` and not `3001/tcp` (SC-01).
2. The ECS task definition `portMappings` maps only `containerPort = 3000`, and the ECS security group ingress permits only 3000 from the ALB — no second app port exists in the container, task def, or SG (SC-01).
3. A new container `stopTimeout` is set from `var.stop_timeout` (default 30, range-validated 1–120) on the base container definition, and the target-group `deregistration_delay` is sourced from `var.deregistration_delay` (default 30); both variable descriptions state the invariant `stop_timeout >= deregistration_delay`, sized so a task's in-flight WebSockets close (code `1001`, per WS-30) before `SIGKILL` (SC-05).
4. The ALB `idle_timeout = 3600` and the target-group `lb_cookie` stickiness block are **preserved unchanged** (asserted via `git diff` not touching them), guaranteeing long-lived sockets are neither idle-timed-out nor unpinned (SC-05).
5. `desired_count` resolves to `1` and `enable_autoscaling` is `false` in dev, staging, and prod — including correcting staging (`desired_count 2 → 1`) and prod (`desired_count 2 → 1`, `enable_autoscaling true → false`) in their `terraform.tfvars`; no autoscaling resource remains (single-task MVP posture, AD-02 / contributes SC-07).
6. `terraform plan` for every env introduces **no** new `aws_lb_target_group` and **no** new `aws_lb_listener` / `aws_lb_listener_rule` — the single existing target group on port 3000 continues to route both REST and `/v1/stream` (AD-01, SC-01).
7. `terraform fmt -check -recursive` is clean and `terraform validate` passes for all three env compositions; each `terraform plan` shows only the intended diffs (SC-12).
8. Scope is respected: no SSM `PUBLIC_WEBSOCKET_URL` parameter (WS-32), no Redis changes (WS-33), no app-side merge/drain code (WS-30), and no Docker changes beyond removing the stale `3001` (WS-35).
