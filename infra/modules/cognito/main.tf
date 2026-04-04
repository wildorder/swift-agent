data "aws_region" "current" {}

# ------------------------------------------------------------------------------
# User Pool
# ------------------------------------------------------------------------------

resource "aws_cognito_user_pool" "main" {
  name = "swiftagent-${var.environment}"

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length                   = 8
    require_uppercase                = true
    require_lowercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 7
  }

  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
  }

  schema {
    name                     = "email"
    attribute_data_type      = "String"
    required                 = true
    mutable                  = true
    developer_only_attribute = false

    string_attribute_constraints {
      min_length = 1
      max_length = 256
    }
  }

  tags = {
    Environment = var.environment
  }
}

# ------------------------------------------------------------------------------
# App Client (public SPA — no client secret, PKCE required)
# ------------------------------------------------------------------------------

resource "aws_cognito_user_pool_client" "main" {
  name         = "swiftagent-${var.environment}-client"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret = false

  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]

  supported_identity_providers = ["COGNITO"]

  callback_urls = var.callback_urls
  logout_urls   = var.logout_urls

  explicit_auth_flows = [
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_USER_SRP_AUTH",
  ]
}

# ------------------------------------------------------------------------------
# Hosted Domain
# ------------------------------------------------------------------------------

resource "aws_cognito_user_pool_domain" "main" {
  domain       = var.domain_prefix
  user_pool_id = aws_cognito_user_pool.main.id
}

# ------------------------------------------------------------------------------
# Computed OIDC values
# ------------------------------------------------------------------------------

locals {
  issuer_url = "https://cognito-idp.${data.aws_region.current.name}.amazonaws.com/${aws_cognito_user_pool.main.id}"
  jwks_uri   = "${local.issuer_url}/.well-known/jwks.json"
}

# ------------------------------------------------------------------------------
# SSM Parameters
# ------------------------------------------------------------------------------

resource "aws_ssm_parameter" "user_pool_id" {
  name  = "/${var.environment}/swiftagent/COGNITO_USER_POOL_ID"
  type  = "String"
  value = aws_cognito_user_pool.main.id

  tags = {
    Environment = var.environment
  }
}

resource "aws_ssm_parameter" "issuer_url" {
  name  = "/${var.environment}/swiftagent/COGNITO_ISSUER_URL"
  type  = "String"
  value = local.issuer_url

  tags = {
    Environment = var.environment
  }
}

resource "aws_ssm_parameter" "client_id" {
  name  = "/${var.environment}/swiftagent/COGNITO_CLIENT_ID"
  type  = "String"
  value = aws_cognito_user_pool_client.main.id

  tags = {
    Environment = var.environment
  }
}

# ------------------------------------------------------------------------------
# Locals — canonical map of parameter ARNs and names
# ------------------------------------------------------------------------------

locals {
  parameter_arns = {
    COGNITO_USER_POOL_ID = aws_ssm_parameter.user_pool_id.arn
    COGNITO_ISSUER_URL   = aws_ssm_parameter.issuer_url.arn
    COGNITO_CLIENT_ID    = aws_ssm_parameter.client_id.arn
  }

  parameter_names = {
    COGNITO_USER_POOL_ID = aws_ssm_parameter.user_pool_id.name
    COGNITO_ISSUER_URL   = aws_ssm_parameter.issuer_url.name
    COGNITO_CLIENT_ID    = aws_ssm_parameter.client_id.name
  }
}
