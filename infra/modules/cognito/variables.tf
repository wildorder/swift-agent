variable "environment" {
  description = "Deployment environment (dev, staging, prod)"
  type        = string
}

variable "callback_urls" {
  description = "List of allowed OAuth callback URLs (e.g. [\"https://app.example.com/callback\"])"
  type        = list(string)
}

variable "logout_urls" {
  description = "List of allowed OAuth logout/sign-out URLs (e.g. [\"https://app.example.com/logout\"])"
  type        = list(string)
}

variable "domain_prefix" {
  description = "Cognito hosted UI domain prefix — must be globally unique within the region. Creates https://{prefix}.auth.{region}.amazoncognito.com"
  type        = string
}
