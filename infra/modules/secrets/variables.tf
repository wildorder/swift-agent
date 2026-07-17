variable "environment" {
  description = "Deployment environment (e.g. dev, staging, prod)"
  type        = string
}

variable "database_url" {
  description = "Database connection string from database module"
  type        = string
  sensitive   = true
}

variable "redis_url" {
  description = "Redis connection string from cache module"
  type        = string
  sensitive   = true
}

variable "public_websocket_url" {
  description = "Public wss:// base URL up to and including /v1/stream (e.g. wss://api.swiftagent.dev/v1/stream). Not a secret."
  type        = string
}
