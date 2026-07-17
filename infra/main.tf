################################################################################
# Root composition — wires all foundation modules together
################################################################################

variable "environment" {
  description = "Deployment environment (dev, staging, prod)"
  type        = string
}

variable "db_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t3.micro"
}

variable "cache_node_type" {
  description = "ElastiCache node type"
  type        = string
  default     = "cache.t3.micro"
}

variable "state_bucket_arn" {
  description = "ARN of the S3 Terraform state bucket"
  type        = string
}

variable "lock_table_arn" {
  description = "ARN of the DynamoDB lock table"
  type        = string
}

# ------------------------------------------------------------------------------
# Networking
# ------------------------------------------------------------------------------

module "networking" {
  source = "./modules/networking"

  environment       = var.environment
  nat_gateway_count = var.environment == "prod" ? 2 : 1
}

# ------------------------------------------------------------------------------
# Database (RDS PostgreSQL)
# ------------------------------------------------------------------------------

module "database" {
  source = "./modules/database"

  environment        = var.environment
  instance_class     = var.db_instance_class
  multi_az           = var.environment == "prod"
  private_subnet_ids = module.networking.private_subnet_ids
  security_group_id  = module.networking.db_security_group_id
}

# ------------------------------------------------------------------------------
# Cache (ElastiCache Redis)
# ------------------------------------------------------------------------------

module "cache" {
  source = "./modules/cache"

  environment        = var.environment
  node_type          = var.cache_node_type
  num_cache_nodes    = var.environment == "prod" ? 2 : 1
  private_subnet_ids = module.networking.private_subnet_ids
  security_group_id  = module.networking.redis_security_group_id
}

# ------------------------------------------------------------------------------
# ECR (Container Registry)
# ------------------------------------------------------------------------------

module "ecr" {
  source = "./modules/ecr"
}

# ------------------------------------------------------------------------------
# Secrets (SSM Parameter Store)
# ------------------------------------------------------------------------------

module "secrets" {
  source = "./modules/secrets"

  environment  = var.environment
  database_url = module.database.connection_string
  redis_url    = module.cache.connection_string
}

# ------------------------------------------------------------------------------
# IAM (ECS Roles, Deploy Roles, GitHub OIDC)
# ------------------------------------------------------------------------------

module "iam" {
  source = "./modules/iam"

  environment        = var.environment
  ssm_parameter_arns = values(module.secrets.parameter_arns)
  ecr_repository_arn = module.ecr.repository_arn
  state_bucket_arn   = var.state_bucket_arn
  lock_table_arn     = var.lock_table_arn
}

# ------------------------------------------------------------------------------
# Root Outputs
# ------------------------------------------------------------------------------

output "vpc_id" {
  value = module.networking.vpc_id
}

output "ecr_repository_url" {
  value = module.ecr.repository_url
}

output "ecs_task_execution_role_arn" {
  value = module.iam.ecs_task_execution_role_arn
}

output "ecs_task_role_arn" {
  value = module.iam.ecs_task_role_arn
}

output "deploy_role_arns" {
  value = module.iam.deploy_role_arns
}
