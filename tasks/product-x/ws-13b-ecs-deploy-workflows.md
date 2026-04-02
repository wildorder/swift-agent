# WS-13b: ECS, Load Balancer, DNS & Deploy Workflows

## Goal

Build the application-facing AWS infrastructure (ECS Fargate, ALB, Route 53 DNS, ACM certificates), compose all Terraform modules into per-environment stacks (dev, staging, prod), and implement the GitHub Actions deployment workflows that build/push/migrate/deploy on the branch promotion chain.

## Dependencies

- WS-11
- WS-12
- WS-13a

## Package

`infra/modules/` (ecs, loadbalancer, dns), `infra/envs/`, `.github/workflows/deploy-*.yml`, `infra/migrate.sh`

## Files Touched

- `infra/modules/ecs/main.tf`
- `infra/modules/ecs/variables.tf`
- `infra/modules/ecs/outputs.tf`
- `infra/modules/ecs/task-definition.tf`
- `infra/modules/ecs/service.tf`
- `infra/modules/loadbalancer/main.tf`
- `infra/modules/loadbalancer/variables.tf`
- `infra/modules/loadbalancer/outputs.tf`
- `infra/modules/dns/main.tf`
- `infra/modules/dns/variables.tf`
- `infra/modules/dns/outputs.tf`
- `infra/envs/dev/main.tf`
- `infra/envs/dev/terraform.tfvars`
- `infra/envs/dev/backend.tf`
- `infra/envs/staging/main.tf`
- `infra/envs/staging/terraform.tfvars`
- `infra/envs/staging/backend.tf`
- `infra/envs/prod/main.tf`
- `infra/envs/prod/terraform.tfvars`
- `infra/envs/prod/backend.tf`
- `infra/migrate.sh`
- `.github/workflows/deploy-dev.yml`
- `.github/workflows/deploy-staging.yml`
- `.github/workflows/deploy-prod.yml`
- `.github/workflows/infra-plan.yml`

## Implementation Steps

### Part A: Application Modules

1. **ECS module (`modules/ecs/`)**:
   - **Variables**: `environment`, `cluster_name`, `image_uri` (ECR URL + tag), `cpu` (number), `memory` (number), `desired_count`, `private_subnet_ids`, `security_group_id`, `target_group_arn`, `task_execution_role_arn`, `task_role_arn`, `ssm_parameter_arns` (map), `log_group_name`, `enable_autoscaling` (bool), `autoscaling_min`/`max`/`cpu_target`.
   - **Task definition** (`task-definition.tf`): Fargate-compatible. Container definition: image, port 3000, `secrets` block mapping SSM parameters to env vars (DATABASE_URL, REDIS_URL, CLIENT_JWT_SECRET, model API keys, PUBLIC_WEBSOCKET_URL). Log configuration: `awslogs` driver to CloudWatch. Health check: `CMD-SHELL curl -f http://localhost:3000/health || exit 1`, interval 30s, retries 3.
   - **Service** (`service.tf`): ECS service with Fargate launch type. Network configuration: private subnets, security group, assign public IP false. Load balancer: target group attachment. Deployment configuration: rolling update, min healthy 100%, max 200%. Circuit breaker enabled with rollback. Platform version `LATEST`.
   - **Auto-scaling** (conditional on `enable_autoscaling`): App Auto Scaling target on ECS service. Target tracking policies: CPU utilization at 70%, ALB request count per target.
   - **Outputs**: `service_name`, `cluster_name`, `cluster_arn`, `task_definition_arn`.

2. **Load balancer module (`modules/loadbalancer/`)**:
   - **Variables**: `environment`, `public_subnet_ids`, `security_group_id`, `vpc_id`, `certificate_arn`, `health_check_path` (default `/health`).
   - **Resources**: ALB in public subnets with security group. **Idle timeout: 3600 seconds** (1 hour) — critical for long-lived WebSocket connections. Target group: protocol HTTP, port 3000, health check on `health_check_path`, healthy threshold 2, unhealthy threshold 3, interval 30s, deregistration delay 30s. HTTPS listener on 443 with ACM certificate, forwards to target group. HTTP listener on 80, redirects to HTTPS.
   - **Outputs**: `alb_dns_name`, `alb_arn`, `target_group_arn`, `listener_arn`.

3. **DNS module (`modules/dns/`)**:
   - **Variables**: `environment`, `zone_id` (pre-existing Route 53 hosted zone), `domain_prefix` (e.g., `dev-api`, `staging-api`, `api`), `alb_dns_name`, `alb_zone_id`.
   - **Resources**: ACM certificate for the domain with DNS validation. Route 53 validation records for ACM. Route 53 A record alias pointing `{domain_prefix}.swiftagent.dev` to ALB.
   - **Outputs**: `domain_name`, `certificate_arn`.

### Part B: Environment Compositions

4. **Backend configs (`envs/*/backend.tf`)**: Each environment stores state in S3 with DynamoDB locking:
   - `s3://swiftagent-terraform-state/{env}/terraform.tfstate`
   - Lock table: `swiftagent-terraform-locks`
   - Region: same as infrastructure
   - Document one-time bootstrap: create S3 bucket (versioned, encrypted) and DynamoDB table manually.

