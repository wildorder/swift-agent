variable "environment" {
  description = "Deployment environment (e.g. dev, staging, prod)"
  type        = string
}

variable "parent_domain" {
  description = "Parent domain for the hosted zone (e.g. swiftagent.dev)"
  type        = string
  default     = "swiftagent.dev"
}

variable "create_zone" {
  description = "Whether to create the hosted zone (true for first env deployed, false to look up existing)"
  type        = bool
  default     = true
}

variable "domain_prefix" {
  description = "Domain prefix (e.g. dev-api, staging-api, api)"
  type        = string
}

variable "alb_dns_name" {
  description = "DNS name of the Application Load Balancer"
  type        = string
}

variable "alb_zone_id" {
  description = "Route 53 zone ID of the Application Load Balancer"
  type        = string
}
