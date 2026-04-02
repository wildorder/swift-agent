variable "environment" {
  description = "Deployment environment (e.g. dev, staging, prod)"
  type        = string
}

variable "zone_id" {
  description = "Pre-existing Route 53 hosted zone ID"
  type        = string
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
