variable "environment" {
  description = "Deployment environment (e.g. dev, staging, prod)"
  type        = string
}

variable "public_subnet_ids" {
  description = "List of public subnet IDs for the ALB"
  type        = list(string)
}

variable "security_group_id" {
  description = "Security group ID to attach to the ALB"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID for the target group"
  type        = string
}

variable "certificate_arn" {
  description = "ACM certificate ARN for HTTPS listener (empty = HTTP-only mode)"
  type        = string
  default     = ""
}

variable "health_check_path" {
  description = "Health check path for the target group"
  type        = string
  default     = "/health"
}

variable "deregistration_delay" {
  description = <<-EOT
    Seconds the ALB keeps draining in-flight connections to a task after it is
    deregistered on deploy, so long-lived WebSockets can close gracefully.
    Should be <= the ECS container stop_timeout (default 30 for both).
  EOT
  type        = number
  default     = 30
}
