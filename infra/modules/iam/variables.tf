variable "environment" {
  description = "Deployment environment (dev, staging, prod)"
  type        = string
}

variable "ssm_parameter_arns" {
  description = "ARNs of SSM parameters the ECS task needs to read"
  type        = list(string)
}

variable "ecr_repository_arn" {
  description = "ARN of the ECR repository for container images"
  type        = string
}

variable "github_org" {
  description = "GitHub organization name"
  type        = string
  default     = "swiftagent"
}

variable "github_repo" {
  description = "GitHub repository name"
  type        = string
  default     = "swift-agent"
}

variable "state_bucket_arn" {
  description = "ARN of the S3 Terraform state bucket"
  type        = string
}

variable "lock_table_arn" {
  description = "ARN of the DynamoDB lock table"
  type        = string
}
