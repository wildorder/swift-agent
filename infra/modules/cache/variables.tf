variable "environment" {
  description = "Deployment environment (e.g. dev, staging, prod)"
  type        = string
}

variable "node_type" {
  description = "ElastiCache node instance type (e.g. cache.t3.micro)"
  type        = string
}

variable "num_cache_nodes" {
  description = "Number of cache nodes in the replication group"
  type        = number
  default     = 1
}

variable "private_subnet_ids" {
  description = "List of private subnet IDs for the cache subnet group"
  type        = list(string)
}

variable "security_group_id" {
  description = "Security group ID to associate with the cache cluster"
  type        = string
}
