output "domain_name" {
  description = "Fully qualified domain name"
  value       = local.domain_name
}

output "certificate_arn" {
  description = "ARN of the validated ACM certificate"
  value       = aws_acm_certificate_validation.this.certificate_arn
}

output "zone_id" {
  description = "Route 53 hosted zone ID"
  value       = local.zone_id
}

output "name_servers" {
  description = "Name servers for the hosted zone (configure at your domain registrar)"
  value       = var.create_zone ? aws_route53_zone.this[0].name_servers : []
}
