resource "aws_elasticache_subnet_group" "this" {
  name       = "${var.environment}-swiftagent-redis"
  subnet_ids = var.private_subnet_ids

  tags = {
    Environment = var.environment
  }
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id = "${var.environment}-swiftagent-redis"
  description          = "Redis cluster for SwiftAgent ${var.environment}"

  node_type          = var.node_type
  num_cache_clusters = var.num_cache_nodes
  engine             = "redis"
  engine_version     = "7.0"
  port               = 6379

  subnet_group_name  = aws_elasticache_subnet_group.this.name
  security_group_ids = [var.security_group_id]

  automatic_failover_enabled = var.num_cache_nodes > 1
  transit_encryption_enabled = true
  at_rest_encryption_enabled = true

  tags = {
    Environment = var.environment
  }
}
