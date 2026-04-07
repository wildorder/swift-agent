variable "environment" {
  description = "Deployment environment (e.g. dev, staging, prod)"
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "az_count" {
  description = "Number of availability zones to deploy into"
  type        = number
  default     = 2
}

variable "nat_gateway_count" {
  description = "1 for dev/staging, 2 for prod"
  type        = number
  default     = 1
}
