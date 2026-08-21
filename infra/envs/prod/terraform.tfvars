environment             = "prod"
aws_region              = "us-west-2"
state_bucket_arn        = "arn:aws:s3:::swiftagent-tf-state-548722509196"
lock_table_arn          = "arn:aws:dynamodb:us-west-2:548722509196:table/swiftagent-terraform-locks"
# Deliberately dev-grade sizing while the product is pre-traffic (decision
# 2026-08-21): scale up by editing these values when real load arrives.
# desired_count MUST stay 1 — realtime state is process-local
# (docs/runbooks/realtime-operations.md §6).
db_instance_class       = "db.t4g.micro"
cache_node_type         = "cache.t4g.micro"
num_cache_nodes         = 1
cpu                     = 256
memory                  = 512
desired_count           = 1
nat_gateway_count       = 1
multi_az                = false
backup_retention_period = 30
enable_autoscaling      = false
autoscaling_min         = 2
autoscaling_max         = 10
domain_prefix           = "api"
