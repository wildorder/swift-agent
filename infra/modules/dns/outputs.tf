output "domain_name" {
  description = "Fully qualified domain name"
  value       = local.domain_name
}

output "certificate_arn" {
  description = "ARN of the validated ACM certificate"
  value       = aws_acm_certificate_validation.this.certificate_arn
}