5. **Dev composition (`envs/dev/`)**:
   - `main.tf` calls all modules (networking, database, cache, ecr, secrets, ecs, loadbalancer, dns) wiring outputs → inputs.
   - `terraform.tfvars`: `environment = "dev"`, `instance_class = "db.t4g.micro"`, `node_type = "cache.t4g.micro"`, `cpu = 256`, `memory = 512`, `desired_count = 1`, `nat_gateway_count = 1`, `multi_az = false`, `backup_retention_period = 7`, `enable_autoscaling = false`, `domain_prefix = "dev-api"`.

6. **Staging composition (`envs/staging/`)**: Same structure as dev with `terraform.tfvars`: `instance_class = "db.t4g.small"`, `node_type = "cache.t4g.small"`, `cpu = 512`, `memory = 1024`, `desired_count = 2`, `multi_az = false`, `backup_retention_period = 14`, `enable_autoscaling = false`, `domain_prefix = "staging-api"`.

7. **Prod composition (`envs/prod/`)**: `instance_class = "db.t4g.medium"`, `node_type = "cache.t4g.medium"`, `num_cache_nodes = 2`, `cpu = 1024`, `memory = 2048`, `desired_count = 2`, `nat_gateway_count = 2`, `multi_az = true`, `backup_retention_period = 30`, `enable_autoscaling = true`, `autoscaling_min = 2`, `autoscaling_max = 10`, `domain_prefix = "api"`.

### Part C: Deploy Workflows

8. **Infrastructure plan (`.github/workflows/infra-plan.yml`)**: Triggers on PRs modifying `infra/**`. For each environment with changes: authenticate via OIDC, `terraform init`, `terraform plan`, post plan output as PR comment using `actions/github-script`. No auto-apply.

9. **Deploy to dev (`.github/workflows/deploy-dev.yml`)**: Triggers on push to `dev` branch:
   - Authenticate via OIDC → `swiftagent-deploy-dev` role.
   - Login to ECR.
   - Build Docker image (from WS-12 Dockerfile), tag `{ecr-url}:dev-{sha}`.
   - Push to ECR.
   - `terraform apply -auto-approve -var="image_uri={ecr-url}:dev-{sha}"` in `infra/envs/dev/`.
   - `aws ecs wait services-stable --cluster swiftagent-dev --service swiftagent-dev`.
   - Run migration via ECS RunTask: launch ephemeral Fargate task with command override `["node", "dist/migrate.js"]`, same network config as service, wait for completion.
   - Smoke test: `curl -sf https://dev-api.swiftagent.dev/health | jq .status` — assert `"ok"`.
   - On failure: ECS circuit breaker auto-rolls back.
   - Optional: post to Slack webhook.

10. **Deploy to staging (`.github/workflows/deploy-staging.yml`)**: Triggers on push to `staging`. Same as dev with: `staging-{sha}` tag, `swiftagent-deploy-staging` role, `infra/envs/staging/`, smoke test against `staging-api.swiftagent.dev`.

11. **Deploy to prod (`.github/workflows/deploy-prod.yml`)**: Triggers on push to `main` OR GitHub Release. Same as staging with: `prod-{sha}` tag (plus semver tag from release), `swiftagent-deploy-prod` role, `infra/envs/prod/`. **Pre-migration**: `aws rds create-db-snapshot` before running migrations. Smoke test against `api.swiftagent.dev`. Post deployment notification.

12. **Migration script (`infra/migrate.sh`)**: Shell script for ECS RunTask migration:
    - Verify DB connectivity: `node -e "require('pg').Pool({connectionString: process.env.DATABASE_URL}).query('SELECT 1')"` or equivalent.
    - Run `node dist/migrate.js` (Drizzle migration entry point from `@swiftagent/db`).
    - Exit non-zero on failure to halt deployment.
    - Document manual rollback: revert ECS to previous task definition, restore RDS from snapshot if needed.

## Tests

1. `terraform validate` passes for all three environment compositions.
2. `terraform plan` for dev shows expected: ECS cluster, service, task definition, ALB, target group, listeners, DNS record, ACM cert.
3. ALB idle timeout is 3600s (verify in plan output).
4. ECS task definition injects SSM parameters as environment variable secrets.
5. ECS service has circuit breaker enabled in plan output.
6. Prod composition enables autoscaling and multi-AZ RDS (verify in plan diff vs dev).
7. Deploy-dev workflow completes end-to-end: push → ECR → terraform apply → ECS stable → migration → smoke test.
8. Deploy-staging and deploy-prod follow same flow with correct environment targeting.
9. Infra-plan workflow posts plan output as PR comment without applying.
10. OIDC roles are branch-scoped (dev role can't deploy to staging/prod).
11. Pre-deploy RDS snapshot is created before prod migrations.

## Acceptance Criteria

1. All three environments provisionable via `terraform apply` from `infra/envs/{env}/`.
2. Push to `dev` builds, pushes, migrates, and deploys within 10 minutes with smoke test.
3. PR merge to `staging` triggers staging deployment.
4. PR merge to `main` (or Release) triggers prod deployment with pre-migration RDS snapshot.
5. WebSocket connections work through ALB with 1-hour idle timeout.
6. Database and Redis in private subnets — not internet-accessible.
7. No long-lived AWS credentials: OIDC only.
8. ECS circuit breaker rolls back failed deployments automatically.
9. Infrastructure changes reviewed via `terraform plan` on PRs.
10. Environments are fully isolated: separate VPCs, RDS, ElastiCache, ECS clusters.
