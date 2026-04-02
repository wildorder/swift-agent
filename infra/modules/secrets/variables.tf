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
