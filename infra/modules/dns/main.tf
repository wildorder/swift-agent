terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

# ------------------------------------------------------------------------------
# Hosted Zone — create or look up existing
# ------------------------------------------------------------------------------

resource "aws_route53_zone" "this" {
  count = var.create_zone ? 1 : 0
  name  = var.parent_domain

  tags = {
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

data "aws_route53_zone" "this" {
  count = var.create_zone ? 0 : 1
  name  = var.parent_domain
}

locals {
  zone_id     = var.create_zone ? aws_route53_zone.this[0].zone_id : data.aws_route53_zone.this[0].zone_id
  domain_name = "${var.domain_prefix}.${var.parent_domain}"
}

# ------------------------------------------------------------------------------
# ACM Certificate + DNS Validation
# ------------------------------------------------------------------------------

resource "aws_acm_certificate" "this" {
  domain_name       = local.domain_name
  validation_method = "DNS"

  tags = {
    Environment = var.environment
    ManagedBy   = "terraform"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "acm_validation" {
  for_each = {
    for dvo in aws_acm_certificate.this.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  }

  zone_id         = local.zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "this" {
  certificate_arn         = aws_acm_certificate.this.arn
  validation_record_fqdns = [for record in aws_route53_record.acm_validation : record.fqdn]
}

# ------------------------------------------------------------------------------
# A Record — alias to ALB
# ------------------------------------------------------------------------------

resource "aws_route53_record" "alias" {
  zone_id = local.zone_id
  name    = local.domain_name
  type    = "A"

  alias {
    name                   = var.alb_dns_name
    zone_id                = var.alb_zone_id
    evaluate_target_health = true
  }
}
