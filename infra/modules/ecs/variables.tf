variable "environment" {
  description = "Deployment environment (e.g. dev, staging, prod)"
  type        = string
}

variable "cluster_name" {
  description = "Name of the ECS cluster"
  type        = string
}

variable "image_uri" {
  description = "ECR image URI including tag"
  type        = string
}

variable "cpu" {
  description = "CPU units for the task definition"
  type        = number
  default     = 256
}

variable "memory" {
  description = "Memory (MiB) for the task definition"
  type        = number
  default     = 512
}

variable "desired_count" {
  description = "Desired number of running tasks"
  type        = number
  default     = 1
}

variable "private_subnet_ids" {
  description = "List of private subnet IDs for the ECS service"
  type        = list(string)
}

variable "security_group_id" {
  description = "Security group ID attached to the ECS service"
  type        = string
}

variable "target_group_arn" {
  description = "ALB target group ARN for the ECS service"
  type        = string
}

variable "task_execution_role_arn" {
  description = "IAM role ARN for ECS task execution (pulling images, logging)"
  type        = string
}

variable "task_role_arn" {
  description = "IAM role ARN assumed by the running task"
  type        = string
}

variable "ssm_parameter_arns" {
  description = "Map of environment variable name to SSM parameter ARN"
  type        = map(string)
}

variable "log_group_name" {
  description = "CloudWatch log group name for container logs"
  type        = string
}

variable "enable_autoscaling" {
  description = "Whether to enable ECS service autoscaling"
  type        = bool
  default     = false
}

variable "autoscaling_min" {
  description = "Minimum number of tasks when autoscaling is enabled"
  type        = number
  default     = 1
}

variable "autoscaling_max" {
  description = "Maximum number of tasks when autoscaling is enabled"
  type        = number
  default     = 10
}

variable "autoscaling_cpu_target" {
  description = "Target CPU utilization percentage for autoscaling"
  type        = number
  default     = 70
}

variable "alb_arn_suffix" {
  description = "ARN suffix of the ALB (required when enable_autoscaling is true)"
  type        = string
  default     = ""
}

variable "target_group_arn_suffix" {
  description = "ARN suffix of the target group (required when enable_autoscaling is true)"
  type        = string
  default     = ""
}
