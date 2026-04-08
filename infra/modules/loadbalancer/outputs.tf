output "alb_dns_name" {
  description = "DNS name of the Application Load Balancer"
  value       = aws_lb.this.dns_name
}

output "alb_arn" {
  description = "ARN of the Application Load Balancer"
  value       = aws_lb.this.arn
}

output "alb_zone_id" {
  description = "Route 53 zone ID of the Application Load Balancer"
  value       = aws_lb.this.zone_id
}

output "target_group_arn" {
  description = "ARN of the target group"
  value       = aws_lb_target_group.this.arn
}

output "listener_arn" {
  description = "ARN of the primary listener (HTTPS when TLS enabled, HTTP otherwise)"
  value       = local.tls_enabled ? aws_lb_listener.https[0].arn : aws_lb_listener.http_forward[0].arn
}

output "alb_arn_suffix" {
  description = "ARN suffix of the ALB (for autoscaling resource labels)"
  value       = aws_lb.this.arn_suffix
}

output "target_group_arn_suffix" {
  description = "ARN suffix of the target group (for autoscaling resource labels)"
  value       = aws_lb_target_group.this.arn_suffix
}
