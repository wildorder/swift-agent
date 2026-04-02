output "primary_endpoint" {
  description = "Primary endpoint address of the Redis replication group"
  value       = aws_elasticache_replication_group.this.primary_endpoint_address
}

output "port" {
  description = "Port the Redis cluster listens on"
  value       = aws_elasticache_replication_group.this.port
}

output "connection_string" {
  description = "TLS connection string for the Redis cluster"
  value       = "rediss://${aws_elasticache_replication_group.this.primary_endpoint_address}:${aws_elasticache_replication_group.this.port}"
}
