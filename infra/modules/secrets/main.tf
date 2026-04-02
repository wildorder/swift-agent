terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.0"
    }
  }
}

# --------------------------------------------------------------------------
# JWT secret — generated once, stored in SSM
# --------------------------------------------------------------------------

resource "random_password" "jwt_secret" {
  length           = 64
  special          = true
  override_special = "!#$%&*()-_=+[]{}|:?"
}

# --------------------------------------------------------------------------
# SSM Parameters (SecureString)
# --------------------------------------------------------------------------

resource "aws_ssm_parameter" "database_url" {
  name  = "/${var.environment}/swiftagent/DATABASE_URL"
  type  = "SecureString"
  value = var.database_url

  tags = {
    Environment = var.environment
  }
}

resource "aws_ssm_parameter" "redis_url" {
  name  = "/${var.environment}/swiftagent/REDIS_URL"
  type  = "SecureString"
  value = var.redis_url

  tags = {
    Environment = var.environment
  }
}

resource "aws_ssm_parameter" "jwt_secret" {
  name  = "/${var.environment}/swiftagent/CLIENT_JWT_SECRET"
  type  = "SecureString"
  value = random_password.jwt_secret.result

  tags = {
    Environment = var.environment
  }
}

resource "aws_ssm_parameter" "openai_api_key" {
  name  = "/${var.environment}/swiftagent/OPENAI_API_KEY"
  type  = "SecureString"
  value = "PLACEHOLDER"

  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    Environment = var.environment
  }
}

resource "aws_ssm_parameter" "anthropic_api_key" {
  name  = "/${var.environment}/swiftagent/ANTHROPIC_API_KEY"
  type  = "SecureString"
  value = "PLACEHOLDER"

  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    Environment = var.environment
  }
}

resource "aws_ssm_parameter" "google_api_key" {
  name  = "/${var.environment}/swiftagent/GOOGLE_API_KEY"
  type  = "SecureString"
  value = "PLACEHOLDER"

  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    Environment = var.environment
  }
}

# --------------------------------------------------------------------------
# Locals — canonical map of all parameter ARNs and names
# --------------------------------------------------------------------------

locals {
  parameter_arns = {
    DATABASE_URL       = aws_ssm_parameter.database_url.arn
    REDIS_URL          = aws_ssm_parameter.redis_url.arn
    CLIENT_JWT_SECRET  = aws_ssm_parameter.jwt_secret.arn
    OPENAI_API_KEY     = aws_ssm_parameter.openai_api_key.arn
    ANTHROPIC_API_KEY  = aws_ssm_parameter.anthropic_api_key.arn
    GOOGLE_API_KEY     = aws_ssm_parameter.google_api_key.arn
  }

  parameter_names = {
    DATABASE_URL       = aws_ssm_parameter.database_url.name
    REDIS_URL          = aws_ssm_parameter.redis_url.name
    CLIENT_JWT_SECRET  = aws_ssm_parameter.jwt_secret.name
    OPENAI_API_KEY     = aws_ssm_parameter.openai_api_key.name
    ANTHROPIC_API_KEY  = aws_ssm_parameter.anthropic_api_key.name
    GOOGLE_API_KEY     = aws_ssm_parameter.google_api_key.name
  }
}
