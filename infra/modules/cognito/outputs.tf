output "user_pool_id" {
  description = "Cognito User Pool ID"
  value       = aws_cognito_user_pool.main.id
}

output "issuer_url" {
  description = "OIDC issuer URL for JWT validation"
  value       = local.issuer_url
}

output "jwks_uri" {
  description = "JWKS endpoint for JWT signature verification"
  value       = local.jwks_uri
}

output "app_client_id" {
  description = "Cognito App Client ID"
  value       = aws_cognito_user_pool_client.main.id
}

output "parameter_arns" {
  description = "Map of Cognito SSM parameter name to ARN — merge with module.secrets.parameter_arns"
  value       = local.parameter_arns
}

output "site_parameter_arns" {
  description = "Map of site-specific Cognito SSM parameter name to ARN (client secret, domain)"
  value       = local.site_parameter_arns
}

output "parameter_names" {
  description = "Map of Cognito SSM parameter name to path"
  value       = local.parameter_names
}
