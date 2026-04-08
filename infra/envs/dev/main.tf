terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = "swiftagent"
      ManagedBy = "terraform"
    }
  }
}

# -----------------------------------------------------------------------------
# Variables
# -----------------------------------------------------------------------------

variable "aws_region" {
  type = string
}

variable "environment" {
  type = string
}

variable "db_instance_class" {
  type = string
}

variable "cache_node_type" {
  type = string
}

variable "num_cache_nodes" {
  type    = number
  default = 1
}

variable "cpu" {
  type = number
}

variable "memory" {
  type = number
}

variable "desired_count" {
  type = number
}

variable "nat_gateway_count" {
  type    = number
  default = 1
}

variable "multi_az" {
  type    = bool
  default = false
}

variable "backup_retention_period" {
  type    = number
  default = 7
}

variable "enable_autoscaling" {
  type    = bool
  default = false
}

variable "autoscaling_min" {
  type    = number
  default = 1
}

variable "autoscaling_max" {
  type    = number
  default = 10
}

variable "autoscaling_cpu_target" {
  type    = number
  default = 70
}

variable "domain_prefix" {
  type = string
}

variable "image_uri" {
  type        = string
  default     = ""
  description = "Container image URI - set by CI/CD pipeline"
}

variable "state_bucket_arn" {
  type        = string
  description = "ARN of S3 terraform state bucket"
}

variable "lock_table_arn" {
  type        = string
  description = "ARN of DynamoDB lock table"
}

variable "cognito_domain_prefix" {
  type        = string
  description = "Cognito hosted UI domain prefix (globally unique within region)"
}

variable "cognito_callback_urls" {
  type        = list(string)
  description = "OAuth callback URLs for the Cognito app client"
  default     = ["http://localhost:3000/callback"]
}

variable "cognito_logout_urls" {
  type        = list(string)
  description = "OAuth logout URLs for the Cognito app client"
  default     = ["http://localhost:3000/logout"]
}

# -----------------------------------------------------------------------------
# Modules
# -----------------------------------------------------------------------------

module "networking" {
  source = "../../modules/networking"

  environment       = var.environment
  nat_gateway_count = var.nat_gateway_count
}

module "database" {
  source = "../../modules/database"

  environment             = var.environment
  instance_class          = var.db_instance_class
  multi_az                = var.multi_az
  backup_retention_period = var.backup_retention_period
  private_subnet_ids      = module.networking.private_subnet_ids
  security_group_id       = module.networking.db_security_group_id
}

module "cache" {
  source = "../../modules/cache"

  environment        = var.environment
  node_type          = var.cache_node_type
  num_cache_nodes    = var.num_cache_nodes
  private_subnet_ids = module.networking.private_subnet_ids
  security_group_id  = module.networking.redis_security_group_id
}

module "ecr" {
  source = "../../modules/ecr"
}

module "secrets" {
  source = "../../modules/secrets"

  environment  = var.environment
  database_url = module.database.connection_string
  redis_url    = module.cache.connection_string
}

module "cognito" {
  source = "../../modules/cognito"

  environment   = var.environment
  domain_prefix = var.cognito_domain_prefix
  callback_urls = var.cognito_callback_urls
  logout_urls   = var.cognito_logout_urls
}

module "iam" {
  source = "../../modules/iam"

  environment          = var.environment
  ssm_parameter_arns   = values(merge(module.secrets.parameter_arns, module.cognito.parameter_arns))
  ecr_repository_arn   = module.ecr.repository_arn
  state_bucket_arn     = var.state_bucket_arn
  lock_table_arn       = var.lock_table_arn
}

module "dns" {
  source = "../../modules/dns"

  environment   = var.environment
  create_zone   = true
  domain_prefix = var.domain_prefix
  alb_dns_name  = module.loadbalancer.alb_dns_name
  alb_zone_id   = module.loadbalancer.alb_zone_id
}

module "loadbalancer" {
  source = "../../modules/loadbalancer"

  environment       = var.environment
  public_subnet_ids = module.networking.public_subnet_ids
  security_group_id = module.networking.alb_security_group_id
  vpc_id            = module.networking.vpc_id
  certificate_arn   = module.dns.certificate_arn
}

module "ecs" {
  source = "../../modules/ecs"

  environment             = var.environment
  cluster_name            = "${var.environment}-swiftagent"
  image_uri               = var.image_uri
  cpu                     = var.cpu
  memory                  = var.memory
  desired_count           = var.desired_count
  private_subnet_ids      = module.networking.private_subnet_ids
  security_group_id       = module.networking.ecs_security_group_id
  target_group_arn        = module.loadbalancer.target_group_arn
  task_execution_role_arn = module.iam.ecs_task_execution_role_arn
  task_role_arn           = module.iam.ecs_task_role_arn
  ssm_parameter_arns      = merge(module.secrets.parameter_arns, module.cognito.parameter_arns)
  log_group_name          = "/ecs/${var.environment}-swiftagent"
  enable_autoscaling      = var.enable_autoscaling
  autoscaling_min         = var.autoscaling_min
  autoscaling_max         = var.autoscaling_max
  autoscaling_cpu_target  = var.autoscaling_cpu_target
  alb_arn_suffix          = module.loadbalancer.alb_arn_suffix
  target_group_arn_suffix = module.loadbalancer.target_group_arn_suffix
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------

output "vpc_id" {
  value = module.networking.vpc_id
}

output "ecr_repository_url" {
  value = module.ecr.repository_url
}

output "alb_dns_name" {
  value = module.loadbalancer.alb_dns_name
}

output "domain_name" {
  value = module.dns.domain_name
}

output "ecs_service_name" {
  value = module.ecs.service_name
}

output "ecs_cluster_name" {
  value = module.ecs.cluster_name
}

output "route53_zone_id" {
  value = module.dns.zone_id
}

output "route53_name_servers" {
  description = "Configure these NS records at your domain registrar"
  value       = module.dns.name_servers
}
