# WS-13a: Terraform Foundation & Data Infrastructure

## Goal

Provision the foundational AWS infrastructure using Terraform modules: VPC networking, RDS PostgreSQL, ElastiCache Redis, ECR container registry, SSM secrets management, provider/backend configuration, and IAM roles. These resources exist independently of the application layer and must be stable before ECS, ALB, and deploy workflows are built in WS-13b.

## Dependencies

- WS-12

## Package

`infra/modules/` (networking, database, cache, ecr, secrets), `infra/versions.tf`

## Files Touched

- `infra/versions.tf`
- `infra/modules/networking/main.tf`
- `infra/modules/networking/variables.tf`
- `infra/modules/networking/outputs.tf`
- `infra/modules/database/main.tf`
- `infra/modules/database/variables.tf`
- `infra/modules/database/outputs.tf`
- `infra/modules/cache/main.tf`
- `infra/modules/cache/variables.tf`
- `infra/modules/cache/outputs.tf`
- `infra/modules/ecr/main.tf`
- `infra/modules/ecr/variables.tf`
- `infra/modules/ecr/outputs.tf`
- `infra/modules/secrets/main.tf`
- `infra/modules/secrets/variables.tf`
- `infra/modules/secrets/outputs.tf`

## Implementation Steps

1. **Provider and version pins (`versions.tf`)**: Pin `hashicorp/aws` provider to a stable version (e.g., `~> 5.0`). Set `required_version` for Terraform CLI (`>= 1.5`). Document the expected AWS region (parameterized via variable, default `us-east-1`).

2. **Networking module (`modules/networking/`)**:
   - **Variables**: `environment` (string), `vpc_cidr` (default `10.0.0.0/16`), `availability_zones` (list, default 2), `nat_gateway_count` (1 for dev/staging, 2 for prod).
   - **Resources**: VPC with DNS support enabled. 2 public subnets (for ALB) across AZs. 2 private subnets (for ECS, RDS, ElastiCache) across AZs. Internet Gateway attached to VPC. NAT Gateway(s) in public subnets with Elastic IPs. Route tables: public routes through IGW, private routes through NAT.
   - **Security groups**:
     - `alb-sg`: Inbound 443 and 80 from `0.0.0.0/0`.
     - `ecs-sg`: Inbound container port (3000) from `alb-sg` only.
     - `db-sg`: Inbound 5432 from `ecs-sg` only.
     - `redis-sg`: Inbound 6379 from `ecs-sg` only.
   - **Outputs**: `vpc_id`, `public_subnet_ids`, `private_subnet_ids`, `alb_security_group_id`, `ecs_security_group_id`, `db_security_group_id`, `redis_security_group_id`.

3. **Database module (`modules/database/`)**:
   - **Variables**: `environment`, `instance_class` (string), `allocated_storage` (number), `max_allocated_storage`, `multi_az` (bool), `backup_retention_period` (number), `private_subnet_ids` (list), `security_group_id`, `db_name` (default `swiftagent`).
   - **Resources**: DB subnet group from private subnets. RDS PostgreSQL 16 instance with `instance_class`, gp3 storage, automated backups, encryption at rest (default KMS key). Master username `swiftagent_admin`, password generated via `random_password` resource and stored in SSM.
   - **Outputs**: `endpoint`, `port`, `database_name`, `master_username_ssm_arn`, `master_password_ssm_arn`, `connection_string_ssm_arn` (constructed `postgresql://...` stored in SSM).

4. **Cache module (`modules/cache/`)**:
   - **Variables**: `environment`, `node_type` (string), `num_cache_nodes` (number), `private_subnet_ids`, `security_group_id`.
   - **Resources**: ElastiCache subnet group. Redis 7 replication group with `automatic_failover_enabled` when `num_cache_nodes > 1`. Transit encryption enabled.
   - **Outputs**: `primary_endpoint`, `port`, `connection_string` (constructed `redis://...`).

5. **ECR module (`modules/ecr/`)**:
   - **Variables**: `repository_name` (default `swiftagent/server`).
   - **Resources**: ECR repository with image scanning on push. Lifecycle policy: keep last 20 `dev-*` tags, last 10 `staging-*` tags, all `prod-*` and semver tags, expire untagged after 7 days.
   - **Outputs**: `repository_url`, `repository_arn`.

6. **Secrets module (`modules/secrets/`)**:
   - **Variables**: `environment`, `database_url` (from database module output), `redis_url` (from cache module output).
   - **Resources**: SSM Parameter Store entries (SecureString, KMS-encrypted):
     - `/${environment}/swiftagent/DATABASE_URL` — value from database module.
     - `/${environment}/swiftagent/REDIS_URL` — value from cache module.
     - `/${environment}/swiftagent/CLIENT_JWT_SECRET` — generated via `random_password` (64 chars).
     - `/${environment}/swiftagent/OPENAI_API_KEY` — empty placeholder, `lifecycle { ignore_changes = [value] }` so manual updates persist.
     - `/${environment}/swiftagent/ANTHROPIC_API_KEY` — same pattern.
     - `/${environment}/swiftagent/GOOGLE_API_KEY` — same pattern.
   - **Outputs**: Map of SSM parameter ARNs (used by ECS task role in WS-13b).

7. **IAM foundations**: Define the ECS task execution role and deploy roles here since they need SSM and ECR ARNs:
   - `ecs-task-execution-role`: Trust policy for `ecs-tasks.amazonaws.com`. Policies: SSM GetParameters for `/${environment}/swiftagent/*`, CloudWatch Logs, ECR pull.
   - `ecs-task-role`: Minimal — no extra permissions for MVP (the app itself doesn't call AWS APIs).
   - GitHub OIDC provider resource (if not already existing) — `token.actions.githubusercontent.com`.
   - Deploy roles (`swiftagent-deploy-{env}`) with trust policies scoped to specific branches: dev → `refs/heads/dev`, staging → `refs/heads/staging`, prod → `refs/heads/main` + `refs/tags/v*`. Policies: ECR push, ECS UpdateService, ECS RunTask, S3 state bucket, DynamoDB lock table, RDS CreateDBSnapshot (prod only).
   - **Outputs**: Role ARNs for ECS tasks and deploy workflows.

## Tests

1. `terraform validate` passes for each module individually.
2. `terraform plan` on a composition using all modules shows expected resource counts: 1 VPC, 4 subnets, 1+ NAT gateways, 4 security groups, 1 RDS instance, 1 ElastiCache cluster, 1 ECR repo, 6+ SSM parameters, 3+ IAM roles.
3. Security group rules are correct: DB only reachable from ECS SG, Redis only reachable from ECS SG, ALB open to internet on 443/80 only.
4. RDS is in private subnets (no `publicly_accessible`).
5. ElastiCache is in private subnets with transit encryption.
6. ECR lifecycle policy retains expected tag patterns.
7. SSM parameters for model API keys have `ignore_changes` on value.
8. Deploy IAM roles have branch-scoped trust policies.

## Acceptance Criteria

1. All modules pass `terraform validate` and produce expected resources on `terraform plan`.
2. VPC networking isolates data stores in private subnets; only the ALB security group is internet-facing.
3. RDS credentials are generated by Terraform and stored in SSM — never in `.tfvars` or state output.
4. ElastiCache is encrypted in transit and accessible only from ECS security group.
5. ECR repository exists with lifecycle policies for tag retention.
6. SSM parameters cover all env vars from `@swiftagent/shared` `ENV_KEYS`; model API key placeholders are manually updatable without Terraform overwrite.
7. IAM roles follow least privilege: ECS tasks can only read SSM + write logs, deploy roles are branch-scoped.
