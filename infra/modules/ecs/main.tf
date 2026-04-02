terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

locals {
  name_prefix = "${var.environment}-swiftagent"

  tags = {
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

resource "aws_ecs_cluster" "this" {
  name = local.name_prefix

  tags = local.tags
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/${local.name_prefix}"
  retention_in_days = 30

  tags = local.tags
}
